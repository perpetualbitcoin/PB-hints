// full-rescan.js — Rebuild hints from scratch by reading every PBt from PulseChain.
// No database required. Reads pbtRegistry() for every id 1..pbtIdCounter-1.
// Also used as the weekly drift-check and manual recovery tool.
//
// Usage:
//   node scripts/full-rescan.js
//   RPC_URL=https://rpc.pulsechain.com node scripts/full-rescan.js

'use strict';

const { ethers } = require('ethers');
const {
    VAULT_ADDRESS, VAULT_ABI,
    makeProvider, batchFetch,
    writeOutput, writeCache, buildRows,
} = require('./shared');

async function main() {
    console.log('[full-rescan] Starting full PBt scan from PulseChain...');

    const provider = await makeProvider();
    const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, provider);

    const currentBlock = await provider.getBlockNumber();
    const rawCounter = await vault.pbtIdCounter();
    const pbtIdCounter = rawCounter.toNumber();
    const totalIds = pbtIdCounter - 1;

    console.log(`[full-rescan] pbtIdCounter=${pbtIdCounter} → scanning ids 1..${totalIds} at block ${currentBlock}`);

    if (totalIds <= 0) {
        console.log('[full-rescan] No PBts found. Exiting.');
        process.exit(0);
    }

    const ids = Array.from({ length: totalIds }, (_, i) => i + 1);
    const pbts = {};
    let active = 0;
    let settled = 0;

    // Process in batches of 50 parallel calls
    const BATCH = 50;
    for (let start = 0; start < ids.length; start += BATCH) {
        const chunk = ids.slice(start, start + BATCH);
        const fetched = await batchFetch(vault, chunk, BATCH);

        for (const [id, reg] of Object.entries(fetched)) {
            // Skip burned/empty slots
            if (reg.holder === ethers.constants.AddressZero) {
                settled++;
                continue;
            }
            // Skip fully settled positions
            if (reg.pbcLocked.isZero()) {
                settled++;
                continue;
            }

            pbts[id] = {
                nextTriggerPrice: reg.nextTriggerPrice.toString(),
                pbcLocked: reg.pbcLocked.toString(),
                payoutAddress: reg.payoutAddress.toLowerCase(),
            };
            active++;
        }

        const done = Math.min(start + BATCH, ids.length);
        if (done % 500 === 0 || done === ids.length) {
            console.log(`[full-rescan] ${done}/${ids.length} scanned · active=${active} settled=${settled}`);
        }
    }

    console.log(`[full-rescan] Complete: ${active} active, ${settled} settled/burned`);

    // Build sorted rows and write output
    const rows = buildRows(pbts);
    writeOutput(rows, currentBlock, 'full-rescan');

    // Update cache
    const cache = {
        lastBlock: currentBlock,
        lastPbtId: totalIds,
        updatedAt: new Date().toISOString(),
        pbts,
    };
    writeCache(cache);

    console.log('[full-rescan] Done.');
}

main().catch((err) => {
    console.error('[full-rescan] Fatal error:', err);
    process.exit(1);
});
