export type RiskLevel = "low" | "medium" | "high" | "unrated";
export type TradeSide = "buy" | "sell";
export type LaunchSort = "newest" | "oldest" | "liquidity" | "volume" | "realVolume";
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
  // Attendee-intelligence backfill: "real" volume is total volume minus the creator's
  // insider/sybil cluster (self-buys and wallets sharing the creator's funding).
  externalVolumeUsd?: number | null;
  insiderVolumeUsd?: number | null;
  insiderRatio?: number | null;
  insiderBuyerCount?: number | null;
  externalBuyerCount?: number | null;
  intelUpdatedAt?: string | null;
  marketDataUpdatedAt?: string | null;
  firstTrades: number | null;
  risk: RiskLevel;
}

// How a buyer relates to the launch creator's funding graph.
//   creator      — the buyer wallet is the creator itself (self-buy)
//   creator-funded — funded directly by the creator wallet
//   same-funder  — shares the creator's first funding wallet (a private funder)
//   linked       — connected to the creator's cluster through a multi-hop funding chain
//   external     — independent funding (a real, external participant)
export type AttendeeClass = "creator" | "creator-funded" | "same-funder" | "linked" | "external";

export interface AttendeeBuyer {
  address: string;
  classification: AttendeeClass;
  fundingSource: string | null;
  clusterId: number | null;
  tradeCount: number;
  volumeUsd: number | null;
  firstTradeAt: string | null;
  secondsAfterLaunch: number | null;
}

export interface AttendeeCluster {
  id: number;
  // "creator-insider": linked to the creator (wash trading). "coordinated": a group of
  // external buyers sharing a private funder with each other (a sniper ring), not the creator.
  kind: "creator-insider" | "coordinated";
  fundingSource: string | null;
  memberCount: number;
  volumeUsd: number | null;
}

export interface AttendeeReport {
  poolAddress: string;
  dex: string;
  creator: string;
  creatorFundingSource: string | null;
  analyzed: boolean;
  complete: boolean;
  analyzedTrades: number;
  buyerCount: number;
  insiderBuyerCount: number;
  externalBuyerCount: number;
  totalVolumeUsd: number | null;
  externalVolumeUsd: number | null;
  insiderVolumeUsd: number | null;
  insiderRatio: number | null;
  buyers: AttendeeBuyer[];
  clusters: AttendeeCluster[];
  updatedAt: string | null;
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
