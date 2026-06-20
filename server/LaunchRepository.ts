import mongoose from "mongoose";
import type { AttendeeReport, CreatorPage, CreatorSort, CreatorSummary, DailyAnalyticsPoint, Launch, LaunchDailyAnalytics, LaunchPage, LaunchSort, LaunchStats, PoolType, TokenCreation, WalletLabel, WalletLabelKind } from "../types.js";
import type { MarketData } from "./MarketDataService.js";
import type { FundingInflow, WalletFunding } from "./WalletIntelService.js";

const INDEX_VERSION = 6;
// A launch counts as having "real traction" once its 24h volume clears this threshold.
const STATS_MIN_VOLUME_USD = 100;

interface IndexState {
  _id: string;
  indexedBlock: number;
  version: number;
}

// Persisted per-DEX monitoring toggle, so the start/stop choice survives restarts.
interface IndexerControl {
  _id: string;
  enabled: boolean;
}

const launchSchema = new mongoose.Schema<Launch>(
  {
    id: { type: String, required: true, unique: true },
    dex: { type: String, required: true, index: true },
    poolAddress: { type: String, required: true, unique: true },
    tokenAddress: { type: String, required: true },
    tokenSymbol: { type: String, required: true },
    tokenCreatedAt: { type: String, default: null },
    tokenCreatedBlock: { type: Number, default: null },
    tokenAgeAtLaunchHours: { type: Number, default: null },
    quoteSymbol: { type: String, required: true },
    quoteAddress: { type: String, default: null },
    pair: { type: String, required: true },
    creator: { type: String, required: true },
    createdAt: { type: String, required: true },
    blockNumber: { type: Number, required: true, index: true },
    poolType: { type: String, required: true },
    poolTypeLabel: { type: String, required: true },
    liquidityUsd: { type: Number, default: null },
    volumeUsd: { type: Number, default: null },
    externalVolumeUsd: { type: Number, default: null },
    insiderVolumeUsd: { type: Number, default: null },
    insiderRatio: { type: Number, default: null },
    insiderBuyerCount: { type: Number, default: null },
    externalBuyerCount: { type: Number, default: null },
    intelUpdatedAt: { type: String, default: null },
    marketDataUpdatedAt: { type: String, default: null },
    firstTrades: { type: Number, default: null },
    risk: { type: String, required: true }
  },
  { versionKey: false }
);
// Compound indexes backing the hot list/sort/stat/refresh queries, each led by `dex` (every
// query is DEX-scoped) and tie-broken by the cursor field. Without these, sorting/paginating
// by volume/liquidity/real-volume, the 24h stats, the creators rollup, and the background
// "stale launches" scans all fall back to full collection scans + in-memory sorts.
launchSchema.index({ dex: 1, blockNumber: -1, id: -1 });        // newest / oldest + cursor
launchSchema.index({ dex: 1, volumeUsd: -1, id: -1 });          // sort: 24h volume
launchSchema.index({ dex: 1, liquidityUsd: -1, id: -1 });       // sort: liquidity
launchSchema.index({ dex: 1, externalVolumeUsd: -1, id: -1 });  // sort: real volume
launchSchema.index({ dex: 1, createdAt: 1 });                   // stats / daily analytics / monitor cutoff
launchSchema.index({ dex: 1, creator: 1 });                     // creator profile + creators rollup
launchSchema.index({ dex: 1, marketDataUpdatedAt: 1, blockNumber: -1 }); // market-data refresh scan
launchSchema.index({ dex: 1, intelUpdatedAt: 1, volumeUsd: -1 });        // attendee-intel refresh scan
const indexStateSchema = new mongoose.Schema<IndexState>(
  {
    _id: { type: String, required: true },
    indexedBlock: { type: Number, required: true },
    version: { type: Number, required: true }
  },
  { versionKey: false }
);
const indexerControlSchema = new mongoose.Schema<IndexerControl>(
  {
    _id: { type: String, required: true },
    enabled: { type: Boolean, required: true }
  },
  { versionKey: false }
);
const LaunchModel = mongoose.models.Launch || mongoose.model<Launch>("Launch", launchSchema);
const IndexStateModel = mongoose.models.IndexState || mongoose.model<IndexState>("IndexState", indexStateSchema);
const IndexerControlModel = mongoose.models.IndexerControl || mongoose.model<IndexerControl>("IndexerControl", indexerControlSchema);

