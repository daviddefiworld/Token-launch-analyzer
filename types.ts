export type RiskLevel = "low" | "medium" | "high" | "unrated";
export type TradeSide = "buy" | "sell";
export type LaunchSort = "newest" | "oldest" | "liquidity" | "volume";
// Pool-type filter value. "all" plus whatever categories the selected DEX exposes
// (Aerodrome: "stable"/"volatile"; Uniswap V3: fee tiers like "3000"; Uniswap V2: "v2").
export type PoolType = string;

export interface Launch {
  id: string;
  // DEX adapter that produced this launch (e.g. "aerodrome", "uniswap-v2", "uniswap-v3").
  dex: string;
  poolAddress: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenCreatedAt: string | null;
  tokenCreatedBlock: number | null;
  tokenAgeAtLaunchHours: number | null;
  quoteSymbol: string;
  quoteAddress?: string;
  pair: string;
  creator: string;
  createdAt: string;
  blockNumber: number;
  // Normalized pool-type machine value and display label (see DexAdapter.ParsedLaunchEvent).
  poolType: string;
  poolTypeLabel: string;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  marketDataUpdatedAt?: string | null;
  firstTrades: number | null;
  risk: RiskLevel;
}

export interface PoolTypeOption {
  value: string;
  label: string;
}

export interface DexInfo {
  id: string;
  label: string;
  network: string;
  factory: string;
  poolTypeOptions: PoolTypeOption[];
}

export interface LaunchPage {
  items: Launch[];
  nextCursor: string | null;
  total: number;
}

export interface TokenCreation {
  address: string;
  createdAt: string | null;
  createdBlock: number | null;
}

export interface LaunchStats {
  total: number;
  totalVolumeUsd: number;
  weekVolumeUsd: number;
  dayVolumeUsd: number;
  repeatCreators: number;
}

export interface DailyAnalyticsPoint {
  date: string;
  launchCount: number;
  volumeUsd: number;
}

export interface LaunchDailyAnalytics {
  days: number;
  points: DailyAnalyticsPoint[];
}

export interface Trade {
  id: string;
  rank: number;
  side: TradeSide;
  trader: string;
  amountUsd: number | null;
  quoteAmount?: string;
  tokenAmount: number | null;
  timestamp: string;
  txHash: string;
}

export type CreatorSort = "launchCount" | "newest" | "oldest";

export interface CreatorSummary {
  address: string;
  launchCount: number;
  firstLaunchAt: string;
  lastLaunchAt: string;
}

export interface CreatorPage {
  items: CreatorSummary[];
  nextCursor: string | null;
  total: number;
}

export interface CreatorProfile {
  address: string;
  firstFundedAt: string | null;
  fundingSource: string | null;
  fundingAmount: string | null;
  launchCount: number;
  previousLaunches: Launch[];
  labels: string[];
}

export interface ApiStatus {
  mode: "demo" | "live";
  network: string;
  factory: string;
  mongodb: boolean;
  indexer?: {
    isRunning: boolean;
    indexedBlock: number | null;
    latestBlock: number | null;
    error: string | null;
  };
}

export interface RpcMethodUsage {
  method: string;
  count: number;
  errors: number;
  lastCalledAt: string | null;
}

export interface RpcUsage {
  totalCalls: number;
  totalErrors: number;
  startedAt: string;
  methods: RpcMethodUsage[];
}
