import type { LaunchAnalyzer } from "./LaunchAnalyzer.js";
import type { LaunchRepository } from "./LaunchRepository.js";
import type { MarketDataService } from "./MarketDataService.js";

export interface LaunchIndexerStatus {
  // Whether the periodic indexing loop is active (toggled by start()/stop()).
  enabled: boolean;
  // Whether a sync is executing right now.
  isRunning: boolean;
  indexedBlock: number | null;
  latestBlock: number | null;
  // ISO timestamp of the last completed sync, persisted so it survives a restart.
  lastSyncAt: string | null;
  error: string | null;
}

interface LaunchIndexerOptions {
  analyzer: LaunchAnalyzer;
  repository: LaunchRepository;
  marketDataService: MarketDataService;
  startBlock: number;
  blockChunk: number;
  intervalMs?: number;
  // Whether this DEX indexes on a fresh boot (no persisted on/off choice). Only the default
  // DEX is true, so a clean install runs one indexer instead of all of them on one limiter.
  defaultEnabled?: boolean;
}

export class LaunchIndexer {
  readonly status: LaunchIndexerStatus = {
    enabled: false,
    isRunning: false,
    indexedBlock: null,
    latestBlock: null,
    lastSyncAt: null,
    error: null
  };

  private readonly analyzer: LaunchAnalyzer;
  private readonly repository: LaunchRepository;
  private readonly marketDataService: MarketDataService;
  private readonly startBlock: number;
  private readonly blockChunk: number;
  private readonly intervalMs: number;
  private readonly defaultEnabled: boolean;
  private timer?: NodeJS.Timeout;
  private activeSync?: Promise<void>;
  private lastMarketRefreshAt = 0;
  private lastIntelRefreshAt = 0;

  constructor({ analyzer, repository, marketDataService, startBlock, blockChunk, intervalMs = 15_000, defaultEnabled = false }: LaunchIndexerOptions) {
    this.analyzer = analyzer;
    this.repository = repository;
    this.marketDataService = marketDataService;
    this.startBlock = startBlock;
    this.blockChunk = blockChunk;
    this.intervalMs = intervalMs;
    this.defaultEnabled = defaultEnabled;
  }

  start(persist = true): void {
    this.status.enabled = true;
    if (persist) void this.repository.setMonitorEnabled(true).catch(() => {});
    void this.sync();
    this.timer ??= setInterval(() => void this.sync(), this.intervalMs);
  }

