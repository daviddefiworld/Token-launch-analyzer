import { Contract, formatUnits } from "ethers";
import type { AttendeeBuyer, AttendeeReport, Launch } from "../types.js";
import type { EtherscanLog, EtherscanService } from "./EtherscanService.js";
import type { LaunchRepository } from "./LaunchRepository.js";
import type { PriceService } from "./PriceService.js";
import type { RpcMetricsProvider } from "./RpcMetricsProvider.js";
import { resolveTxTraders } from "./txTraders.js";
import type { TraderActivity, WalletIntelService } from "./WalletIntelService.js";
import { getQuoteToken, isQuoteToken0, type DexAdapter } from "./skills/DexAdapter.js";

// Top buyers retained in the stored per-launch attendee report (by volume).
const MAX_REPORT_BUYERS = 100;

export interface AttendeeAnalysis {
  intel: Partial<Launch>;
  report: AttendeeReport;
}

interface DexScreenerPair {
  pairAddress?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

export interface MarketData {
  poolAddress: string;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  // Real/insider are always derived as total x (1 - insiderRatio) so real <= total holds
  // even though the insider ratio is measured by a separate (intel) loop.
  externalVolumeUsd?: number | null;
  insiderVolumeUsd?: number | null;
  marketDataUpdatedAt: string;
}

const DECIMALS_ABI = ["function decimals() view returns (uint8)"];
const BLOCKS_PER_DAY = 43_200;

// Computes liquidity and 24h volume in USD for one DEX's launches. Swap decoding and
// reserve reads are delegated to the injected DexAdapter, so this works for V2-style and
// V3-style pools alike. Known quote tokens are priced precisely through Etherscan +
// PriceService; everything else falls back to DexScreener's aggregated pair data.
export class MarketDataService {
  private static readonly DEX_BATCH_SIZE = 30;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  // A pool's 24h swap logs are the heaviest Etherscan call and are needed by BOTH the volume
  // path and the attendee-intel path. Cache them briefly so the second caller reuses the
  // first's fetch instead of re-paging the same window.
  private static readonly SWAP_LOG_TTL_MS = 90_000;
  private static readonly SWAP_LOG_CACHE_MAX = 400;
  private readonly decimalsCache = new Map<string, number>();
  private readonly swapLogCache = new Map<string, { fromBlock: number; toBlock: number; logs: EtherscanLog[]; at: number }>();
  private readonly swapTopic: string;

  constructor(
    private readonly adapter: DexAdapter,
    private readonly etherscan: EtherscanService | null = null,
    private readonly priceService: PriceService | null = null,
    private readonly provider: RpcMetricsProvider | null = null,
    private readonly walletIntel: WalletIntelService | null = null,
    private readonly repository: LaunchRepository | null = null
  ) {
    this.swapTopic = adapter.poolInterface.getEvent(adapter.swapEventName)!.topicHash;
  }

  async getForLaunch(launch: Launch): Promise<MarketData> {
    const [result] = await this.getForLaunches([launch]);
    return result;
  }

  async getForLaunches(launches: Launch[]): Promise<MarketData[]> {
    if (!launches.length) return [];
    const updatedAt = new Date().toISOString();

    if (!this.etherscan || !this.priceService) {
      return this.fromDexScreener(launches, updatedAt);
    }

    const latestBlock = await this.etherscan.getBlockNumber();
    const dexFallback: Launch[] = [];

    // Run launches concurrently: RPC reserve reads overlap while the Etherscan
    // volume calls queue on the shared rate limiter, so wall time ≈ the rate-limit floor.
    const settled = await Promise.all(launches.map(async (launch) => {
      // Resolve the quote's decimals: known tokens from the static map, anything else
      // straight from the chain. This lets us value real on-chain swap volume for any
      // quote PriceService can price, instead of bailing to DexScreener's h24 (which
      // reads 0 for freshly launched pairs it hasn't indexed yet).
      const decimals = launch.quoteAddress ? await this.resolveQuoteDecimals(launch.quoteAddress) : null;
      if (decimals == null) {
        dexFallback.push(launch);
        return null;
      }
      try {
        return await this.computeMarketData(launch, decimals, latestBlock, updatedAt);
      } catch (error) {
        console.warn(`Market data failed for ${launch.poolAddress}: ${error instanceof Error ? error.message : error}`);
        dexFallback.push(launch);
        return null;
      }
    }));

    const results = settled.filter((data): data is MarketData => data != null);
    if (dexFallback.length) results.push(...await this.fromDexScreener(dexFallback, updatedAt));
    return results;
  }

