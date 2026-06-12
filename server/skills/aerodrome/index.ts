import { Interface, type Log } from "ethers";
import { buildQuoteMap, type DexAdapter, type ParsedLaunchEvent, type QuoteToken } from "../DexAdapter.js";
import { parseV2Swap, readV2QuoteReserve } from "../v2Pool.js";

// Aerodrome classic pools on Base — the official PoolFactory emitting V2-style stable and
// volatile pools. Slipstream concentrated-liquidity pools are a separate factory.

const FACTORY_ADDRESS = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";
// AERO is Aerodrome's native quote token; only meaningful for Aerodrome pools.
const AERO: QuoteToken = { address: "0x940181a94a35a4569e4529a3cdfb74e38fd98631", symbol: "AERO", decimals: 18 };

const FACTORY_ABI = [
  "event PoolCreated(address indexed token0,address indexed token1,bool indexed stable,address pool,uint256)"
];
const POOL_ABI = [
  "event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const factoryInterface = new Interface(FACTORY_ABI);
const poolInterface = new Interface(POOL_ABI);

export const aerodromeAdapter: DexAdapter = {
  id: "aerodrome",
  label: "Aerodrome",
  network: "Base",
  factoryAddress: FACTORY_ADDRESS,
  factoryInterface,
  poolInterface,
  launchEventName: "PoolCreated",
  swapEventName: "Swap",
  poolTypeOptions: [
    { value: "volatile", label: "Volatile" },
    { value: "stable", label: "Stable" }
  ],
  quotes: buildQuoteMap([AERO]),

  parseLaunchLog(log: Log): ParsedLaunchEvent {
    const event = factoryInterface.parseLog(log)!;
    const stable: boolean = event.args.stable;
    return {
      token0: event.args.token0.toLowerCase(),
      token1: event.args.token1.toLowerCase(),
      poolAddress: event.args.pool,
      poolType: stable ? "stable" : "volatile",
      poolTypeLabel: stable ? "Stable" : "Volatile"
    };
  },

  parseSwap(input) {
    return parseV2Swap(poolInterface, "to", input);
  },

  readQuoteReserve: readV2QuoteReserve
};

export default aerodromeAdapter;
