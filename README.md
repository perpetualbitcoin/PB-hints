# PB-hints

Auto-updated hint snapshots for the **Perpetual Bitcoin** netting contract.

Rebuilt directly from PulseChain, no server, no database required.

## What's in this repo

| File | Description |
|---|---|
| `hints-latest.json` | Metadata: timestamp, block number, row count, CDN URLs |
| `hints-latest.json.gz` | Full sorted hint list (gzipped JSON) |
| `hints-cache.json` | Internal state used by the incremental scanner |
| `scripts/full-rescan.js` | Reads every PBt from chain, rebuilds everything |
| `scripts/incremental-scan.js` | Only fetches what changed since last run |
| `scripts/shared.js` | Shared helpers, ABI, RPC setup |

## How it works

Every 30 minutes, GitHub Actions runs `incremental-scan.js`:
1. Loads `hints-cache.json` (previous state)
2. Finds new PBts and any PBts touched by vault events since the last block
3. Re-fetches only those ,  O(changed), not O(total)
4. Writes updated `hints-latest.json.gz` + `hints-cache.json`

Every Sunday 03:00 UTC, `full-rescan.js` runs as a drift check:
- Fetches every PBt from chain from scratch
- Self-heals any incremental drift

## Consuming the hints

```
Primary:  https://raw.githubusercontent.com/perpetualbitcoin/PB-hints/main/hints-latest.json.gz
Mirror:   https://cdn.jsdelivr.net/gh/perpetualbitcoin/PB-hints@main/hints-latest.json.gz
```

Decompress (gzip), parse as JSON. `rows` is already sorted by
`nextTriggerPrice` ascending ,  pass directly to the vault as the netting
hint list.

## Community takeover

If this repo goes unmaintained:

1. Fork the repo.
2. Go to **Settings → Secrets → Actions** and add:
   - `HINTS_PUSH_TOKEN` ,  a fine-grained GitHub PAT with write access to your fork.
   - `PULSECHAIN_RPC` ,  any PulseChain RPC endpoint (e.g. `https://rpc.pulsechain.com`).
   - `PULSECHAIN_RPC_2` ,  fallback RPC (optional, e.g. `https://pulsechain.publicnode.com`).
3. Go to **Actions** and re-enable workflows.
4. Manually trigger **Full Rescan** once to seed the cache.
5. Update the `dataUrl` and `mirrorUrl` in `scripts/shared.js` to point to your fork.

The dapp's fallback chain will pick up your fork's URL if the config is updated.

## Running locally

```bash
npm install

# Full rescan (manual recovery)
RPC_URL=https://rpc.pulsechain.com node scripts/full-rescan.js

# Incremental (normal 30-min update)
RPC_URL=https://rpc.pulsechain.com node scripts/incremental-scan.js
```

## Contracts

- **Vault**: `0x0E04D1CaC6212447447ad66A5e57a8910425975F` (PulseChain mainnet, chainId 369)
- **Deployed block**: 26240864
