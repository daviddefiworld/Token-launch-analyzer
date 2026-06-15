import { Contract, formatEther, formatUnits, type Block, type Filter, type Log } from "ethers";
import { buildDemoAttendeeReport, buildDemoCreator, buildDemoCreators, buildDemoDailyAnalytics, buildDemoTrades, demoLaunches } from "./demoData.js";
import type { AttendeeReport, CreatorPage, CreatorProfile, CreatorSort, Launch, LaunchDailyAnalytics, LaunchPage, LaunchSort, LaunchStats, PoolType, RpcUsage, TokenCreation, Trade } from "../types.js";
import type { LaunchRepository } from "./LaunchRepository.js";
import type { EtherscanService } from "./EtherscanService.js";
import type { PriceService } from "./PriceService.js";
import type { RpcMetricsProvider } from "./RpcMetricsProvider.js";
import { resolveTxTraders } from "./txTraders.js";
import type { WalletIntelService } from "./WalletIntelService.js";
import { getQuoteToken, isKnownQuote, isQuoteToken0, type DexAdapter } from "./skills/DexAdapter.js";

interface AnalyzerOptions {
  adapter: DexAdapter;
  provider?: RpcMetricsProvider | null;
  etherscan?: EtherscanService | null;
  priceService?: PriceService | null;
  logChunk?: string | number;
  repository?: LaunchRepository | null;
}

const FIRST_TRADE_SCAN_BLOCKS = 100_000;

// Generic ERC20 metadata reads, shared by every DEX adapter.
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

interface LogRange extends Filter {
  fromBlock: number;
  toBlock: number;
}

interface FundingDetails {
  firstFundedAt: string | null;
  fundingSource: string | null;
  fundingAmount: string | null;
}

interface TradeQuote {
  quoteIsToken0: boolean;
  quoteDecimals: number;
  quotePriceUsd: number | null;
}

// DEX-agnostic launch analyzer. All chain-specific decoding (factory/pool events, swap
// math, reserves, quote tokens) is delegated to the injected DexAdapter, so one instance
// exists per supported DEX.
export class LaunchAnalyzer {
  readonly adapter: DexAdapter;
  provider: RpcMetricsProvider | null;
  etherscan: EtherscanService | null;
  priceService: PriceService | null;
  logChunk: number;
  repository: LaunchRepository | null;
  // Assigned after construction (in live mode) so creator funding uses the shared cache.
  walletIntel: WalletIntelService | null = null;
  private readonly blocks = new Map<number, Block>();
  private readonly tokenSymbols = new Map<string, string>();
  private readonly tokenDecimals = new Map<string, number>();
  private readonly poolMetadata = new Map<string, { quoteAddress: string; quoteIsToken0: boolean; quoteDecimals: number }>();

  constructor({ adapter, provider = null, etherscan = null, priceService = null, logChunk = 2000, repository = null }: AnalyzerOptions) {
    this.adapter = adapter;
    this.provider = provider;
    this.etherscan = etherscan;
    this.priceService = priceService;
    this.logChunk = Number(logChunk);
    this.repository = repository;
  }

  get dexId(): string {
    return this.adapter.id;
  }

  get mode(): "demo" | "live" {
    return this.provider ? "live" : "demo";
  }

  async getLaunches(options: { cursor?: string; limit: number; search?: string; poolType?: PoolType; minLiquidityUsd?: number; minVolumeUsd?: number; createdWithinDays?: number; sort: LaunchSort }): Promise<LaunchPage> {
    if (!this.provider) {
      const items = this.#demoLaunches();
      return { items: items.slice(0, options.limit), nextCursor: null, total: items.length };
    }
    return this.#requireRepository().getPage(options);
  }

  async getLatestBlock(): Promise<number> {
    return this.#requireProvider().getBlockNumber();
  }

