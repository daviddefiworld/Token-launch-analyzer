import type { DexAdapter } from "./DexAdapter.js";
import aerodromeAdapter from "./aerodrome/index.js";
import uniswapV2Adapter from "./uniswap-v2/index.js";
import uniswapV3Adapter from "./uniswap-v3/index.js";

// Registry of supported DEX adapters. Order defines the UI switcher order; the first entry
// is the default when no ?dex= is supplied (and the only one indexing on a fresh boot).
export const ADAPTERS: DexAdapter[] = [uniswapV2Adapter, aerodromeAdapter, uniswapV3Adapter];

export const DEFAULT_DEX_ID = ADAPTERS[0].id;

const byId = new Map(ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function getAdapter(id: string | undefined | null): DexAdapter | undefined {
  return id ? byId.get(id) : undefined;
}

export function listAdapters(): DexAdapter[] {
  return ADAPTERS;
}
