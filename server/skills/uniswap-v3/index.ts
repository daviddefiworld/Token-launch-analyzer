import { Contract, Interface, type Log } from "ethers";
import { buildQuoteMap, type DexAdapter, type ParsedLaunchEvent, type ParsedSwap, type ReadQuoteReserveInput } from "../DexAdapter.js";

// Uniswap V3 on Base — concentrated-liquidity pools created by the canonical V3 factory.
// Unlike V2-style pools, Swap amounts are signed int256 deltas of the pool's balance and
// there is no getReserves(); the pool's token balances are read directly via ERC20.

const FACTORY_ADDRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
// Standard enabled fee tiers (hundredths of a bip). Governance can add more; those still
// index correctly and get a computed label, they just won't appear in the filter dropdown.
const STANDARD_FEE_TIERS = [100, 500, 3000, 10000];

const FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)"
];
const POOL_ABI = [
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const factoryInterface = new Interface(FACTORY_ABI);
const poolInterface = new Interface(POOL_ABI);

// fee is in hundredths of a bip: 3000 -> 0.30%, 100 -> 0.01%, 10000 -> 1.00%.
const feeLabel = (fee: number): string => `${(fee / 10_000).toFixed(2)}%`;

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

export const uniswapV3Adapter: DexAdapter = {
  id: "uniswap-v3",
  label: "Uniswap V3",
  network: "Base",
  factoryAddress: FACTORY_ADDRESS,
  factoryInterface,
  poolInterface,
  launchEventName: "PoolCreated",
  swapEventName: "Swap",
  poolTypeOptions: STANDARD_FEE_TIERS.map((fee) => ({ value: String(fee), label: feeLabel(fee) })),
  quotes: buildQuoteMap(),

  parseLaunchLog(log: Log): ParsedLaunchEvent {
    const event = factoryInterface.parseLog(log)!;
    const fee = Number(event.args.fee);
    return {
      token0: event.args.token0.toLowerCase(),
      token1: event.args.token1.toLowerCase(),
      poolAddress: event.args.pool,
      poolType: String(fee),
      poolTypeLabel: feeLabel(fee)
    };
  },

  // V3 amounts are signed: positive = quote paid into the pool (a buy of the launched
  // token), negative = quote sent out to the recipient (a sell). The traded amount is the
  // absolute value of the quote leg.
  parseSwap(input): ParsedSwap | null {
    try {
      const event = poolInterface.parseLog({ topics: input.topics as string[], data: input.data });
      if (!event) return null;
      const quoteAmount: bigint = input.quoteIsToken0 ? event.args.amount0 : event.args.amount1;
      return {
        side: quoteAmount > 0n ? "buy" : "sell",
        quoteAmountRaw: abs(quoteAmount),
        trader: event.args.recipient
      };
    } catch {
      return null;
    }
  },

  // No getReserves() on V3 — the quote reserve is simply the pool's ERC20 balance of the
  // quote token. (A rough 2x-quote TVL estimate; concentrated liquidity means this is an
  // upper bound on in-range depth.)
  async readQuoteReserve(input: ReadQuoteReserveInput): Promise<bigint> {
    if (input.provider) {
      const token = new Contract(input.quoteAddress, ERC20_ABI, input.provider);
      return token.balanceOf(input.poolAddress);
    }
    if (input.etherscan) return input.etherscan.getTokenBalance(input.quoteAddress, input.poolAddress);
    return 0n;
  }
};

export default uniswapV3Adapter;