// Persisted indexer status snapshot per DEX. The scanned checkpoint lives in IndexState;
// this carries the rest of the runtime status (chain tip, last sync, last error) plus the
// market/intel refresh throttles, so a restart resumes where it left off instead of
// immediately re-refreshing recently-analyzed launches.
export interface IndexerStatusState {
  _id: string;
  latestBlock: number | null;
  lastSyncAt: string | null;
  lastMarketRefreshAt: number;
  lastIntelRefreshAt: number;
  error: string | null;
}
const indexerStatusSchema = new mongoose.Schema<IndexerStatusState>(
  {
    _id: { type: String, required: true },
    latestBlock: { type: Number, default: null },
    lastSyncAt: { type: String, default: null },
    lastMarketRefreshAt: { type: Number, default: 0 },
    lastIntelRefreshAt: { type: Number, default: 0 },
    error: { type: String, default: null }
  },
  { versionKey: false }
);
const IndexerStatusModel = mongoose.models.IndexerStatus || mongoose.model<IndexerStatusState>("IndexerStatus", indexerStatusSchema);
const tokenCreationSchema = new mongoose.Schema<TokenCreation>(
  {
    address: { type: String, required: true, unique: true },
    createdAt: { type: String, default: null },
    createdBlock: { type: Number, default: null }
  },
  { versionKey: false }
);
const TokenCreationModel = mongoose.models.TokenCreation || mongoose.model<TokenCreation>("TokenCreation", tokenCreationSchema);

// Immutable cache of tx hash -> signing EOA, so the "real trader behind the router" lookup
// is paid once and reused across re-analyses and the first-trades view.
interface TxSenderState {
  _id: string;
  from: string;
}
const txSenderSchema = new mongoose.Schema<TxSenderState>(
  {
    _id: { type: String, required: true },
    from: { type: String, required: true }
  },
  { versionKey: false }
);
const TxSenderModel = mongoose.models.TxSender || mongoose.model<TxSenderState>("TxSender", txSenderSchema);

// Global, cross-launch funding cache. Each wallet stores every distinct ETH source that
// funded it (`funders`), so the whole funding graph is reconstructable; the scalar fields
// mirror the earliest funder for display. Once a bot is investigated it is served from here
// for every future launch it appears in.
const fundingInflowSchema = new mongoose.Schema(
  {
    from: { type: String, required: true },
    via: { type: String, default: "external" },
    txHash: { type: String, default: null },
    value: { type: String, default: null },
    timeStamp: { type: Number, default: 0 }
  },
  { _id: false, versionKey: false }
);
const walletFundingSchema = new mongoose.Schema<WalletFunding>(
  {
    address: { type: String, required: true, unique: true },
    funders: { type: [fundingInflowSchema], default: [] },
    fundingSource: { type: String, default: null, index: true },
    fundingTxHash: { type: String, default: null },
    firstFundedAt: { type: String, default: null },
    fundingAmount: { type: String, default: null },
    fetchedAt: { type: String, required: true }
  },
  { versionKey: false }
);
// Multikey index for funder out-degree lookups over every funding edge.
walletFundingSchema.index({ "funders.from": 1 });
const WalletFundingModel = mongoose.models.WalletFunding || mongoose.model<WalletFunding>("WalletFunding", walletFundingSchema);

