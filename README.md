# Launch Intel

TypeScript MERN dashboard for inspecting token launches across multiple DEXes on Base:

- **Aerodrome** classic stable/volatile pools (official `PoolFactory`)
- **Uniswap V2** pairs (official Uniswap Labs V2 factory)
- **Uniswap V3** concentrated-liquidity pools (fee tiers), by the canonical V3 factory

A DEX switcher in the UI selects which one to view; every API request is scoped by a
`?dex=` parameter and each DEX indexes into its own cached dataset.

For the selected DEX you get:

- Full launch list from that DEX's factory
- Creator wallet history, first funding source, and previous launches
- First 100 pool buyers and sellers from BaseScan `Swap` logs, each valued in real USD
- **Attendee intelligence**: every buyer classified against the creator's funding graph, with **real (external) volume** that excludes the creator's self-buys and sybil cluster
- Headline metrics for 24h volume of pools launched in the last 7 days and the last 24 hours

## Run

```bash
npm install
copy .env.example .env
npm run dev
```

Open `http://localhost:5173`. Without `BASE_RPC_URL`, the dashboard uses demo data (and the
DEX switcher shows separate demo launches per DEX).

The frontend calls the backend directly through `VITE_API_URL`. Vite does not proxy API requests.

## Live data

Set `BASE_RPC_URL` for on-chain pool and trade analysis. Set `BASESCAN_API_KEY` (an Etherscan v2 key — covers Base via `chainid 8453`) to power exact token creation times, USD liquidity/volume, per-trade USD values, and creator funding. The Etherscan client self-throttles to stay under the free-tier limits (5 req/sec, 100k req/day) and is shared across all DEXes so the budget is respected globally.

Set `MONGODB_URI` when using live mode. The API serves launches from MongoDB while a background indexer per DEX scans Base in chunks. Each successful chunk:

1. Upserts newly discovered launches by pool address.
2. Saves the last indexed block number for that DEX.
3. Continues from the next block.

If the process stops after launch upserts but before saving the checkpoint, the same chunk is replayed safely on restart. This keeps the workflow resumable without requiring MongoDB transactions.

`BASE_START_BLOCK` defines the earliest cached launch block. On startup, older cached launches are removed and an older checkpoint is fast-forwarded to this boundary. `BASE_LOG_CHUNK` defaults to `2000` for reliable `eth_getLogs` queries. After the initial sync, only new blocks are scanned.

### Monitoring window & Etherscan budget

The recurring Etherscan cost comes from the background **market-data** and **attendee-intel** refresh loops. To stay under the free tier (5 req/s, 100k/day), those loops only monitor launches whose LP was created within `MONITOR_WINDOW_HOURS` (default `24`) — fresh launches, where volume and buyer activity actually matter. Older launches keep their last-computed values and are no longer re-queried. Pool discovery (indexing) is forward-only and unaffected, and on-demand attendee analysis of a launch you open is never restricted.

Each DEX has an independent indexer with a **Start/Stop** toggle in the sidebar (`POST /api/dex/:dex/start|stop`, state from `GET /api/indexers`). Stop the DEXes you don't care about to focus the shared Etherscan/RPC budget on one — e.g. run only Uniswap V3.

## DEX adapters (`server/skills`)

All DEX-specific logic lives behind a `DexAdapter` (`server/skills/DexAdapter.ts`): the factory address, the pool-creation and swap event ABIs, how reserves are read, the pool-type taxonomy, and any DEX-specific quote tokens. One adapter folder per DEX:

- `server/skills/aerodrome/` — V2-style `PoolCreated(stable)` + `getReserves()`, stable/volatile.
- `server/skills/uniswap-v2/` — V2-style `PairCreated` + `getReserves()`; `Swap` indexes `to` last (a distinct topic0 from Aerodrome).
- `server/skills/uniswap-v3/` — `PoolCreated(fee, tickSpacing)`, signed `int256` swap amounts, and `balanceOf(pool)` reserves (no `getReserves()`); pool type is the fee tier.

`server/skills/registry.ts` lists the adapters and defines the default. Shared V2-style math (swap decode + reserve read) is in `server/skills/v2Pool.ts`. To add a DEX, write a new adapter and register it — the analyzer, indexer, repository, and UI are otherwise DEX-agnostic.

## Attendee intelligence & real volume

The headline volume of a fresh launch is easy to fake: the creator funds a swarm of bot
wallets from one private wallet and has them wash-trade the new token. This system separates
that insider activity from genuine demand.

For each launch the indexer classifies every trader (the swap recipient EOA) against the
creator's **funding graph**:

