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
//   rug-bot      — the wallet is a manually-tagged rug bot, or connected to one's cluster
//   external     — independent funding (a real, external participant)
export type AttendeeClass = "creator" | "creator-funded" | "same-funder" | "linked" | "rug-bot" | "external";

// Manually-curated wallet labels. Tagging a "rug-bot" seed makes its entire funding cluster
// be treated as insider during attendee analysis (in addition to the creator's own cluster).
export type WalletLabelKind = "rug-bot" | "watch";

export interface WalletLabel {
  address: string;
  kind: WalletLabelKind;
  note: string | null;
  createdAt: string;
}

export interface AttendeeBuyer {
  address: string;
  classification: AttendeeClass;
  fundingSource: string | null;
  fundingTxHash: string | null;
  // "internal" => the wallet's earliest funding came through a contract (disperse/CEX/etc.).
  fundingVia: "external" | "internal" | null;
  // How many distinct ETH sources funded this wallet (funding is continuous, not one-shot).
  funderCount: number;
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

// Funding-relationship graph for visualization: wallets are nodes, each edge points from a
// wallet to the wallet that first funded it. "funder" nodes are wallets that appear only as
// funders (not themselves traders).
// "seed" and "rug" are research/manual-label roles: "seed" is the address being researched,
// "rug" is a manually-tagged rug bot.
export type AttendeeNodeRole = "creator" | "insider" | "external" | "coordinated" | "funder" | "seed" | "rug";

export interface AttendeeGraphNode {
  address: string;
  role: AttendeeNodeRole;
  clusterId: number | null;
  volumeUsd: number | null;
}

export interface AttendeeGraphEdge {
  from: string;
  to: string;
}

export interface AttendeeGraph {
  nodes: AttendeeGraphNode[];
  edges: AttendeeGraphEdge[];
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
  graph?: AttendeeGraph;
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

// Headline metrics for the last 24h ("today").
export interface LaunchStats {
  dayVolumeUsd: number;            // total 24h volume of pools launched in the last 24h
  dayRealVolumeUsd: number;        // external (real) portion of that volume (analyzed pools only)
  dayAnalyzingVolumeUsd: number;   // volume of pools not analyzed yet (real/fake split still pending)
  dayLaunchCount: number;          // pools launched in the last 24h
  dayLaunchCountMinVolume: number; // ...of those, how many have volume >= minVolumeUsd
  dayActiveCreators: number;       // distinct creator wallets that launched in the last 24h
  minVolumeUsd: number;            // threshold used for dayLaunchCountMinVolume (e.g. 100)
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
    enabled: boolean;
    isRunning: boolean;
    indexedBlock: number | null;
    latestBlock: number | null;
    lastSyncAt: string | null;
    error: string | null;
  };
}

// Per-DEX indexer state for the start/stop controls.
export interface IndexerState {
  dex: string;
  // Whether an indexer exists for this DEX (live mode + MongoDB).
  available: boolean;
  enabled: boolean;
  isRunning: boolean;
  indexedBlock: number | null;
  latestBlock: number | null;
  error: string | null;
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

// ---- Address research panel ----

// How a wallet relates to the researched seed in the ETH funding graph.
//   seed   — the address being researched
//   funder — an ancestor that (directly or via a chain) funded the seed
//   funded — a descendant the seed (directly or via a chain) funded
//   both   — reachable from the seed in both directions
export type ResearchDirection = "seed" | "funder" | "funded" | "both";

export interface ResearchConnection {
  address: string;
  direction: ResearchDirection;
  // Shortest funding-graph distance (in hops) from the seed.
  hops: number;
  // A manual label on this exact wallet, if one exists.
  label: WalletLabelKind | null;
  // Whether this wallet shares the seed's funding cluster (a strong sybil signal).
  inCluster: boolean;
  // The funding edge that first reached this wallet from the seed's side.
  via: "external" | "internal" | null;
  txHash: string | null;
}

// On-demand walk of the ETH funding graph around one address — both the wallets that funded
// it and the wallets it funded, several hops out — independent of any launch. Surfaces the
// deep bot connections the launch-anchored classifier can miss.
export interface ResearchReport {
  address: string;
  label: WalletLabelKind | null;
  // True if the seed itself, or any wallet in its cluster, is a tagged rug bot.
  rugConnected: boolean;
  connectionCount: number;
  // Tagged rug bots discovered within the explored graph.
  linkedRugBots: string[];
  connections: ResearchConnection[];
  graph: AttendeeGraph;
  walletsExplored: number;
  // False when the lookup budget was exhausted before the walk finished.
  complete: boolean;
  updatedAt: string;
}