  async getLaunchStats(): Promise<LaunchStats> {
    if (!this.provider) {
      // Demo data is dated in the past, so treat the whole demo set as "today".
      const launches = this.#demoLaunches();
      const minVolumeUsd = 100;
      return {
        dayVolumeUsd: launches.reduce((sum, launch) => sum + (launch.volumeUsd ?? 0), 0),
        dayRealVolumeUsd: launches.reduce((sum, launch) => sum + (launch.externalVolumeUsd ?? 0), 0),
        dayLaunchCount: launches.length,
        dayLaunchCountMinVolume: launches.filter((launch) => (launch.volumeUsd ?? 0) >= minVolumeUsd).length,
        dayActiveCreators: new Set(launches.map((launch) => launch.creator)).size,
        minVolumeUsd
      };
    }
    return this.#requireRepository().getStats();
  }

  async getDailyAnalytics(days: number): Promise<LaunchDailyAnalytics> {
    if (!this.provider) return buildDemoDailyAnalytics(days, this.#demoLaunches());
    return this.#requireRepository().getDailyAnalytics(days);
  }

  getRpcUsage(): RpcUsage {
    return this.provider?.getUsage() ?? { totalCalls: 0, totalErrors: 0, startedAt: new Date().toISOString(), methods: [] };
  }

  async getLaunchesInBlockRange(fromBlock: number, toBlock: number): Promise<Launch[]> {
    const logs = await this.#requireProvider().getLogs({
      address: this.adapter.factoryAddress,
      topics: [this.adapter.factoryInterface.getEvent(this.adapter.launchEventName)!.topicHash],
      fromBlock,
      toBlock
    });
    const launches = await Promise.all(logs.map((log) => this.#toLaunch(log)));
    return launches.filter((launch): launch is Launch => launch != null);
  }

  async getCreator(address: string): Promise<CreatorProfile> {
    if (!this.provider) return buildDemoCreator(address, this.#demoLaunches());
    const previousLaunches = await this.#requireRepository().getByCreator(address);
    const funding = await this.#getFirstFunding(address);
    return {
      address,
      ...funding,
      launchCount: previousLaunches.length,
      previousLaunches,
      labels: previousLaunches.length > 1 ? ["repeat creator"] : ["first observed launch"]
    };
  }

  async getCreators(options: { cursor?: string; limit: number; search?: string; sort: CreatorSort }): Promise<CreatorPage> {
    if (!this.provider) return this.#getDemoCreators(options);
    return this.#requireRepository().getCreatorsPage(options);
  }

  async getLaunch(poolAddress: string): Promise<Launch | null> {
    if (this.provider) return this.#requireRepository().getByPoolAddress(poolAddress);
    return this.#demoLaunches().find((item) => item.poolAddress.toLowerCase() === poolAddress.toLowerCase()) ?? null;
  }

  async getFirstTrades(poolAddress: string): Promise<Trade[]> {
    const launch = this.provider
      ? await this.#requireRepository().getByPoolAddress(poolAddress)
      : this.#demoLaunches().find((item) => item.poolAddress.toLowerCase() === poolAddress.toLowerCase());
    if (!launch) throw new Error("Launch not found");
    if (!this.provider) return buildDemoTrades(launch);
    if (this.etherscan) return this.#getTradesFromEtherscan(launch);
    return this.#getTradesFromRpc(launch);
  }

  #demoLaunches(): Launch[] {
    return demoLaunches.filter((launch) => launch.dex === this.adapter.id);
  }

  // Preferred path: pull the first 100 swap transactions straight from BaseScan
  // (one call, ascending order, timestamps included) and value each in real USD.
  async #getTradesFromEtherscan(launch: Launch): Promise<Trade[]> {
    const quote = await this.#resolveTradeQuote(launch);
    const logs = await this.etherscan!.getLogs({
      address: launch.poolAddress,
      topic0: this.adapter.poolInterface.getEvent(this.adapter.swapEventName)!.topicHash,
      fromBlock: launch.blockNumber,
      toBlock: 99_999_999,
      offset: 100,
      maxPages: 1,
      // We only ever want the first 100 trades, so hitting the cap here is by design.
      warnOnCap: false
    });
    const page = logs.slice(0, 100);
    const traderByTx = await resolveTxTraders(page.map((log) => log.transactionHash), this.repository, this.provider);
    return page.map((log, index) => this.#buildTrade({
      topics: log.topics,
      data: log.data,
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      timestampMs: log.timeStamp * 1000,
      rank: index + 1,
      quote,
      trader: traderByTx.get(log.transactionHash.toLowerCase())
    }));
  }

  // Fallback when no BaseScan key is configured: scan swap logs over RPC.
  async #getTradesFromRpc(launch: Launch): Promise<Trade[]> {
    const latestBlock = Math.min(await this.provider!.getBlockNumber(), launch.blockNumber + FIRST_TRADE_SCAN_BLOCKS);
    const logs = await this.#getLogsInChunks(
      {
        address: launch.poolAddress,
        topics: [this.adapter.poolInterface.getEvent(this.adapter.swapEventName)!.topicHash],
        fromBlock: launch.blockNumber,
        toBlock: latestBlock
      },
      100
    );
    const quote = await this.#resolveTradeQuote(launch);
    const blocks = new Map<number, Block>();
    await Promise.all([...new Set(logs.map((log) => log.blockNumber))].map(async (blockNumber) => {
      blocks.set(blockNumber, await this.#getBlock(blockNumber));
    }));
    const traderByTx = await resolveTxTraders(logs.map((log) => log.transactionHash), this.repository, this.provider);
    return logs.map((log, index) => this.#buildTrade({
      topics: log.topics as string[],
      data: log.data,
      txHash: log.transactionHash,
      logIndex: log.index,
      timestampMs: Number(blocks.get(log.blockNumber)!.timestamp) * 1000,
      rank: index + 1,
      quote,
      trader: traderByTx.get(log.transactionHash.toLowerCase())
    }));
  }

  async #resolveTradeQuote(launch: Launch): Promise<TradeQuote> {
    let quoteAddress = launch.quoteAddress;
    let quoteIsToken0: boolean;
    let quoteDecimals: number;

    const known = quoteAddress ? getQuoteToken(this.adapter.quotes, quoteAddress) : undefined;
    if (quoteAddress && known) {
      quoteDecimals = known.decimals;
      quoteIsToken0 = isQuoteToken0(quoteAddress, launch.tokenAddress);
    } else if (quoteAddress) {
      quoteIsToken0 = isQuoteToken0(quoteAddress, launch.tokenAddress);
      quoteDecimals = await this.#getTokenDecimals(quoteAddress);
    } else {
      // Legacy launch saved before quoteAddress existed — recover ordering from chain.
      const metadata = await this.#getPoolMetadata(launch.poolAddress);
      quoteAddress = metadata.quoteAddress;
      quoteIsToken0 = metadata.quoteIsToken0;
      quoteDecimals = metadata.quoteDecimals;
    }

    const quotePriceUsd = this.priceService ? await this.priceService.getQuotePriceUsd(quoteAddress) : null;
    return { quoteIsToken0, quoteDecimals, quotePriceUsd };
  }

  #buildTrade(input: { topics: string[]; data: string; txHash: string; logIndex: number; timestampMs: number; rank: number; quote: TradeQuote; trader?: string }): Trade {
    const parsed = this.adapter.parseSwap({ topics: input.topics, data: input.data, quoteIsToken0: input.quote.quoteIsToken0 });
    const quoteAmount = parsed ? formatUnits(parsed.quoteAmountRaw, input.quote.quoteDecimals) : "0";
    return {
      id: `${input.txHash}-${input.logIndex}`,
      rank: input.rank,
      side: parsed?.side ?? "buy",
      // The real buyer is the tx signer; fall back to the swap event recipient.
      trader: input.trader ?? parsed?.trader ?? "unknown",
      amountUsd: parsed && input.quote.quotePriceUsd != null ? Number(quoteAmount) * input.quote.quotePriceUsd : null,
      quoteAmount,
      tokenAmount: null,
      timestamp: new Date(input.timestampMs).toISOString(),
      txHash: input.txHash
    };
  }

  async #toLaunch(log: Log): Promise<Launch | null> {
    const parsed = this.adapter.parseLaunchLog(log);
    const transaction = await this.provider!.getTransaction(log.transactionHash);
    const block = await this.#getBlock(log.blockNumber);

    const { tokenAddress, quoteAddress } = await this.#resolveTokenSide(parsed.token0, parsed.token1);
    const creation = await this.#getTokenCreation(tokenAddress);
    const [tokenSymbol, quoteSymbol] = await Promise.all([
      this.#getTokenSymbol(tokenAddress),
      this.#getTokenSymbol(quoteAddress)
    ]);

    const tokenCreatedAt = creation?.createdAt ?? null;
    const tokenAgeAtLaunchHours = tokenCreatedAt
      ? (Number(block!.timestamp) * 1000 - new Date(tokenCreatedAt).getTime()) / 3_600_000
      : null;

    return {
      id: parsed.poolAddress,
      dex: this.adapter.id,
      poolAddress: parsed.poolAddress,
      tokenAddress,
      tokenSymbol,
      tokenCreatedAt,
      tokenCreatedBlock: creation?.createdBlock ?? null,
      tokenAgeAtLaunchHours,
      quoteSymbol,
      quoteAddress,
      pair: `${tokenSymbol} / ${quoteSymbol}`,
      creator: transaction?.from ?? "unknown",
      createdAt: new Date(Number(block!.timestamp) * 1000).toISOString(),
      blockNumber: log.blockNumber,
      poolType: parsed.poolType,
      poolTypeLabel: parsed.poolTypeLabel,
      liquidityUsd: null,
      volumeUsd: null,
      firstTrades: null,
      risk: "unrated"
    };
  }

  // The launched token is the non-quote side. For token/token pools (no known quote),
  // pick the more recently created side as the token and treat the other as the quote.
  async #resolveTokenSide(token0: string, token1: string): Promise<{ tokenAddress: string; quoteAddress: string }> {
    const isQuote0 = isKnownQuote(this.adapter.quotes, token0);
    const isQuote1 = isKnownQuote(this.adapter.quotes, token1);
    if (isQuote0 && !isQuote1) return { tokenAddress: token1, quoteAddress: token0 };
    if (isQuote1 && !isQuote0) return { tokenAddress: token0, quoteAddress: token1 };

    const [creation0, creation1] = await Promise.all([
      this.#getTokenCreation(token0),
      this.#getTokenCreation(token1)
    ]);
    const block0 = creation0?.createdBlock ?? -1;
    const block1 = creation1?.createdBlock ?? -1;
    return block1 >= block0
      ? { tokenAddress: token1, quoteAddress: token0 }
      : { tokenAddress: token0, quoteAddress: token1 };
  }

  async #getPoolMetadata(poolAddress: string): Promise<{ quoteAddress: string; quoteIsToken0: boolean; quoteDecimals: number }> {
    const cached = this.poolMetadata.get(poolAddress);
    if (cached) return cached;
    const pool = new Contract(poolAddress, this.adapter.poolInterface, this.provider!);
    const [token0, token1] = await Promise.all([pool.token0(), pool.token1()]);
    const quoteAddress = isKnownQuote(this.adapter.quotes, token0) ? token0 : token1;
    const metadata = {
      quoteAddress,
      quoteIsToken0: token0.toLowerCase() === quoteAddress.toLowerCase(),
      quoteDecimals: await this.#getTokenDecimals(quoteAddress)
    };
    this.poolMetadata.set(poolAddress, metadata);
    return metadata;
  }

  async #getTokenSymbol(address: string): Promise<string> {
    const key = address.toLowerCase();
    const cached = this.tokenSymbols.get(key);
    if (cached) return cached;
    const knownSymbol = getQuoteToken(this.adapter.quotes, key)?.symbol;
    if (knownSymbol) return knownSymbol;
    try {
      const symbol = await new Contract(address, TOKEN_ABI, this.provider!).symbol();
      this.tokenSymbols.set(key, symbol);
      return symbol;
    } catch {
      return `${address.slice(0, 6)}...`;
    }
  }

  async #getTokenDecimals(address: string): Promise<number> {
    const key = address.toLowerCase();
    const cached = this.tokenDecimals.get(key);
    if (cached != null) return cached;
    const knownDecimals = getQuoteToken(this.adapter.quotes, key)?.decimals;
    if (knownDecimals != null) return knownDecimals;
    try {
      const decimals = Number(await new Contract(address, TOKEN_ABI, this.provider!).decimals());
      this.tokenDecimals.set(key, decimals);
      return decimals;
    } catch {
      return 18;
    }
  }

  async #getFirstFunding(address: string): Promise<FundingDetails> {
    // Prefer the shared funding cache so the creator's funding is reused by attendee
    // analysis (and vice-versa) instead of re-querying Etherscan per view.
    if (this.walletIntel) {
      try {
        const funding = await this.walletIntel.getFunding(address);
        return funding
          ? { firstFundedAt: funding.firstFundedAt, fundingSource: funding.fundingSource, fundingAmount: funding.fundingAmount }
          : { firstFundedAt: null, fundingSource: null, fundingAmount: null };
      } catch {
        return { firstFundedAt: null, fundingSource: null, fundingAmount: null };
      }
    }
    if (!this.etherscan) {
      return { firstFundedAt: null, fundingSource: null, fundingAmount: null };
    }
    try {
      const [transfer] = await this.etherscan.getIncomingTransfers(address, 1);
      return transfer
        ? {
            firstFundedAt: new Date(transfer.timeStamp * 1000).toISOString(),
            fundingSource: transfer.from,
            fundingAmount: `${Number(formatEther(transfer.value)).toFixed(4)} ETH`
          }
        : { firstFundedAt: null, fundingSource: null, fundingAmount: null };
    } catch {
      return { firstFundedAt: null, fundingSource: null, fundingAmount: null };
    }
  }

  // The stored attendee report for a launch (real/external volume + sybil clusters). In
  // demo mode a synthetic report is returned; in live mode a not-yet-analyzed launch
  // returns an unanalyzed stub that the UI can trigger analysis for.
  async getAttendees(poolAddress: string): Promise<AttendeeReport> {
    if (!this.provider) {
      const launch = this.#demoLaunches().find((item) => item.poolAddress.toLowerCase() === poolAddress.toLowerCase());
      if (!launch) throw new Error("Launch not found");
      return buildDemoAttendeeReport(launch);
    }
    const stored = await this.#requireRepository().getAttendeeReport(poolAddress);
    if (stored) return stored;
    const launch = await this.#requireRepository().getByPoolAddress(poolAddress);
    if (!launch) throw new Error("Launch not found");
    return {
      poolAddress: launch.poolAddress,
      dex: this.adapter.id,
      creator: launch.creator,
      creatorFundingSource: null,
      analyzed: false,
      complete: false,
      analyzedTrades: 0,
      buyerCount: 0,
      insiderBuyerCount: 0,
      externalBuyerCount: 0,
      totalVolumeUsd: null,
      externalVolumeUsd: null,
      insiderVolumeUsd: null,
      insiderRatio: null,
      buyers: [],
      clusters: [],
      updatedAt: null
    };
  }

  async #getBlock(blockNumber: number): Promise<Block> {
    const cached = this.blocks.get(blockNumber);
    if (cached) return cached;
    const block = await this.#requireProvider().getBlock(blockNumber);
    if (!block) throw new Error(`Block ${blockNumber} was not returned`);
    this.blocks.set(blockNumber, block);
    return block;
  }

  // Exact token creation time from Etherscan's getcontractcreation (one call, any age).
  // Successful lookups are cached in MongoDB; quote tokens never need a lookup.
  async #getTokenCreation(address: string): Promise<TokenCreation | null> {
    const key = address.toLowerCase();
    if (isKnownQuote(this.adapter.quotes, key)) return null;

    const cached = await this.#requireRepository().getTokenCreation(key);
    if (cached?.createdAt) return cached;
    if (!this.etherscan) return cached ?? null;

    try {
      const creation = await this.etherscan.getContractCreation(key);
      if (!creation) return cached ?? null;
      const record: TokenCreation = { address: key, createdAt: creation.createdAt, createdBlock: creation.createdBlock };
      await this.#requireRepository().saveTokenCreation(record);
      return record;
    } catch (error) {
      console.warn(`Token creation lookup failed for ${key}: ${error instanceof Error ? error.message : error}`);
      return cached ?? null;
    }
  }

  async #getLogsInChunks(filter: LogRange, limit = Infinity): Promise<Log[]> {
    const logs: Log[] = [];
    for (let fromBlock = filter.fromBlock; fromBlock <= filter.toBlock; fromBlock += this.logChunk) {
      const chunk = await this.provider!.getLogs({
        ...filter,
        fromBlock,
        toBlock: Math.min(fromBlock + this.logChunk - 1, filter.toBlock)
      });
      logs.push(...chunk);
      if (logs.length >= limit) return logs.slice(0, limit);
    }
    return logs;
  }

  #requireProvider(): RpcMetricsProvider {
    if (!this.provider) throw new Error("BASE_RPC_URL is required for live indexing");
    return this.provider;
  }

  #requireRepository(): LaunchRepository {
    if (!this.repository) throw new Error("MongoDB is required for live launch indexing");
    return this.repository;
  }

  #getDemoCreators({ cursor, limit, search, sort }: { cursor?: string; limit: number; search?: string; sort: CreatorSort }): CreatorPage {
    let items = buildDemoCreators(this.#demoLaunches());
    if (search) {
      const pattern = search.toLowerCase();
      items = items.filter((creator) => creator.address.toLowerCase().includes(pattern));
    }
    items.sort((left, right) => {
      if (sort === "oldest") return left.firstLaunchAt.localeCompare(right.firstLaunchAt) || right.address.localeCompare(left.address);
      if (sort === "newest") return right.lastLaunchAt.localeCompare(left.lastLaunchAt) || right.address.localeCompare(left.address);
      return right.launchCount - left.launchCount || right.address.localeCompare(left.address);
    });

    const total = items.length;
    let startIndex = 0;
    if (cursor) {
      const { value, address } = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { value: string | number; address: string };
      const field = sort === "oldest" ? "firstLaunchAt" : sort === "newest" ? "lastLaunchAt" : "launchCount";
      startIndex = items.findIndex((creator) => {
        const creatorValue = creator[field];
        return creatorValue === value && creator.address === address;
      }) + 1;
      if (startIndex <= 0) startIndex = 0;
    }

    const pageItems = items.slice(startIndex, startIndex + limit);
    const lastItem = pageItems.at(-1);
    const hasMore = startIndex + limit < items.length;

    return {
      items: pageItems,
      nextCursor: hasMore && lastItem
        ? Buffer.from(JSON.stringify({
            value: sort === "oldest" ? lastItem.firstLaunchAt : sort === "newest" ? lastItem.lastLaunchAt : lastItem.launchCount,
            address: lastItem.address
          })).toString("base64url")
        : null,
      total
    };
  }
}