  private async computeMarketData(launch: Launch, quoteDecimals: number, latestBlock: number, updatedAt: string): Promise<MarketData> {
    const price = await this.priceService!.getQuotePriceUsd(launch.quoteAddress!);
    if (price == null) {
      const [fallback] = await this.fromDexScreener([launch], updatedAt);
      return fallback;
    }

    const [liquidityUsd, volumeUsd] = await Promise.all([
      this.computeLiquidity(launch, quoteDecimals, price),
      this.computeVolume(launch, quoteDecimals, price, latestBlock)
    ]);

    // Re-derive real/insider from this fresh total and the last-known insider ratio (owned
    // by the intel loop), so the two stay consistent and real never exceeds total. Until a
    // pool has actually been analyzed (insiderRatio is null), real/insider are unknown — leave
    // them null so the volume stays in the "not analyzed" bucket instead of counting as real.
    const ratio = launch.insiderRatio;
    return {
      poolAddress: launch.poolAddress,
      liquidityUsd,
      volumeUsd,
      externalVolumeUsd: ratio != null ? volumeUsd * (1 - ratio) : null,
      insiderVolumeUsd: ratio != null ? volumeUsd * ratio : null,
      marketDataUpdatedAt: updatedAt
    };
  }

  // Known quote tokens carry their decimals statically; for any other quote we read
  // decimals() over RPC (cached). Returns null when there's no provider to ask — the
  // caller then falls back to DexScreener.
  private async resolveQuoteDecimals(quoteAddress: string): Promise<number | null> {
    const key = quoteAddress.toLowerCase();
    const known = getQuoteToken(this.adapter.quotes, key);
    if (known) return known.decimals;
    const cached = this.decimalsCache.get(key);
    if (cached != null) return cached;
    if (!this.provider) return null;
    try {
      const decimals = Number(await new Contract(quoteAddress, DECIMALS_ABI, this.provider).decimals());
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
      this.decimalsCache.set(key, decimals);
      return decimals;
    } catch {
      return null;
    }
  }

  // TVL ≈ 2× the value of the quote reserve held by the pool. The adapter knows how to
  // read that reserve (getReserves() for V2-style pools, ERC20 balanceOf for V3), reading
  // from the fast RPC when available and falling back to Etherscan tokenbalance.
  private async computeLiquidity(launch: Launch, quoteDecimals: number, price: number): Promise<number> {
    const quoteIsToken0 = isQuoteToken0(launch.quoteAddress!, launch.tokenAddress);
    const quoteReserve = await this.adapter.readQuoteReserve({
      provider: this.provider,
      etherscan: this.etherscan,
      poolAddress: launch.poolAddress,
      quoteAddress: launch.quoteAddress!,
      quoteIsToken0,
      quoteDecimals
    });
    return Number(formatUnits(quoteReserve, quoteDecimals)) * price * 2;
  }

  // Fetch a pool's swap logs once and reuse across the volume and attendee-intel paths. Both
  // anchor the same ~24h window to the chain tip, so a <90s-old cache entry differs by only a
  // few blocks at the tail — negligible against a 24h span — while halving the heaviest call.
  private async getSwapLogs(poolAddress: string, fromBlock: number, toBlock: number): Promise<EtherscanLog[]> {
    const key = poolAddress.toLowerCase();
    const now = Date.now();
    const cached = this.swapLogCache.get(key);
    if (cached && now - cached.at < MarketDataService.SWAP_LOG_TTL_MS && cached.fromBlock <= fromBlock + 1) {
      return cached.logs.filter((log) => log.blockNumber >= fromBlock);
    }
    const logs = await this.etherscan!.getLogs({ address: poolAddress, topic0: this.swapTopic, fromBlock, toBlock });
    this.swapLogCache.set(key, { fromBlock, toBlock, logs, at: now });
    if (this.swapLogCache.size > MarketDataService.SWAP_LOG_CACHE_MAX) {
      const oldest = this.swapLogCache.keys().next().value;
      if (oldest !== undefined) this.swapLogCache.delete(oldest);
    }
    return logs;
  }

