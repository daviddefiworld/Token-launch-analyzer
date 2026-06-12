import { Contract, formatUnits, type ContractRunner } from "ethers";
import type { Launch } from "../types.js";
import type { EtherscanService } from "./EtherscanService.js";
import type { PriceService } from "./PriceService.js";
import { getQuoteToken, isQuoteToken0, type DexAdapter } from "./skills/DexAdapter.js";

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
    private readonly provider: ContractRunner | null = null
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
