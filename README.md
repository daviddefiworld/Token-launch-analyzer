# Aerodrome Launch Intel

TypeScript MERN dashboard for inspecting Aerodrome launches on Base:

- Full classic-pool launch list from the official Aerodrome `PoolFactory`
- Creator wallet history, first funding source, and previous launches
- First 100 pool buyers and sellers from BaseScan `Swap` logs, each valued in real USD
- Headline metrics for 24h volume of pools launched in the last 7 days and the last 24 hours

## Run

```bash
npm install
copy .env.example .env
npm run dev
```

Open `http://localhost:5173`. Without `BASE_RPC_URL`, the dashboard uses demo data.

The frontend calls the backend directly through `VITE_API_URL`. Vite does not proxy API requests.

## Live data

Set `BASE_RPC_URL` for on-chain pool and trade analysis. Set `BASESCAN_API_KEY` (an Etherscan v2 key — covers Base via `chainid 8453`) to power exact token creation times, USD liquidity/volume, per-trade USD values, and creator funding. The Etherscan client self-throttles to stay under the free-tier limits (5 req/sec, 100k req/day).

Set `MONGODB_URI` when using live mode. The API serves launches from MongoDB while a background indexer scans Base in chunks. Each successful chunk:

1. Upserts newly discovered launches by pool address.
2. Saves the last indexed block number.
3. Continues from the next block.

If the process stops after launch upserts but before saving the checkpoint, the same chunk is replayed safely on restart. This keeps the workflow resumable without requiring MongoDB transactions.

`BASE_START_BLOCK` defines the earliest cached launch block. On startup, older cached launches are removed and an older checkpoint is fast-forwarded to this boundary. `BASE_LOG_CHUNK` defaults to `2000` for reliable `eth_getLogs` queries. After the initial sync, only new blocks are scanned.

The current scope covers Aerodrome classic stable and volatile pools emitted by the official `PoolFactory`. Slipstream concentrated-liquidity pools are a separate factory and can be added as a second adapter.

## Server structure

- `server/index.ts`: Express routes and application startup.
- `server/AerodromeAnalyzer.ts`: Base RPC interpretation and dashboard analysis queries.
- `server/LaunchIndexer.ts`: Resumable background indexing workflow.
- `server/LaunchRepository.ts`: MongoDB launch cache and indexed-block checkpoint.

MongoDB stores launches in the `launches` collection and the durable checkpoint in the `indexstates` collection.

Liquidity and 24-hour volume are computed in USD from on-chain data via the Etherscan v2 API and cached in MongoDB. Liquidity is the pool's quote-token reserve valued at 2×; volume sums each swap's quote leg over the last 24h. The quote token is priced as `$1` for USDC/USDT, the live ETH price for WETH, and a most-liquid DexScreener pair price for anything else (e.g. AERO). Pools whose quote is none of these fall back to DexScreener pair aggregates. Each trade in the order-flow view carries its own USD value using the same pricing.

Every factory pool is indexed regardless of token age — the token's creation time is resolved exactly from Etherscan and stored, so age is a UI-side filter ("token age at LP") rather than an indexing gate.

The launch list supports cursor-based infinite scrolling, search, pool-type filters, minimum liquidity and volume thresholds, token-age filtering, and server-side sorting. The selected pool shows BaseScan links for both the pool and the token contract.

Headline metrics include the summed 24-hour volume of pools launched within the last 7 days and within the last 24 hours. The token-age filter compares token creation time against LP addition time, not the current date.

Open the `RPC usage` sidebar page to inspect Base JSON-RPC request counts by method for the current API process. The analyzer caches token metadata, pool metadata, and block timestamps to reduce repeat RPC calls.