  // Sum of every swap's quote-token leg over the last 24h, valued in USD.
  private async computeVolume(launch: Launch, quoteDecimals: number, price: number, latestBlock: number): Promise<number> {
    const fromBlock = Math.max(latestBlock - BLOCKS_PER_DAY, launch.blockNumber);
    const logs = await this.getSwapLogs(launch.poolAddress, fromBlock, latestBlock);
    const quoteIsToken0 = isQuoteToken0(launch.quoteAddress!, launch.tokenAddress);
    let quoteTotal = 0n;
    for (const log of logs) {
      const swap = this.adapter.parseSwap({ topics: log.topics, data: log.data, quoteIsToken0 });
      if (swap) quoteTotal += swap.quoteAmountRaw;
    }
    return Number(formatUnits(quoteTotal, quoteDecimals)) * price;
  }

  // Classify a launch's traders against the creator's funding graph and split the swap
  // window's volume into external (real demand) vs insider (the creator's sybil cluster).
  // Uses the same 24h window as computeVolume, so external volume <= total volume.
  async analyzeAttendees(launch: Launch, opts: { maxNewLookups?: number } = {}): Promise<AttendeeAnalysis | null> {
    if (!this.etherscan || !this.walletIntel || !launch.quoteAddress) return null;
    const quoteDecimals = await this.resolveQuoteDecimals(launch.quoteAddress);
    if (quoteDecimals == null) return null;

    const latestBlock = await this.etherscan.getBlockNumber();
    const fromBlock = Math.max(latestBlock - BLOCKS_PER_DAY, launch.blockNumber);
    const logs = await this.getSwapLogs(launch.poolAddress, fromBlock, latestBlock);

    // Attribute each swap to the EOA that signed its transaction (the real buyer) rather
    // than the swap event's `to`, which for router/aggregator swaps is the router contract.
    // Falls back to the event recipient when the tx signer can't be resolved.
    const traderByTx = await resolveTxTraders(logs.map((log) => log.transactionHash), this.repository, this.provider);
    const quoteIsToken0 = isQuoteToken0(launch.quoteAddress, launch.tokenAddress);
    const byTrader = new Map<string, { quoteRaw: bigint; tradeCount: number; firstTradeMs: number | null }>();
    for (const log of logs) {
      const swap = this.adapter.parseSwap({ topics: log.topics, data: log.data, quoteIsToken0 });
      if (!swap) continue;
      const trader = traderByTx.get(log.transactionHash.toLowerCase()) ?? swap.trader;
      if (!trader) continue;
      const key = trader.toLowerCase();
      const entry = byTrader.get(key) ?? { quoteRaw: 0n, tradeCount: 0, firstTradeMs: null };
      entry.quoteRaw += swap.quoteAmountRaw;
      entry.tradeCount += 1;
      const ms = log.timeStamp * 1000;
      entry.firstTradeMs = entry.firstTradeMs == null ? ms : Math.min(entry.firstTradeMs, ms);
      byTrader.set(key, entry);
    }

    const traders: TraderActivity[] = [...byTrader.entries()].map(([address, value]) => ({ address, ...value }));
    // Manually-tagged rug bots fold their whole funding cluster into the insider set.
    const rugBots = this.repository ? await this.repository.getAddressesByLabel("rug-bot") : [];
    const result = await this.walletIntel.classify(launch.creator, traders, { maxNewLookups: opts.maxNewLookups, rugBots });

    const price = this.priceService ? await this.priceService.getQuotePriceUsd(launch.quoteAddress) : null;
    const toUsd = (raw: bigint): number | null => (price == null ? null : Number(formatUnits(raw, quoteDecimals)) * price);
    // The insider ratio is the robust quantity (numerator and denominator from the same
    // swap fetch — immune to time/price skew). Anchor real/insider USD to the launch's
    // authoritative market-data total so real <= total always holds; fall back to the
    // intel-measured total when market-data volume is missing OR zero. (A plain `??` would
    // keep a literal 0 and wrongly zero out real volume that demonstrably happened on-chain.)
    const insiderRatio = result.totalQuoteRaw > 0n ? Number(result.insiderQuoteRaw) / Number(result.totalQuoteRaw) : 0;
    const totalVolumeUsd = launch.volumeUsd && launch.volumeUsd > 0 ? launch.volumeUsd : toUsd(result.totalQuoteRaw);
    const externalVolumeUsd = totalVolumeUsd != null ? totalVolumeUsd * (1 - insiderRatio) : null;
    const insiderVolumeUsd = totalVolumeUsd != null ? totalVolumeUsd * insiderRatio : null;
    const launchMs = new Date(launch.createdAt).getTime();
    const now = new Date().toISOString();

    const buyers: AttendeeBuyer[] = result.buyers.slice(0, MAX_REPORT_BUYERS).map((buyer) => ({
      address: buyer.address,
      classification: buyer.classification,
      fundingSource: buyer.fundingSource,
      fundingTxHash: buyer.fundingTxHash,
      fundingVia: buyer.fundingVia,
      funderCount: buyer.funderCount,
      clusterId: buyer.clusterId,
      tradeCount: buyer.tradeCount,
      volumeUsd: toUsd(buyer.quoteRaw),
      firstTradeAt: buyer.firstTradeMs != null ? new Date(buyer.firstTradeMs).toISOString() : null,
      secondsAfterLaunch: buyer.firstTradeMs != null ? Math.max(0, Math.round((buyer.firstTradeMs - launchMs) / 1000)) : null
    }));
    const clusters = result.clusters.map((cluster) => ({
      id: cluster.id,
      kind: cluster.kind,
      fundingSource: cluster.fundingSource,
      memberCount: cluster.memberCount,
      volumeUsd: toUsd(cluster.quoteRaw)
    }));

    const quoteByAddress = new Map(result.buyers.map((buyer) => [buyer.address, buyer.quoteRaw]));
    const graph = {
      nodes: result.graph.nodes.map((node) => ({
        ...node,
        volumeUsd: quoteByAddress.has(node.address) ? toUsd(quoteByAddress.get(node.address)!) : null
      })),
      edges: result.graph.edges
    };

    const report: AttendeeReport = {
      poolAddress: launch.poolAddress,
      dex: launch.dex,
      creator: launch.creator,
      creatorFundingSource: result.creatorFundingSource,
      analyzed: true,
      complete: result.complete,
      analyzedTrades: logs.length,
      buyerCount: traders.length,
      insiderBuyerCount: result.insiderBuyerCount,
      externalBuyerCount: result.externalBuyerCount,
      totalVolumeUsd,
      externalVolumeUsd,
      insiderVolumeUsd,
      insiderRatio,
      buyers,
      clusters,
      graph,
      updatedAt: now
    };
    const intel: Partial<Launch> = {
      externalVolumeUsd,
      insiderVolumeUsd,
      insiderRatio,
      insiderBuyerCount: result.insiderBuyerCount,
      externalBuyerCount: result.externalBuyerCount,
      intelUpdatedAt: now
    };
    return { intel, report };
  }

