import { Contract, formatUnits, type ContractRunner } from "ethers";
import type { AttendeeBuyer, AttendeeReport, Launch } from "../types.js";
import type { EtherscanService } from "./EtherscanService.js";
import type { PriceService } from "./PriceService.js";
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
  private readonly decimalsCache = new Map<string, number>();
  private readonly swapTopic: string;

  constructor(
    private readonly adapter: DexAdapter,
    private readonly etherscan: EtherscanService | null = null,
    private readonly priceService: PriceService | null = null,
    private readonly provider: ContractRunner | null = null,
    private readonly walletIntel: WalletIntelService | null = null
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

    return { poolAddress: launch.poolAddress, liquidityUsd, volumeUsd, marketDataUpdatedAt: updatedAt };
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

  // Sum of every swap's quote-token leg over the last 24h, valued in USD.
  private async computeVolume(launch: Launch, quoteDecimals: number, price: number, latestBlock: number): Promise<number> {
    const fromBlock = Math.max(latestBlock - BLOCKS_PER_DAY, launch.blockNumber);
    const logs = await this.etherscan!.getLogs({
      address: launch.poolAddress,
      topic0: this.swapTopic,
      fromBlock,
      toBlock: latestBlock
    });
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
    const logs = await this.etherscan.getLogs({
      address: launch.poolAddress,
      topic0: this.swapTopic,
      fromBlock,
      toBlock: latestBlock
    });

    // Aggregate swaps by trader (the swap recipient EOA).
    const quoteIsToken0 = isQuoteToken0(launch.quoteAddress, launch.tokenAddress);
    const byTrader = new Map<string, { quoteRaw: bigint; tradeCount: number; firstTradeMs: number | null }>();
    for (const log of logs) {
      const swap = this.adapter.parseSwap({ topics: log.topics, data: log.data, quoteIsToken0 });
      if (!swap || !swap.trader) continue;
      const key = swap.trader.toLowerCase();
      const entry = byTrader.get(key) ?? { quoteRaw: 0n, tradeCount: 0, firstTradeMs: null };
      entry.quoteRaw += swap.quoteAmountRaw;
      entry.tradeCount += 1;
      const ms = log.timeStamp * 1000;
      entry.firstTradeMs = entry.firstTradeMs == null ? ms : Math.min(entry.firstTradeMs, ms);
      byTrader.set(key, entry);
    }

    const traders: TraderActivity[] = [...byTrader.entries()].map(([address, value]) => ({ address, ...value }));
    const result = await this.walletIntel.classify(launch.creator, traders, { maxNewLookups: opts.maxNewLookups });

    const price = this.priceService ? await this.priceService.getQuotePriceUsd(launch.quoteAddress) : null;
    const toUsd = (raw: bigint): number | null => (price == null ? null : Number(formatUnits(raw, quoteDecimals)) * price);
    const externalRaw = result.totalQuoteRaw - result.insiderQuoteRaw;
    const insiderRatio = result.totalQuoteRaw > 0n ? Number(result.insiderQuoteRaw) / Number(result.totalQuoteRaw) : 0;
    const launchMs = new Date(launch.createdAt).getTime();
    const now = new Date().toISOString();

    const buyers: AttendeeBuyer[] = result.buyers.slice(0, MAX_REPORT_BUYERS).map((buyer) => ({
      address: buyer.address,
      classification: buyer.classification,
      fundingSource: buyer.fundingSource,
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
      totalVolumeUsd: toUsd(result.totalQuoteRaw),
      externalVolumeUsd: toUsd(externalRaw),
      insiderVolumeUsd: toUsd(result.insiderQuoteRaw),
      insiderRatio,
      buyers,
      clusters,
      graph,
      updatedAt: now
    };
    const intel: Partial<Launch> = {
      externalVolumeUsd: toUsd(externalRaw),
      insiderVolumeUsd: toUsd(result.insiderQuoteRaw),
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