- **creator** — the buyer is the creator itself (a self-buy)
- **creator-funded** — first funded directly by the creator wallet
- **same-funder** — shares the creator's first funding wallet (a private funder)
- **linked** — connected to the creator's cluster through a multi-hop funding chain
- **external** — independent funding (real, external demand)

A wallet's first funder is found from its first incoming transfer (Etherscan) and **cached
forever** in the `walletfundings` collection — a wallet's first funder never changes, and
because launch bots are reused across many launches, each wallet is investigated at most
once and then served from cache everywhere. This is what makes classifying *every* launch
tractable.

**Real (external) volume** = total 24h volume − the volume traded by the creator's insider
cluster. It is computed over the same swap window as `volumeUsd`, stored on each launch
(`externalVolumeUsd`, `insiderVolumeUsd`, `insiderRatio`, buyer counts), shown in the launch
list, and sortable. The per-buyer breakdown plus detected clusters (the creator's insider
group, and "sniper rings" of external buyers sharing a private funder with each other) are
stored per launch and shown in the **Attendee intelligence** panel. Open a launch to view it;
in live mode you can trigger or refresh analysis on demand.

### Avoiding false positives

A shared funder is only a sybil signal if it is *private*. Wallets funded by the same
exchange (e.g. everyone withdrawing from Coinbase) must not be linked. Funders that have
seeded many distinct cached wallets (`PUBLIC_FUNDER_THRESHOLD`, default 75) are treated as
public dispersers (CEX/bridge/router) and never create a sybil edge; a small seed denylist
covers obvious cases before the cache warms. The creator wallet itself is never treated as
public, so direct creator-funded bots are always caught. These thresholds are tunable in
`server/WalletIntelService.ts`; the buyer's actual funder is always shown so you can judge.

Caveat: the trader identity is the swap *recipient*, which is the end-user EOA for ordinary
router swaps but can be an aggregator/router for multi-hop trades.

## Server structure

- `server/index.ts`: Express routes, `?dex=` routing, and per-DEX analyzer/indexer startup.
- `server/LaunchAnalyzer.ts`: DEX-agnostic Base RPC interpretation and dashboard analysis queries, driven by an injected adapter.
- `server/LaunchIndexer.ts`: Resumable background indexing workflow (one per DEX), including the attendee-intelligence backfill.
- `server/LaunchRepository.ts`: MongoDB launch cache and indexed-block checkpoint, scoped by `dex`.
- `server/MarketDataService.ts`: USD liquidity and 24h volume, plus `analyzeAttendees` (real volume + per-buyer report), decoding swaps/reserves via the adapter.
- `server/WalletIntelService.ts`: cached funding lookups and the funding-cluster classifier (union-find, multi-hop, public-funder exclusion).

MongoDB stores launches in the `launches` collection (each carries a `dex` field) and the durable per-DEX checkpoints in the `indexstates` collection. Token creation times are chain-global and cached once in `tokencreations`; wallet funding sources are likewise chain-global and cached in `walletfundings`; per-launch attendee reports live in `attendeereports`.

Liquidity and 24-hour volume are computed in USD from on-chain data via the Etherscan v2 API and cached in MongoDB. Liquidity is the pool's quote-token reserve valued at 2×; volume sums each swap's quote leg over the last 24h. The quote token is priced as `$1` for USDC/USDT, the live ETH price for WETH, and a most-liquid DexScreener pair price for anything else (e.g. AERO). Pools whose quote is none of these fall back to DexScreener pair aggregates. Each trade in the order-flow view carries its own USD value using the same pricing.

> Note: the 2× quote-reserve TVL estimate is exact for constant-product V2 pools but only a rough upper bound for Uniswap V3, where concentrated liquidity means the pool balance spans out-of-range positions.

Every factory pool is indexed regardless of token age — the token's creation time is resolved exactly from Etherscan and stored, so age is a UI-side filter ("token age at LP") rather than an indexing gate.

The launch list supports cursor-based infinite scrolling, search, pool-type filters (per DEX), minimum liquidity and volume thresholds, token-age filtering, and server-side sorting. The selected pool shows BaseScan links for both the pool and the token contract.

Headline metrics include the summed 24-hour volume of pools launched within the last 7 days and within the last 24 hours. The token-age filter compares token creation time against LP addition time, not the current date.

Open the `RPC usage` sidebar page to inspect Base JSON-RPC request counts by method for the current API process. The analyzer caches token metadata, pool metadata, and block timestamps to reduce repeat RPC calls.
