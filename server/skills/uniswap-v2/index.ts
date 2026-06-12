import { Interface, type Log } from "ethers";
import { buildQuoteMap, type DexAdapter, type ParsedLaunchEvent } from "../DexAdapter.js";
import { parseV2Swap, readV2QuoteReserve } from "../v2Pool.js";

// Uniswap V2 on Base — the official Uniswap Labs V2 factory (not a fork). Structurally
// the same constant-product design as Aerodrome classic, but its Swap event indexes `to`
// last, giving it a distinct topic0 hash, and it has no stable/volatile distinction.

const FACTORY_ADDRESS = "0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6";

const FACTORY_ABI = [
  "event PairCreated(address indexed token0,address indexed token1,address pair,uint256)"
];
const POOL_ABI = [
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
  "function token0() view returns (address)",
  "function token1() view returns (address)"
];

const factoryInterface = new Interface(FACTORY_ABI);
const poolInterface = new Interface(POOL_ABI);

export const uniswapV2Adapter: DexAdapter = {
  id: "uniswap-v2",
  label: "Uniswap V2",
  network: "Base",
  factoryAddress: FACTORY_ADDRESS,
  factoryInterface,
  poolInterface,
  launchEventName: "PairCreated",
  swapEventName: "Swap",
  // Every V2 pair is a single constant-product type, so there is no sub-type filter.
  poolTypeOptions: [],
  quotes: buildQuoteMap(),

  parseLaunchLog(log: Log): ParsedLaunchEvent {
    const event = factoryInterface.parseLog(log)!;
    return {
      token0: event.args.token0.toLowerCase(),
      token1: event.args.token1.toLowerCase(),
      poolAddress: event.args.pair,
      poolType: "volatile",
      poolTypeLabel: "Volatile"
    };
  },

  parseSwap(input) {
    return parseV2Swap(poolInterface, "to", input);
  },

  readQuoteReserve: readV2QuoteReserve
};

export default uniswapV2Adapter;
