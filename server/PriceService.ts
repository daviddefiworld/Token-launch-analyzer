import type { EtherscanService } from "./EtherscanService.js";
import { STABLE_QUOTES, WETH } from "./skills/DexAdapter.js";

interface DexScreenerToken {
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerTokenResponse {
  pairs?: DexScreenerToken[] | null;
}

const CACHE_TTL_MS = 60_000;

// Resolves the USD price of a pool's quote token.
//   USDC / USDT -> 1
//   WETH        -> live ETH price from Etherscan
//   anything else (e.g. AERO) -> "other way": most-liquid DexScreener pair price
export class PriceService {
  private readonly cache = new Map<string, { value: number | null; at: number }>();

  constructor(private readonly etherscan: EtherscanService) {}

  async getQuotePriceUsd(quoteAddress: string): Promise<number | null> {
    const key = quoteAddress.toLowerCase();
    if (STABLE_QUOTES.has(key)) return 1;
    if (key === WETH) return this.etherscan.getEthPriceUsd();

    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

    const value = await this.fetchDexScreenerPrice(key);
    this.cache.set(key, { value, at: now });
    return value;
  }

  private async fetchDexScreenerPrice(address: string): Promise<number | null> {
    try {
      const response = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`, {
        signal: AbortSignal.timeout(15_000)
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as DexScreenerTokenResponse;
      // Trust the deepest-liquidity pair for the most reliable price.
      const best = (payload.pairs ?? [])
        .filter((pair) => Number(pair.priceUsd) > 0)
        .sort((left, right) => (right.liquidity?.usd ?? 0) - (left.liquidity?.usd ?? 0))[0];
      const price = Number(best?.priceUsd);
      return Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }
}
