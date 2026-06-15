import type { EtherscanService } from "./EtherscanService.js";
import { STABLE_QUOTES, VIRTUAL, WETH } from "./skills/DexAdapter.js";

interface DexScreenerToken {
  priceUsd?: string;
  liquidity?: { usd?: number };
}

interface DexScreenerTokenResponse {
  pairs?: DexScreenerToken[] | null;
}

const CACHE_TTL_MS = 60_000;

// Well-known quote tokens that get an authoritative price from CoinGecko's Base on-chain
// feed instead of the generic DexScreener most-liquid-pair heuristic. Extend as more
// frequently-paired tokens appear (currently just VIRTUAL).
const COINGECKO_PRICED = new Set<string>([VIRTUAL]);

// Resolves the USD price of a pool's quote token.
//   USDC / USDT -> 1
//   WETH        -> live ETH/USD from CoinGecko, with Etherscan as a fallback
//   VIRTUAL (and other well-known tokens) -> CoinGecko Base feed, DexScreener fallback
//   anything else (e.g. AERO) -> most-liquid DexScreener pair price
export class PriceService {
  private readonly cache = new Map<string, { value: number | null; at: number }>();
  private ethPrice: { value: number; at: number } | null = null;

  constructor(private readonly etherscan: EtherscanService) {}

  async getQuotePriceUsd(quoteAddress: string): Promise<number | null> {
    const key = quoteAddress.toLowerCase();
    if (STABLE_QUOTES.has(key)) return 1;
    if (key === WETH) return this.getEthPriceUsd();

    const cached = this.cache.get(key);
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

    // Well-known tokens prefer the authoritative CoinGecko feed; everything falls back to
    // DexScreener's deepest-pair price.
    let value = COINGECKO_PRICED.has(key) ? await this.fetchCoinGeckoPrice(key) : null;
    if (value == null) value = await this.fetchDexScreenerPrice(key);
    this.cache.set(key, { value, at: now });
    return value;
  }

  // ETH/USD from CoinGecko's canonical "ethereum" feed (deep and reliable, unlike the
  // Basescan stats/ethprice action), cached briefly and falling back to Etherscan only if
  // CoinGecko is unreachable.
  async getEthPriceUsd(): Promise<number | null> {
    const now = Date.now();
    if (this.ethPrice && now - this.ethPrice.at < CACHE_TTL_MS) return this.ethPrice.value;

    let value = await this.fetchCoinGeckoSimplePrice("ethereum");
    if (value == null) {
      try {
        value = await this.etherscan.getEthPriceUsd();
      } catch {
        value = null;
      }
    }
    if (value != null) this.ethPrice = { value, at: now };
    return value;
  }

  // CoinGecko spot price by coin id (e.g. "ethereum"). Null on any failure.
  private async fetchCoinGeckoSimplePrice(id: string): Promise<number | null> {
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as Record<string, { usd?: number }>;
      const price = payload[id]?.usd;
      return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
  }

  // CoinGecko on-chain price by contract on the Base platform. Returns the address keyed
  // (lowercase) USD price, or null on any failure (caller then tries DexScreener).
  private async fetchCoinGeckoPrice(address: string): Promise<number | null> {
    try {
      const response = await fetch(
        `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${address}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!response.ok) return null;
      const payload = (await response.json()) as Record<string, { usd?: number }>;
      const price = payload[address.toLowerCase()]?.usd;
      return typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
    } catch {
      return null;
    }
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
