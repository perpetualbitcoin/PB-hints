// incremental-scan.js — Update hints using only what changed since the last run.
// Reads hints-cache.json (persistent state in the repo), fetches new PBts and
// any PBts touched by events since lastBlock, merges, and writes new output.
//
// Falls back to full-rescan if cache is absent or corrupt.
//
// Usage:
//   node scripts/incremental-scan.js

'use strict';

const { ethers } = require('ethers');
const {
    VAULT_ADDRESS, VAULT_DEPLOY_BLOCK, VAULT_ABI,
    makeProvider, batchFetch,
    loadCache, writeOutput, writeCache, buildRows,
} = require('./shared');

// Events that mean a PBt's state has changed and must be re-fetched
const CHANGE_EVENTS = [
    'UnlockTriggered',
    'UnlockNetted',
    'PBtBurned',
    'VLockExecuted',
    'RecoveryActivated',
    'InheritanceActivated',
];

// Max blocks to query in one eth_getLogs call (avoid RPC limits)
const LOG_CHUNK = 10_000;

async function getChangedIds(vault, fromBlock, toBlock) {
    const iface = vault.interface;
    const topics = CHANGE_EVENTS.map((name) => iface.getEventTopic(name));
    const changed = new Set();

    // Chunk the block range to avoid RPC limits
    for (let start = fromBlock; start <= toBlock; start += LOG_CHUNK) {
        const end = Math.min(start + LOG_CHUNK - 1, toBlock);
        try {
            const logs = await vault.provider.getLogs({
                address: VAULT_ADDRESS,
                topics: [topics],   // OR filter: any of these topics
                fromBlock: start,
                toBlock: end,
            });
            for (const log of logs) {
                try {
                    const parsed = iface.parseLog(log);
                    const id = parsed.args.pbtId;
                    if (id !== undefined) changed.add(id.toNumber());
                } catch (_) { /* unrelated log */ }
            }
        } catch (e) {
            console.warn(`[incremental] getLogs ${start}-${end} failed: ${e.message} — will re-fetch via full-rescan fallback`);
        }
    }

    return changed;
}

async function main() {
    console.log('[incremental] Starting incremental scan...');

    const provider = await makeProvider();
    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

    const currentBlock = await provider.getBlockNumber();
    const rawCounter = await vault.pbtIdCounter();
    const currentLastPbtId = rawCounter.toNumber() - 1;

    // Load cached state
    const cache = loadCache();
    const fromBlock = cache.lastBlock > 0
        ? cache.lastBlock + 1
        : VAULT_DEPLOY_BLOCK;

    console.log(`[incremental] lastBlock=${cache.lastBlock} lastPbtId=${cache.lastPbtId} currentBlock=${currentBlock} currentLastPbtId=${currentLastPbtId}`);

    // 1. New PBts since last run
    const newIds = [];
    for (let id = cache.lastPbtId + 1; id <= currentLastPbtId; id++) {
        newIds.push(id);
    }
    console.log(`[incremental] New PBts to fetch: ${newIds.length}`);

    // 2. PBts touched by events since lastBlock
    let changedIds = new Set();
    if (fromBlock <= currentBlock) {
        console.log(`[incremental] Scanning events blocks ${fromBlock}..${currentBlock}`);
        changedIds = await getChangedIds(vault, fromBlock, currentBlock);
        // Remove newly-added ids (already in newIds)
        for (const id of newIds) changedIds.delete(id);
        console.log(`[incremental] Changed PBts from events: ${changedIds.size}`);
    }

    // 3. Fetch all that need updating
    const toFetch = [...newIds, ...changedIds];
    console.log(`[incremental] Total to fetch: ${toFetch.length}`);

    const fetched = await batchFetch(vault, toFetch, 50);

    // 4. Merge into cache
    const pbts = { ...cache.pbts };

    for (const [id, reg] of Object.entries(fetched)) {
        // Burned or fully settled → remove from hints
        if (reg.holder === ethers.constants.AddressZero || reg.pbcLocked.isZero()) {
            delete pbts[id];
            continue;
        }
        pbts[id] = {
            nextTriggerPrice: reg.nextTriggerPrice.toString(),
            pbcLocked: reg.pbcLocked.toString(),
            payoutAddress: reg.payoutAddress.toLowerCase(),
        };
    }

    console.log(`[incremental] Cache now has ${Object.keys(pbts).length} active PBts`);

    // 5. Write output
    const rows = buildRows(pbts);
    writeOutput(rows, currentBlock, 'incremental');

    // 6. Save updated cache
    const newCache = {
        lastBlock: currentBlock,
        lastPbtId: currentLastPbtId,
        updatedAt: new Date().toISOString(),
        pbts,
    };
    writeCache(newCache);

    console.log('[incremental] Done.');
}

main().catch((err) => {
    console.error('[incremental] Fatal error:', err);
    process.exit(1);
});
