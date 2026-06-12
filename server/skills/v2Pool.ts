import { Contract, type Interface } from "ethers";
import type { ParsedSwap, ReadQuoteReserveInput } from "./DexAdapter.js";

// Shared Uniswap-V2-style pool math, used by both the Aerodrome classic adapter and the
// Uniswap V2 adapter. Their Swap events differ only in where the `to` address is indexed
// (so they have distinct topic0 hashes and ABIs), but the four amount fields
// (amount0In/amount1In/amount0Out/amount1Out) and reserve semantics are identical.

const RESERVES_ABI = ["function getReserves() view returns (uint256,uint256,uint256)"];

// Decode a V2-style Swap from the quote token's perspective. Exactly one of the quote
// leg's In/Out amounts is non-zero per swap: a non-zero In means quote flowed into the
// pool (the launched token was bought); a non-zero Out means the token was sold.
export function parseV2Swap(
  poolInterface: Interface,
  traderField: string,
  input: { topics: readonly string[]; data: string; quoteIsToken0: boolean }
): ParsedSwap | null {
  try {
    const event = poolInterface.parseLog({ topics: input.topics as string[], data: input.data });
    if (!event) return null;
    const quoteIn: bigint = input.quoteIsToken0 ? event.args.amount0In : event.args.amount1In;
    const quoteOut: bigint = input.quoteIsToken0 ? event.args.amount0Out : event.args.amount1Out;
    return {
      side: quoteIn > 0n ? "buy" : "sell",
      quoteAmountRaw: quoteIn > 0n ? quoteIn : quoteOut,
      trader: event.args[traderField]
    };
  } catch {
    return null;
  }
}

// Canonical reserves come from getReserves() over RPC; Etherscan tokenbalance is a fallback
// when no provider is configured.
export async function readV2QuoteReserve(input: ReadQuoteReserveInput): Promise<bigint> {
  if (input.provider) {
    const pool = new Contract(input.poolAddress, RESERVES_ABI, input.provider);
    const reserves = await pool.getReserves();
    return input.quoteIsToken0 ? reserves[0] : reserves[1];
  }
  if (input.etherscan) return input.etherscan.getTokenBalance(input.quoteAddress, input.poolAddress);
  return 0n;
}
