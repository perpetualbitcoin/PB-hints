// shared.js — constants and helpers shared by full-rescan and incremental-scan

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── Contract addresses (mainnet) ──
const VAULT_ADDRESS = '0x0E04D1CaC6212447447ad66A5e57a8910425975F';
const VAULT_DEPLOY_BLOCK = 26240864;

// ── Vault ABI (minimal — only what we need) ──
const VAULT_ABI = [
    'function pbtIdCounter() view returns (uint256)',
    'function pbtRegistry(uint256 id) view returns (uint256 buyPrice, uint256 pbAmount, uint256 pbcLocked, uint256 nextUnlockIndex, uint256 nextTriggerPrice, uint256 mintBlock, address holder, address payoutAddress)',
    'event UnlockTriggered(uint256 indexed pbtId, uint256 unlockIndex, uint256 pbUnlocked, uint256 usdlProceeds, address payoutAddress, uint256 newTriggerPrice, uint256 remainingPBcLocked)',
    'event UnlockNetted(uint256 indexed pbtId, uint256 unlockIndex, uint256 pbcSettled, uint256 usdlPaid, address payoutAddress, uint256 settlementPrice, uint256 newTriggerPrice, uint256 remainingPBcLocked)',
    'event PBtBurned(uint256 indexed pbtId, uint256 remainingDust)',
    'event BuyWithNetting(address indexed buyer, address indexed recipient, uint256 indexed pbtId, uint256 usdlIn, uint256 totalPBOut, uint256 nettedPB, uint256 ammPB, uint256 lpPB, uint256 lpUSDL, uint256 unlocksNetted)',
    'event VLockExecuted(address indexed user, uint256 indexed pbtId, uint256 pbAmount, uint256 usdlBonusPaid, uint256 pbBonusPaid)',
    'event RecoveryActivated(uint256 indexed pbtId, address indexed recoveryAddress)',
    'event InheritanceActivated(uint256 indexed pbtId, address indexed inheritanceAddress)',
];

// ── Paths ──
const ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(ROOT, 'hints-cache.json');
const LATEST_META_FILE = path.join(ROOT, 'hints-latest.json');
const LATEST_GZ_FILE = path.join(ROOT, 'hints-latest.json.gz');

// ── RPC setup with fallback ──
// NOTE: `new JsonRpcProvider(url)` never throws synchronously even for a dead
// endpoint, so we must actually probe each URL (getBlockNumber) before trusting
// it. First reachable endpoint wins; otherwise we throw with the last error.
// Public PulseChain endpoints below were verified live; the official
// rpc.pulsechain.com is kept last as it goes down periodically.
const PUBLIC_RPCS = [
    'https://rpc-pulsechain.g4mm4.io',
    'https://pulsechain-rpc.publicnode.com',
    'https://rpc.pulsechainstats.com',
    'https://rpc.pulsechainrpc.com',
    'https://rpc.degenprotocol.io',
    'https://rpc.gigatheminter.com',
    'https://rpc.pulsechain.com',
];

async function makeProvider() {
    const urls = [
        process.env.RPC_URL,
        process.env.RPC_URL_2,
        ...PUBLIC_RPCS,
    ].filter(Boolean);

    let lastErr;
    for (const url of urls) {
        try {
            const provider = new ethers.providers.JsonRpcProvider(url, 369);
            // Probe: confirm the endpoint actually responds before using it.
            await provider.getBlockNumber();
            console.log(`[rpc] using ${url}`);
            return provider;
        } catch (e) {
            lastErr = e;
            console.warn(`[rpc] ${url} unreachable: ${e.message}`);
        }
    }
    throw new Error(`No working RPC endpoint. Last error: ${lastErr && lastErr.message}`);
}

// ── Batch fetch with concurrency ──
async function batchFetch(vault, ids, batchSize = 50) {
    const results = {};
    const chunks = [];
    for (let i = 0; i < ids.length; i += batchSize) {
        chunks.push(ids.slice(i, i + batchSize));
    }
    for (const chunk of chunks) {
        const fetched = await Promise.all(
            chunk.map(async (id) => {
                try {
                    const reg = await vault.pbtRegistry(id);
                    return { id, reg };
                } catch (e) {
                    console.warn(`[warn] pbtRegistry(${id}) failed: ${e.message}`);
                    return null;
                }
            })
        );
        for (const item of fetched) {
            if (item) results[item.id] = item.reg;
        }
    }
    return results;
}

// ── Load cache (returns empty structure if not found) ──
function loadCache() {
    if (!fs.existsSync(CACHE_FILE)) {
        return { lastBlock: 0, lastPbtId: 0, updatedAt: null, pbts: {} };
    }
    try {
        return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    } catch (e) {
        console.warn('[warn] Cache file corrupt, starting fresh:', e.message);
        return { lastBlock: 0, lastPbtId: 0, updatedAt: null, pbts: {} };
    }
}

// ── Write output files ──
function writeOutput(rows, blockNumber, source) {
    const generatedAt = new Date().toISOString();

    // hints-latest.json (metadata)
    const meta = {
        version: 1,
        generatedAt,
        blockNumber,
        rowCount: rows.length,
        source,
        dataUrl: 'https://raw.githubusercontent.com/perpetualbitcoin/PB-hints/main/hints-latest.json.gz',
        mirrorUrl: 'https://cdn.jsdelivr.net/gh/perpetualbitcoin/PB-hints@main/hints-latest.json.gz',
    };
    fs.writeFileSync(LATEST_META_FILE, JSON.stringify(meta, null, 2));

    // hints-latest.json.gz (full data)
    const payload = JSON.stringify({ generatedAt, blockNumber, rows });
    const gz = zlib.gzipSync(Buffer.from(payload, 'utf8'));
    fs.writeFileSync(LATEST_GZ_FILE, gz);

    console.log(`[output] wrote ${rows.length} rows · block ${blockNumber} · ${generatedAt}`);
}

// ── Write cache ──
function writeCache(cache) {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// ── Build sorted row array from cache.pbts ──
function buildRows(pbts) {
    return Object.entries(pbts)
        .map(([id, d]) => ({
            pbtId: Number(id),
            nextTriggerPrice: d.nextTriggerPrice,
            pbcLocked: d.pbcLocked,
            payoutAddress: d.payoutAddress,
        }))
        .sort((a, b) => {
            const diff = BigInt(a.nextTriggerPrice) - BigInt(b.nextTriggerPrice);
            return diff < 0n ? -1 : diff > 0n ? 1 : 0;
        });
}

module.exports = {
    VAULT_ADDRESS,
    VAULT_DEPLOY_BLOCK,
    VAULT_ABI,
    CACHE_FILE,
    ROOT,
    makeProvider,
    batchFetch,
    loadCache,
    writeOutput,
    writeCache,
    buildRows,
};