  // ---- DexScreener fallback (unknown quote tokens, or Etherscan failures) ----

  private async fromDexScreener(launches: Launch[], updatedAt: string): Promise<MarketData[]> {
    const results: MarketData[] = [];
    for (let index = 0; index < launches.length; index += MarketDataService.DEX_BATCH_SIZE) {
      const batch = launches.slice(index, index + MarketDataService.DEX_BATCH_SIZE);
      const pairsByAddress = await this.fetchPairs(batch.map((launch) => launch.poolAddress));
      for (const launch of batch) {
        const pair = pairsByAddress.get(launch.poolAddress.toLowerCase());
        results.push({
          poolAddress: launch.poolAddress,
          liquidityUsd: pair?.liquidity?.usd ?? null,
          volumeUsd: pair?.volume?.h24 ?? null,
          marketDataUpdatedAt: updatedAt
        });
      }
    }
    return results;
  }

  private async fetchPairs(poolAddresses: string[]): Promise<Map<string, DexScreenerPair>> {
    const addresses = poolAddresses.map((address) => address.toLowerCase()).join(",");
    const url = `https://api.dexscreener.com/latest/dex/pairs/base/${addresses}`;
    const pairsByAddress = new Map<string, DexScreenerPair>();
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(MarketDataService.REQUEST_TIMEOUT_MS) });
      if (!response.ok) return pairsByAddress;
      const payload = (await response.json()) as DexScreenerResponse;
      for (const pair of payload.pairs ?? []) {
        if (pair.pairAddress) pairsByAddress.set(pair.pairAddress.toLowerCase(), pair);
      }
    } catch (error) {
      console.warn(`DexScreener fallback failed: ${error instanceof Error ? error.message : error}`);
    }
    return pairsByAddress;
  }
}
