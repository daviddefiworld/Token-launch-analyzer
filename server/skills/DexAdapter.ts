import type { Interface, Log, ContractRunner } from "ethers";
import type { EtherscanService } from "../EtherscanService.js";

// A DexAdapter encapsulates everything that differs between DEX deployments on Base:
// the factory address, the pool-creation and swap event shapes, how reserves are read,
// the pool-type taxonomy, and any DEX-specific quote tokens. The generic LaunchAnalyzer,
// LaunchIndexer, MarketDataService, and LaunchRepository are otherwise DEX-agnostic.

export interface QuoteToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolTypeOption {
  value: string;
  label: string;
}

// Normalized result of decoding one pool/pair-creation log.
export interface ParsedLaunchEvent {
  token0: string;
  token1: string;
  poolAddress: string;
  // Machine value used for filtering/storage (e.g. "stable", "volatile", "v2", "3000").
  poolType: string;
  // Human label shown in the UI (e.g. "Stable", "Volatile", "Uniswap V2", "0.30%").
  poolTypeLabel: string;
}

// Normalized result of decoding one swap log, from the quote token's perspective.
export interface ParsedSwap {
  // "buy" = quote flowed into the pool (the launched token was bought).
  side: "buy" | "sell";
  // Absolute raw amount of the quote leg (still in the quote token's smallest unit).
  quoteAmountRaw: bigint;
  // Recipient of the swap output.
  trader: string;
}

export interface ReadQuoteReserveInput {
  provider: ContractRunner | null;
  etherscan: EtherscanService | null;
  poolAddress: string;
  quoteAddress: string;
  quoteIsToken0: boolean;
  quoteDecimals: number;
}

export interface DexAdapter {
  // Stable identifier used in the API (?dex=), Mongo scoping, and the UI switcher.
  readonly id: string;
  // Display name, e.g. "Aerodrome" or "Uniswap V3".
  readonly label: string;
  readonly network: string;
  readonly factoryAddress: string;

  // Interfaces carrying the factory creation event and the pool Swap event.
  readonly factoryInterface: Interface;
  readonly poolInterface: Interface;
  readonly launchEventName: string;
  readonly swapEventName: string;

  // Pool-type choices offered in the UI filter (excluding the implicit "all").
  readonly poolTypeOptions: PoolTypeOption[];

  // Effective quote tokens: the shared Base quotes plus any DEX-specific ones (e.g. AERO).
  readonly quotes: Map<string, QuoteToken>;

  // Decode a factory creation log into a normalized launch event.
  parseLaunchLog(log: Log): ParsedLaunchEvent;

  // Decode a swap log into the quote-side amount and side. Returns null on a malformed log.
  parseSwap(input: { topics: readonly string[]; data: string; quoteIsToken0: boolean }): ParsedSwap | null;

  // Read the raw quote-token reserve held by the pool, used for the 2x-quote TVL estimate.
  readQuoteReserve(input: ReadQuoteReserveInput): Promise<bigint>;
}

// ---- Shared quote-token helpers (operate on an adapter's effective quote map) ----

// Canonical Base quote tokens, shared by every DEX on the chain.
export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";

export const BASE_QUOTES: ReadonlyArray<QuoteToken> = [
  { address: WETH, symbol: "WETH", decimals: 18 },
  { address: USDC, symbol: "USDC", decimals: 6 },
  { address: USDT, symbol: "USDT", decimals: 6 }
];

// USD stablecoins quoted 1:1.
export const STABLE_QUOTES = new Set<string>([USDC, USDT]);

// Build an effective quote map from the shared Base quotes plus DEX-specific extras.
export function buildQuoteMap(extra: ReadonlyArray<QuoteToken> = []): Map<string, QuoteToken> {
  const map = new Map<string, QuoteToken>();
  for (const quote of [...BASE_QUOTES, ...extra]) {
    map.set(quote.address.toLowerCase(), { ...quote, address: quote.address.toLowerCase() });
  }
  return map;
}

export function getQuoteToken(quotes: Map<string, QuoteToken>, address: string): QuoteToken | undefined {
  return quotes.get(address.toLowerCase());
}

export function isKnownQuote(quotes: Map<string, QuoteToken>, address: string): boolean {
  return quotes.has(address.toLowerCase());
}

// Uniswap-style factories (V2, V3, and Aerodrome) sort token0 < token1 numerically.
export function isQuoteToken0(quoteAddress: string, tokenAddress: string): boolean {
  return BigInt(quoteAddress) < BigInt(tokenAddress);
}
