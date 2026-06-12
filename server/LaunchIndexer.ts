import type { LaunchAnalyzer } from "./LaunchAnalyzer.js";
import type { LaunchRepository } from "./LaunchRepository.js";
import type { MarketDataService } from "./MarketDataService.js";

export interface LaunchIndexerStatus {
  isRunning: boolean;
  indexedBlock: number | null;
  latestBlock: number | null;
  error: string | null;
}

interface LaunchIndexerOptions {
  analyzer: LaunchAnalyzer;
  repository: LaunchRepository;
  marketDataService: MarketDataService;
  startBlock: number;
  blockChunk: number;
  intervalMs?: number;
}

export class LaunchIndexer {
  readonly status: LaunchIndexerStatus = {
    isRunning: false,
    indexedBlock: null,
    latestBlock: null,
    error: null
  };

  private readonly analyzer: LaunchAnalyzer;
  private readonly repository: LaunchRepository;
  private readonly marketDataService: MarketDataService;
  private readonly startBlock: number;
  private readonly blockChunk: number;
  private readonly intervalMs: number;
  private timer?: NodeJS.Timeout;
  private activeSync?: Promise<void>;
  private lastMarketRefreshAt = 0;

  constructor({ analyzer, repository, marketDataService, startBlock, blockChunk, intervalMs = 15_000 }: LaunchIndexerOptions) {
    this.analyzer = analyzer;
    this.repository = repository;
    this.marketDataService = marketDataService;
    this.startBlock = startBlock;
    this.blockChunk = blockChunk;
    this.intervalMs = intervalMs;
  }

  start(): void {
    void this.sync();
    this.timer ??= setInterval(() => void this.sync(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
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
    } catch (error) {
      const message = this.getErrorMessage(error);
      this.status.error = message;
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
