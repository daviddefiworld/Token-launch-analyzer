import { Contract, Interface, formatUnits, type ContractRunner, type Log } from "ethers";
import type { Launch } from "../types.js";
import type { EtherscanService } from "./EtherscanService.js";
import type { PriceService } from "./PriceService.js";
import { getQuoteToken, isQuoteToken0 } from "./tokens.js";

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

const SWAP_ABI = [
  "event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)"
];
const SWAP_INTERFACE = new Interface(SWAP_ABI);
const SWAP_TOPIC = SWAP_INTERFACE.getEvent("Swap")!.topicHash;
const RESERVES_ABI = ["function getReserves() view returns (uint256,uint256,uint256)"];
const DECIMALS_ABI = ["function decimals() view returns (uint8)"];
const BLOCKS_PER_DAY = 43_200;

// Computes liquidity and 24h volume in USD. Known quote tokens (WETH/USDC/USDT/AERO)
// are priced precisely through Etherscan + PriceService; everything else falls back
// to DexScreener's aggregated pair data.
export class MarketDataService {
  private static readonly DEX_BATCH_SIZE = 30;
  private static readonly REQUEST_TIMEOUT_MS = 30_000;
  private readonly decimalsCache = new Map<string, number>();

  constructor(
    private readonly etherscan: EtherscanService | null = null,
    private readonly priceService: PriceService | null = null,
    private readonly provider: ContractRunner | null = null
  ) {}

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
    const known = getQuoteToken(key);
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

  // TVL ≈ 2× the value of the quote reserve held by the pool. Reserves come from the
  // fast RPC (canonical on-chain state); Etherscan tokenbalance is only a fallback.
  private async computeLiquidity(launch: Launch, quoteDecimals: number, price: number): Promise<number> {
    const quoteIsToken0 = isQuoteToken0(launch.quoteAddress!, launch.tokenAddress);
    if (this.provider) {
      const pool = new Contract(launch.poolAddress, RESERVES_ABI, this.provider);
      const reserves = await pool.getReserves();
      const quoteReserve: bigint = quoteIsToken0 ? reserves[0] : reserves[1];
      return Number(formatUnits(quoteReserve, quoteDecimals)) * price * 2;
    }
    const balance = await this.etherscan!.getTokenBalance(launch.quoteAddress!, launch.poolAddress);
    return Number(formatUnits(balance, quoteDecimals)) * price * 2;
  }

  // Sum of every swap's quote-token leg over the last 24h, valued in USD.
  private async computeVolume(launch: Launch, quoteDecimals: number, price: number, latestBlock: number): Promise<number> {
    const fromBlock = Math.max(latestBlock - BLOCKS_PER_DAY, launch.blockNumber);
    const logs = await this.etherscan!.getLogs({
      address: launch.poolAddress,
      topic0: SWAP_TOPIC,
      fromBlock,
      toBlock: latestBlock
    });
    const quoteIsToken0 = isQuoteToken0(launch.quoteAddress!, launch.tokenAddress);
    let quoteTotal = 0n;
    for (const log of logs) {
      quoteTotal += this.swapQuoteAmount({ topics: log.topics, data: log.data } as unknown as Log, quoteIsToken0);
    }
    return Number(formatUnits(quoteTotal, quoteDecimals)) * price;
  }

  private swapQuoteAmount(log: Log, quoteIsToken0: boolean): bigint {
    try {
      const event = SWAP_INTERFACE.parseLog(log);
      if (!event) return 0n;
      const amountIn = quoteIsToken0 ? event.args.amount0In : event.args.amount1In;
      const amountOut = quoteIsToken0 ? event.args.amount0Out : event.args.amount1Out;
      return (amountIn as bigint) > 0n ? (amountIn as bigint) : (amountOut as bigint);
    } catch {
      return 0n;
    }
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