// Per-launch attendee-intelligence report (the detailed per-buyer breakdown). Aggregates
// also live on the Launch doc for list-wide sorting; the full buyer list lives here.
// Loosely typed (no schema generic) so the nested buyers/clusters arrays can be stored as
// Mixed; reads are typed via .lean<AttendeeReport>().
const attendeeReportSchema = new mongoose.Schema(
  {
    poolAddress: { type: String, required: true, unique: true },
    dex: { type: String, required: true, index: true },
    creator: { type: String, required: true },
    creatorFundingSource: { type: String, default: null },
    analyzed: { type: Boolean, default: false },
    complete: { type: Boolean, default: false },
    analyzedTrades: { type: Number, default: 0 },
    buyerCount: { type: Number, default: 0 },
    insiderBuyerCount: { type: Number, default: 0 },
    externalBuyerCount: { type: Number, default: 0 },
    totalVolumeUsd: { type: Number, default: null },
    externalVolumeUsd: { type: Number, default: null },
    insiderVolumeUsd: { type: Number, default: null },
    insiderRatio: { type: Number, default: null },
    buyers: { type: [mongoose.Schema.Types.Mixed], default: [] },
    clusters: { type: [mongoose.Schema.Types.Mixed], default: [] },
    graph: { type: mongoose.Schema.Types.Mixed, default: null },
    updatedAt: { type: String, default: null }
  },
  { versionKey: false }
);
const AttendeeReportModel = mongoose.models.AttendeeReport || mongoose.model("AttendeeReport", attendeeReportSchema);

// Manually-curated wallet labels (rug bots, watchlist). Global across DEXes — a bot is a bot
// regardless of which factory its victims launched on.
const walletLabelSchema = new mongoose.Schema<WalletLabel>(
  {
    address: { type: String, required: true, unique: true },
    kind: { type: String, required: true, index: true },
    note: { type: String, default: null },
    createdAt: { type: String, required: true }
  },
  { versionKey: false }
);
const WalletLabelModel = mongoose.models.WalletLabel || mongoose.model<WalletLabel>("WalletLabel", walletLabelSchema);

// Short-lived per-filter count cache, shared across repositories (every filter carries `dex`,
// so there's no cross-DEX collision). Stops the list view from re-running countDocuments over
// the whole collection on every keystroke/scroll.
const COUNT_TTL_MS = 10_000;
const countCache = new Map<string, { total: number; at: number }>();

// One repository per DEX. All launch queries are scoped to the adapter's `dex` id and each
// DEX keeps its own indexing checkpoint, so the three DEXes share collections without their
// data leaking across the ?dex= switcher. Token-creation times are chain-global and shared.
export class LaunchRepository {
  constructor(
    private readonly dexId: string,
    private readonly cleanupLegacy = false,
    // Background refresh loops (market data + attendee intel) only touch launches created
    // within this window, to cap recurring Etherscan usage (5 req/s, 100k/day free tier).
    private readonly monitorWindowHours = 24
  ) {}

  private get indexStateId(): string {
    return `${this.dexId}-pools`;
  }

  private get monitorCutoffIso(): string {
    return new Date(Date.now() - this.monitorWindowHours * 3_600_000).toISOString();
  }

  // Cached total for a list filter. The key serializes RegExp search patterns by source so
  // distinct searches don't collide; entries expire after COUNT_TTL_MS.
  private async getCachedCount(baseFilter: Record<string, unknown>): Promise<number> {
    const key = JSON.stringify(baseFilter, (_field, value) => (value instanceof RegExp ? value.toString() : value));
    const now = Date.now();
    const cached = countCache.get(key);
    if (cached && now - cached.at < COUNT_TTL_MS) return cached.total;
    const total = await LaunchModel.countDocuments(baseFilter);
    countCache.set(key, { total, at: now });
    if (countCache.size > 200) {
      const oldest = countCache.keys().next().value;
      if (oldest !== undefined) countCache.delete(oldest);
    }
    return total;
  }