  // Stops the periodic loop (no new syncs scheduled). An in-flight sync finishes; this
  // halts the DEX's recurring RPC/Etherscan usage so the budget can focus on other DEXes.
  stop(persist = true): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.status.enabled = false;
    if (persist) void this.repository.setMonitorEnabled(false).catch(() => {});
  }

  // Restore the persisted on/off choice on boot. Starts the loop only if monitoring was
  // left enabled; passes persist=false so reading the stored flag doesn't rewrite it.
  async resume(): Promise<void> {
    await this.restoreStatus();
    // With no persisted choice, only the default DEX starts — a fresh boot runs one indexer
    // on the shared Etherscan limiter rather than all of them at once.
    if (await this.repository.getMonitorEnabled(this.defaultEnabled)) this.start(false);
  }

  // Rehydrate the in-memory status and refresh throttles from the persisted snapshot, so a
  // restart resumes from the last scanned block and doesn't immediately re-refresh launches
  // that were analyzed moments before shutdown.
  private async restoreStatus(): Promise<void> {
    this.status.indexedBlock = await this.repository.getIndexedBlock(this.startBlock - 1);
    const persisted = await this.repository.getIndexerStatus();
    if (!persisted) return;
    this.status.latestBlock = persisted.latestBlock;
    this.status.lastSyncAt = persisted.lastSyncAt;
    this.status.error = persisted.error;
    this.lastMarketRefreshAt = persisted.lastMarketRefreshAt;
    this.lastIntelRefreshAt = persisted.lastIntelRefreshAt;
  }

  sync(): Promise<void> {
    this.activeSync ??= this.run().finally(() => {
      this.activeSync = undefined;
    });
    return this.activeSync;
  }

  private async run(): Promise<void> {
    this.status.isRunning = true;
    this.status.error = null;

    try {
      const latestBlock = await this.analyzer.getLatestBlock();
      await this.repository.prepareIndexingStart(this.startBlock);
      let indexedBlock = await this.repository.getIndexedBlock(this.startBlock - 1);
      this.status.latestBlock = latestBlock;
      this.status.indexedBlock = indexedBlock;

      while (indexedBlock < latestBlock) {
        const toBlock = Math.min(indexedBlock + this.blockChunk, latestBlock);
        const launches = await this.analyzer.getLaunchesInBlockRange(indexedBlock + 1, toBlock);
        await this.repository.saveChunk(launches, toBlock);
        indexedBlock = toBlock;
        this.status.indexedBlock = indexedBlock;
        await this.refreshMarketData(20);
      }
      await this.refreshMarketData(20);
      await this.refreshIntel();
      this.status.lastSyncAt = new Date().toISOString();
      await this.repository.saveIndexerStatus({ latestBlock, lastSyncAt: this.status.lastSyncAt, error: null });
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.status.error = message;
      void this.repository.saveIndexerStatus({ error: message }).catch(() => {});
      if (this.isTimeoutError(error)) {
        console.warn(`Launch indexing delayed: ${message}. Retrying on the next sync.`);
      } else {
        console.error(`Launch indexing failed: ${message}`);
      }
    } finally {
      this.status.isRunning = false;
    }
  }

  async refreshMarketData(limit = 20, force = false): Promise<number> {
    if (!force && Date.now() - this.lastMarketRefreshAt < 5_000) return 0;
    this.lastMarketRefreshAt = Date.now();
    void this.repository.saveIndexerStatus({ lastMarketRefreshAt: this.lastMarketRefreshAt }).catch(() => {});

    const launches = await this.repository.getLaunchesForMarketData(limit);
    if (!launches.length) return 0;

    try {
      const results = await this.marketDataService.getForLaunches(launches);
      for (const data of results) await this.repository.saveMarketData(data);
      return results.length;
    } catch (error) {
      console.warn(`Market data refresh failed: ${this.getErrorMessage(error)}`);
      throw error;
    }
  }

  // Backfill attendee intelligence (real/external volume + sybil clusters) for a few
  // launches per cycle, highest-volume first. Funding lookups are cached globally, so the
  // marginal cost falls sharply as the same bot wallets reappear across launches.
  async refreshIntel(limit = 4, force = false): Promise<number> {
    if (!force && Date.now() - this.lastIntelRefreshAt < 30_000) return 0;
    this.lastIntelRefreshAt = Date.now();
    void this.repository.saveIndexerStatus({ lastIntelRefreshAt: this.lastIntelRefreshAt }).catch(() => {});

    const launches = await this.repository.getLaunchesForIntel(limit);
    if (!launches.length) return 0;

    let analyzed = 0;
    // Sequential: each launch already fans many funding lookups onto the shared Etherscan
    // limiter, so running launches one at a time keeps the request stream orderly.
    for (const launch of launches) {
      try {
        const analysis = await this.marketDataService.analyzeAttendees(launch);
        if (!analysis) continue;
        await this.repository.saveLaunchIntel(launch.poolAddress, analysis.intel);
        await this.repository.saveAttendeeReport(analysis.report);
        analyzed += 1;
      } catch (error) {
        console.warn(`Attendee intel failed for ${launch.poolAddress}: ${this.getErrorMessage(error)}`);
      }
    }
    return analyzed;
  }

  // On-demand deep analysis for one launch (the UI's attendee panel), with a larger lookup
  // budget since a user is waiting. Returns whether a report was produced.
  async analyzeLaunchNow(poolAddress: string): Promise<boolean> {
    const launch = await this.repository.getByPoolAddress(poolAddress);
    if (!launch) throw new Error("Launch not found");
    const analysis = await this.marketDataService.analyzeAttendees(launch, { maxNewLookups: 150 });
    if (!analysis) return false;
    await this.repository.saveLaunchIntel(launch.poolAddress, analysis.intel);
    await this.repository.saveAttendeeReport(analysis.report);
    return true;
  }

  private getErrorMessage(error: unknown): string {
    if (this.isTimeoutError(error)) return "RPC request timed out";
    return error instanceof Error ? error.message : "Unknown error";
  }

  private isTimeoutError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return code === "TIMEOUT" || error.message.toLowerCase().includes("request timeout");
  }
}
