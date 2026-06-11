// Canonical Base quote tokens used to price launches in USD.
// USDC / USDT are treated as $1, WETH is priced from the live ETH price,
// and any other quote (e.g. AERO) is priced through the "other way" fallback.

export const WETH = "0x4200000000000000000000000000000000000006";
export const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
export const USDT = "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2";
export const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";

export interface QuoteToken {
  address: string;
  symbol: string;
  decimals: number;
}

export const QUOTE_TOKENS = new Map<string, QuoteToken>([
  [WETH, { address: WETH, symbol: "WETH", decimals: 18 }],
  [USDC, { address: USDC, symbol: "USDC", decimals: 6 }],
  [USDT, { address: USDT, symbol: "USDT", decimals: 6 }],
  [AERO, { address: AERO, symbol: "AERO", decimals: 18 }]
]);

// USD stablecoins quoted 1:1.
export const STABLE_QUOTES = new Set<string>([USDC, USDT]);

export function getQuoteToken(address: string): QuoteToken | undefined {
  return QUOTE_TOKENS.get(address.toLowerCase());
}

export function isKnownQuote(address: string): boolean {
  return QUOTE_TOKENS.has(address.toLowerCase());
}

// Aerodrome (Uniswap-style) factories sort token0 < token1 numerically.
export function isQuoteToken0(quoteAddress: string, tokenAddress: string): boolean {
  return BigInt(quoteAddress) < BigInt(tokenAddress);
}