  async getPage({ cursor, limit, search, poolType, minLiquidityUsd, minVolumeUsd, createdWithinDays, sort }: { cursor?: string; limit: number; search?: string; poolType?: PoolType; minLiquidityUsd?: number; minVolumeUsd?: number; createdWithinDays?: number; sort: LaunchSort }): Promise<LaunchPage> {
    const baseFilter: Record<string, unknown> = { dex: this.dexId };
    if (poolType && poolType !== "all") baseFilter.poolType = poolType;
    if (minLiquidityUsd != null) baseFilter.liquidityUsd = { $gte: minLiquidityUsd };
    if (minVolumeUsd != null) baseFilter.volumeUsd = { $gte: minVolumeUsd };
    // UI-driven token-age filter; pools with unknown creation time are excluded when set.
    if (createdWithinDays != null) baseFilter.tokenAgeAtLaunchHours = { $ne: null, $lte: createdWithinDays * 24 };
    if (search) {
      const pattern = new RegExp(this.escapeRegExp(search), "i");
      baseFilter.$or = [{ pair: pattern }, { creator: pattern }, { poolAddress: pattern }];
    }
    const sortDefinition = this.getSortDefinition(sort);
    const filter = cursor
      ? { $and: [baseFilter, this.getCursorFilter(cursor, sort)] }
      : baseFilter;

    const [items, total] = await Promise.all([
      LaunchModel.find(filter).sort(sortDefinition).limit(limit + 1).lean<Launch[]>(),
      this.getCachedCount(baseFilter)
    ]);
    const hasMore = items.length > limit;
    const pageItems = items.slice(0, limit);
    const lastItem = pageItems.at(-1);

    return {
      items: pageItems,
      nextCursor: hasMore && lastItem ? this.encodeCursor(lastItem, sort) : null,
      total
    };
  }

  async getByCreator(creator: string): Promise<Launch[]> {
    return LaunchModel.find({ dex: this.dexId, creator }).sort({ blockNumber: -1 }).lean<Launch[]>();
  }

  async getCreatorsPage({ cursor, limit, search, sort }: { cursor?: string; limit: number; search?: string; sort: CreatorSort }): Promise<CreatorPage> {
    const matchStage: Record<string, unknown> = { dex: this.dexId };
    if (search) matchStage.creator = new RegExp(this.escapeRegExp(search), "i");

    const groupStage = {
      $group: {
        _id: "$creator",
        launchCount: { $sum: 1 },
        firstLaunchAt: { $min: "$createdAt" },
        lastLaunchAt: { $max: "$createdAt" }
      }
    };
    const projectStage = {
      $project: {
        _id: 0,
        address: "$_id",
        launchCount: 1,
        firstLaunchAt: 1,
        lastLaunchAt: 1
      }
    };
    const sortDefinition = this.getCreatorSortDefinition(sort);
    const baseStages = [
      { $match: matchStage },
      groupStage,
      projectStage
    ];

    const [countResult, items] = await Promise.all([
      LaunchModel.aggregate<{ total: number }>([...baseStages, { $count: "total" }]),
      LaunchModel.aggregate<CreatorSummary>([
        ...baseStages,
        ...(cursor ? [{ $match: this.getCreatorCursorFilter(cursor, sort) }] : []),
        { $sort: sortDefinition },
        { $limit: limit + 1 }
      ])
    ]);

    const total = countResult[0]?.total ?? 0;
    const hasMore = items.length > limit;
    const pageItems = items.slice(0, limit);
    const lastItem = pageItems.at(-1);

    return {
      items: pageItems,
      nextCursor: hasMore && lastItem ? this.encodeCreatorCursor(lastItem, sort) : null,
      total
    };
  }

  async getDailyAnalytics(days: number): Promise<LaunchDailyAnalytics> {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));
    const sinceIso = since.toISOString();

    const aggregated = await LaunchModel.aggregate<DailyAnalyticsPoint>([
      { $match: { dex: this.dexId, createdAt: { $gte: sinceIso } } },
      {
        $group: {
          _id: { $substr: ["$createdAt", 0, 10] },
          launchCount: { $sum: 1 },
          volumeUsd: { $sum: { $ifNull: ["$volumeUsd", 0] } }
        }
      },
      { $sort: { _id: 1 } },
      {
        $project: {
          _id: 0,
          date: "$_id",
          launchCount: 1,
          volumeUsd: 1
        }
      }
    ]);

    return { days, points: this.fillDailyPoints(days, aggregated) };
  }

  // Headline "today" metrics over pools launched in the last 24h (per DEX).
  async getStats(): Promise<LaunchStats> {
    const dayAgoIso = new Date(Date.now() - 86_400_000).toISOString();

    const [summary] = await LaunchModel.aggregate<Omit<LaunchStats, "minVolumeUsd">>([
      { $match: { dex: this.dexId, createdAt: { $gte: dayAgoIso } } },
      {
        $group: {
          _id: null,
          dayLaunchCount: { $sum: 1 },
          dayVolumeUsd: { $sum: { $ifNull: ["$volumeUsd", 0] } },
          dayRealVolumeUsd: { $sum: { $ifNull: ["$externalVolumeUsd", 0] } },
          dayLaunchCountMinVolume: { $sum: { $cond: [{ $gte: [{ $ifNull: ["$volumeUsd", 0] }, STATS_MIN_VOLUME_USD] }, 1, 0] } },
          creators: { $addToSet: "$creator" }
        }
      },
      {
        $project: {
          _id: 0,
          dayVolumeUsd: 1,
          dayRealVolumeUsd: 1,
          dayLaunchCount: 1,
          dayLaunchCountMinVolume: 1,
          dayActiveCreators: { $size: "$creators" }
        }
      }
    ]);

    return {
      ...(summary ?? { dayVolumeUsd: 0, dayRealVolumeUsd: 0, dayLaunchCount: 0, dayLaunchCountMinVolume: 0, dayActiveCreators: 0 }),
      minVolumeUsd: STATS_MIN_VOLUME_USD
    };
  }

  async getByPoolAddress(poolAddress: string): Promise<Launch | null> {
    return LaunchModel.findOne({ dex: this.dexId, poolAddress }).lean<Launch | null>();
  }

  // Persisted monitoring toggle. Absent doc (fresh DB) defaults to enabled, matching the
  // historical behaviour where every live DEX started indexing on boot.
  async getMonitorEnabled(defaultEnabled = true): Promise<boolean> {
    const doc = await IndexerControlModel.findById(this.dexId).lean<IndexerControl | null>();
    return doc?.enabled ?? defaultEnabled;
  }

  async setMonitorEnabled(enabled: boolean): Promise<void> {
    await IndexerControlModel.updateOne(
      { _id: this.dexId },
      { $set: { enabled } },
      { upsert: true }
    );
  }

  // Persisted indexer status snapshot (chain tip, last sync/error, refresh throttles), so the
  // runtime status and throttles survive a restart instead of resetting to zero.
  async getIndexerStatus(): Promise<IndexerStatusState | null> {
    return IndexerStatusModel.findById(this.dexId).lean<IndexerStatusState | null>();
  }

  async saveIndexerStatus(patch: Partial<Omit<IndexerStatusState, "_id">>): Promise<void> {
    await IndexerStatusModel.updateOne({ _id: this.dexId }, { $set: patch }, { upsert: true });
  }

  async getIndexedBlock(defaultBlock: number): Promise<number> {
    const state = await IndexStateModel.findById(this.indexStateId).lean<IndexState | null>();
    return state?.indexedBlock ?? defaultBlock;
  }

  async prepareIndexingStart(startBlock: number): Promise<void> {
    const state = await IndexStateModel.findById(this.indexStateId).lean<IndexState | null>();
    if (state?.version !== INDEX_VERSION) {
      await LaunchModel.deleteMany({ dex: this.dexId });
      // The default adapter also clears pre-multi-DEX docs (saved before the `dex` field).
      if (this.cleanupLegacy) await LaunchModel.deleteMany({ dex: { $exists: false } });
      await IndexStateModel.updateOne(
        { _id: this.indexStateId },
        { $set: { indexedBlock: startBlock - 1, version: INDEX_VERSION } },
        { upsert: true }
      );
      return;
    }

    await LaunchModel.deleteMany({ dex: this.dexId, blockNumber: { $lt: startBlock } });
    await IndexStateModel.updateOne(
      { _id: this.indexStateId },
      { $max: { indexedBlock: startBlock - 1 }, $set: { version: INDEX_VERSION } },
      { upsert: true }
    );
  }

  async saveChunk(launches: Launch[], indexedBlock: number): Promise<void> {
    if (launches.length) {
      await LaunchModel.bulkWrite(
        launches.map((launch) => ({
          updateOne: {
            filter: { poolAddress: launch.poolAddress },
            update: { $set: launch },
            upsert: true
          }
        }))
      );
    }

    // Advance only after launch upserts succeed. Replaying a chunk after a crash is safe.
    await IndexStateModel.updateOne(
      { _id: this.indexStateId },
      { $set: { indexedBlock } },
      { upsert: true }
    );
  }

  async getLaunchesForMarketData(limit: number): Promise<Launch[]> {
    const staleBefore = new Date(Date.now() - 5 * 60_000).toISOString();
    return LaunchModel.find({
      dex: this.dexId,
      createdAt: { $gte: this.monitorCutoffIso },
      $or: [
        { marketDataUpdatedAt: null },
        { marketDataUpdatedAt: { $exists: false } },
        { marketDataUpdatedAt: { $lt: staleBefore } }
      ]
    })
      .sort({ marketDataUpdatedAt: 1, blockNumber: -1 })
      .limit(limit)
      .lean<Launch[]>();
  }

  // Launches with real volume worth analyzing whose attendee intel is missing or stale.
  // Never-analyzed launches come first, then highest-volume; funding never changes, so a
  // generous staleness window suffices.
  async getLaunchesForIntel(limit: number): Promise<Launch[]> {
    const staleBefore = new Date(Date.now() - 30 * 60_000).toISOString();
    return LaunchModel.find({
      dex: this.dexId,
      createdAt: { $gte: this.monitorCutoffIso },
      volumeUsd: { $gt: 0 },
      $or: [
        { intelUpdatedAt: null },
        { intelUpdatedAt: { $exists: false } },
        { intelUpdatedAt: { $lt: staleBefore } }
      ]
    })
      .sort({ intelUpdatedAt: 1, volumeUsd: -1 })
      .limit(limit)
      .lean<Launch[]>();
  }

  async saveMarketData(data: MarketData): Promise<void> {
    await LaunchModel.updateOne({ poolAddress: data.poolAddress }, { $set: data });
  }

  // ---- Attendee intelligence: wallet funding cache, funder out-degree, reports ----

  async getWalletFundings(addresses: string[]): Promise<Map<string, WalletFunding>> {
    if (!addresses.length) return new Map();
    const rows = await WalletFundingModel.find({ address: { $in: addresses } }).lean<WalletFunding[]>();
    return new Map(rows.map((row) => [row.address, row]));
  }

  async saveWalletFundings(records: WalletFunding[]): Promise<void> {
    if (!records.length) return;
    await WalletFundingModel.bulkWrite(records.map((record) => ({
      updateOne: { filter: { address: record.address }, update: { $set: record }, upsert: true }
    })));
  }

  // How many distinct cached wallets each funder has seeded across ALL its funding edges —
  // high counts mark public dispersers (CEX/bridge/disperse contracts), which must not be
  // treated as a sybil link. Falls back to the legacy scalar funder for pre-graph docs.
  async getFunderCounts(funders: string[]): Promise<Map<string, number>> {
    if (!funders.length) return new Map();
    const rows = await WalletFundingModel.aggregate<{ _id: string; count: number }>([
      // Index-usable pre-filter; the project/unwind below then counts only matching edges.
      { $match: { $or: [{ "funders.from": { $in: funders } }, { fundingSource: { $in: funders } }] } },
      {
        $project: {
          address: 1,
          edges: {
            $cond: [
              { $gt: [{ $size: { $ifNull: ["$funders", []] } }, 0] },
              "$funders.from",
              { $cond: [{ $ifNull: ["$fundingSource", false] }, ["$fundingSource"], []] }
            ]
          }
        }
      },
      { $unwind: "$edges" },
      { $match: { edges: { $in: funders } } },
      { $group: { _id: "$edges", wallets: { $addToSet: "$address" } } },
      { $project: { count: { $size: "$wallets" } } }
    ]);
    return new Map(rows.map((row) => [row._id, row.count]));
  }

  // Every cached wallet whose funding graph includes one of `funders` as a direct source —
  // i.e. the wallets these addresses funded. The reverse of getWalletFundings, served from
  // the multikey "funders.from" index, so the research panel can walk outgoing edges for free
  // once a bot's recipients have been investigated by prior launch analyses.
  async getWalletsFundedBy(funders: string[]): Promise<{ address: string; funder: string; via: "external" | "internal"; txHash: string | null }[]> {
    if (!funders.length) return [];
    const funderSet = new Set(funders.map((funder) => funder.toLowerCase()));
    const rows = await WalletFundingModel.find({ "funders.from": { $in: [...funderSet] } }).lean<WalletFunding[]>();
    const edges: { address: string; funder: string; via: "external" | "internal"; txHash: string | null }[] = [];
    for (const row of rows) {
      const inflows: FundingInflow[] = row.funders?.length
        ? row.funders
        : row.fundingSource
          ? [{ from: row.fundingSource, via: "external", txHash: row.fundingTxHash ?? "", value: "0", timeStamp: 0 }]
          : [];
      for (const inflow of inflows) {
        if (funderSet.has(inflow.from)) edges.push({ address: row.address, funder: inflow.from, via: inflow.via, txHash: inflow.txHash || null });
      }
    }
    return edges;
  }

  // ---- Manual wallet labels (rug bots / watchlist) ----

  async getWalletLabels(): Promise<WalletLabel[]> {
    return WalletLabelModel.find().sort({ createdAt: -1 }).lean<WalletLabel[]>();
  }

  async getWalletLabelMap(): Promise<Map<string, WalletLabelKind>> {
    const rows = await WalletLabelModel.find().lean<WalletLabel[]>();
    return new Map(rows.map((row) => [row.address.toLowerCase(), row.kind]));
  }

  async getAddressesByLabel(kind: WalletLabelKind): Promise<string[]> {
    const rows = await WalletLabelModel.find({ kind }).lean<WalletLabel[]>();
    return rows.map((row) => row.address.toLowerCase());
  }

  async setWalletLabel(address: string, kind: WalletLabelKind, note: string | null): Promise<WalletLabel> {
    const record: WalletLabel = { address: address.toLowerCase(), kind, note, createdAt: new Date().toISOString() };
    await WalletLabelModel.updateOne(
      { address: record.address },
      { $set: { kind: record.kind, note: record.note }, $setOnInsert: { createdAt: record.createdAt } },
      { upsert: true }
    );
    return (await WalletLabelModel.findOne({ address: record.address }).lean<WalletLabel | null>()) ?? record;
  }

  async removeWalletLabel(address: string): Promise<void> {
    await WalletLabelModel.deleteOne({ address: address.toLowerCase() });
  }

  // Real-trader (tx signer) cache. Hash -> signing EOA never changes, so it is cached forever.
  async getTxSenders(hashes: string[]): Promise<Map<string, string>> {
    if (!hashes.length) return new Map();
    const rows = await TxSenderModel.find({ _id: { $in: hashes } }).lean<TxSenderState[]>();
    return new Map(rows.map((row) => [row._id, row.from]));
  }

  async saveTxSenders(records: { hash: string; from: string }[]): Promise<void> {
    if (!records.length) return;
    await TxSenderModel.bulkWrite(records.map((record) => ({
      updateOne: { filter: { _id: record.hash }, update: { $set: { from: record.from } }, upsert: true }
    })));
  }

  async getAttendeeReport(poolAddress: string): Promise<AttendeeReport | null> {
    return AttendeeReportModel.findOne({ dex: this.dexId, poolAddress }).lean<AttendeeReport | null>();
  }

  async saveAttendeeReport(report: AttendeeReport): Promise<void> {
    await AttendeeReportModel.updateOne({ poolAddress: report.poolAddress }, { $set: report }, { upsert: true });
  }

  // Persist the list-wide intel aggregates onto the launch for sorting/filtering.
  async saveLaunchIntel(poolAddress: string, intel: Partial<Launch>): Promise<void> {
    await LaunchModel.updateOne({ poolAddress }, { $set: intel });
  }

  async getTokenCreation(address: string): Promise<TokenCreation | null> {
    return TokenCreationModel.findOne({ address }).lean<TokenCreation | null>();
  }

  async saveTokenCreation(tokenCreation: TokenCreation): Promise<void> {
    await TokenCreationModel.updateOne(
      { address: tokenCreation.address },
      { $set: tokenCreation },
      { upsert: true }
    );
  }

  private encodeCursor(launch: Launch, sort: LaunchSort): string {
    const value = sort === "liquidity"
      ? launch.liquidityUsd ?? -1
      : sort === "volume"
        ? launch.volumeUsd ?? -1
        : sort === "realVolume"
          ? launch.externalVolumeUsd ?? -1
          : launch.blockNumber;
    return Buffer.from(JSON.stringify({ value, id: launch.id })).toString("base64url");
  }

  private decodeCursor(cursor: string): { value: number; id: string } {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { value?: number; id?: string };
    if (typeof value.value !== "number" || !value.id) throw new Error("Invalid launch cursor");
    return { value: value.value, id: value.id };
  }

  private getCursorFilter(cursor: string, sort: LaunchSort): Record<string, unknown> {
    const { value, id } = this.decodeCursor(cursor);
    const field = sort === "liquidity" ? "liquidityUsd" : sort === "volume" ? "volumeUsd" : sort === "realVolume" ? "externalVolumeUsd" : "blockNumber";
    const operator = sort === "oldest" ? "$gt" : "$lt";
    return { $or: [{ [field]: { [operator]: value } }, { [field]: value, id: { $lt: id } }] };
  }

  private getSortDefinition(sort: LaunchSort): Record<string, 1 | -1> {
    if (sort === "oldest") return { blockNumber: 1, id: -1 };
    if (sort === "liquidity") return { liquidityUsd: -1, id: -1 };
    if (sort === "volume") return { volumeUsd: -1, id: -1 };
    if (sort === "realVolume") return { externalVolumeUsd: -1, id: -1 };
    return { blockNumber: -1, id: -1 };
  }

  private fillDailyPoints(days: number, aggregated: DailyAnalyticsPoint[]): DailyAnalyticsPoint[] {
    const byDate = new Map(aggregated.map((point) => [point.date, point]));
    const end = new Date();
    end.setUTCHours(0, 0, 0, 0);
    const points: DailyAnalyticsPoint[] = [];

    for (let offset = days - 1; offset >= 0; offset -= 1) {
      const date = new Date(end);
      date.setUTCDate(date.getUTCDate() - offset);
      const key = date.toISOString().slice(0, 10);
      points.push(byDate.get(key) ?? { date: key, launchCount: 0, volumeUsd: 0 });
    }

    return points;
  }

  private escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private encodeCreatorCursor(creator: CreatorSummary, sort: CreatorSort): string {
    const value = sort === "oldest"
      ? creator.firstLaunchAt
      : sort === "newest"
        ? creator.lastLaunchAt
        : creator.launchCount;
    return Buffer.from(JSON.stringify({ value, address: creator.address })).toString("base64url");
  }

  private decodeCreatorCursor(cursor: string): { value: string | number; address: string } {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { value?: string | number; address?: string };
    if ((typeof parsed.value !== "string" && typeof parsed.value !== "number") || !parsed.address) {
      throw new Error("Invalid creator cursor");
    }
    return { value: parsed.value, address: parsed.address };
  }

  private getCreatorCursorFilter(cursor: string, sort: CreatorSort): Record<string, unknown> {
    const { value, address } = this.decodeCreatorCursor(cursor);
    const field = sort === "oldest" ? "firstLaunchAt" : sort === "newest" ? "lastLaunchAt" : "launchCount";
    const operator = sort === "oldest" ? "$gt" : "$lt";
    return { $or: [{ [field]: { [operator]: value } }, { [field]: value, address: { $lt: address } }] };
  }

  private getCreatorSortDefinition(sort: CreatorSort): Record<string, 1 | -1> {
    if (sort === "oldest") return { firstLaunchAt: 1, address: -1 };
    if (sort === "newest") return { lastLaunchAt: -1, address: -1 };
    return { launchCount: -1, address: -1 };
  }
}
