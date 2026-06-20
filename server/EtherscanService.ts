// Thin, rate-limited client over the Etherscan v2 API (Base, chainid 8453).
//
// Free tier limits: 5 calls/sec and 100,000 calls/day. Every public method funnels
// through schedule(), a priority queue that serializes requests to stay safely under both
// ceilings while letting interactive work (e.g. the on-demand address research panel) jump
// ahead of the background indexing/refresh loops.

// Request priority. Higher wins; ties break FIFO. Interactive requests (a user is waiting on
// the result) are dispatched before BACKGROUND loop traffic queued on the same limiter.
export const REQUEST_PRIORITY = { BACKGROUND: 0, INTERACTIVE: 10 } as const;

const CHAIN_ID = "8453";
const BASE_URL = "https://api.etherscan.io/v2/api";
// ~4.5 req/s — comfortably below the 5/s ceiling even with clock jitter.
const MIN_INTERVAL_MS = 220;
// Stop short of the hard 100k/day cap so other features keep working.
const DAILY_LIMIT = 95_000;
const DAY_MS = 86_400_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const ETH_PRICE_TTL_MS = 60_000;

export interface ContractCreation {
  creator: string;
  txHash: string;
  createdBlock: number;
  createdAt: string;
}

export interface EtherscanLog {
  topics: string[];
  data: string;
  blockNumber: number;
  timeStamp: number;
  transactionHash: string;
  logIndex: number;
}

export interface IncomingTransfer {
  from: string;
  value: string;
  timeStamp: number;
  hash: string;
  // "external" = a normal tx; "internal" = a contract-mediated value transfer (disperse
  // contracts, CEX withdrawals, custom funders) that only appears in txlistinternal.
  via: "external" | "internal";
}

interface EtherscanEnvelope {
  status?: string;
  message?: string;
  result?: unknown;
}

interface ScheduleWaiter {
  priority: number;
  // Monotonic sequence for FIFO ordering within a priority band.
  seq: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class EtherscanService {
  private nextSlot = 0;
  private dailyCount = 0;
  private windowStart = Date.now();
  private ethPrice: { value: number; at: number } | null = null;
  // Priority queue of pending requests, drained one-per-interval by pump().
  private readonly queue: ScheduleWaiter[] = [];
  private queueSeq = 0;
  private pumping = false;

  constructor(private readonly apiKey: string) {}

  async getContractCreation(address: string): Promise<ContractCreation | null> {
    const envelope = await this.request({
      module: "contract",
      action: "getcontractcreation",
      contractaddresses: address
    });
    const entry = Array.isArray(envelope.result) ? envelope.result[0] as Record<string, string> | undefined : undefined;
    if (!entry?.txHash || !entry.blockNumber || !entry.timestamp) return null;
    return {
      creator: entry.contractCreator,
      txHash: entry.txHash,
      createdBlock: Number(entry.blockNumber),
      createdAt: new Date(Number(entry.timestamp) * 1000).toISOString()
    };
  }

  async getEthPriceUsd(): Promise<number> {
    const now = Date.now();
    if (this.ethPrice && now - this.ethPrice.at < ETH_PRICE_TTL_MS) return this.ethPrice.value;
    const envelope = await this.request({ module: "stats", action: "ethprice" });
    const result = envelope.result as { ethusd?: string } | undefined;
    const value = Number(result?.ethusd);
    if (!Number.isFinite(value) || value <= 0) throw new Error("Etherscan returned an invalid ETH price");
    this.ethPrice = { value, at: now };
    return value;
  }

  async getTokenBalance(token: string, holder: string): Promise<bigint> {
    const envelope = await this.request({
      module: "account",
      action: "tokenbalance",
      contractaddress: token,
      address: holder,
      tag: "latest"
    });
    return typeof envelope.result === "string" && /^\d+$/.test(envelope.result) ? BigInt(envelope.result) : 0n;
  }

  async getBlockNumber(): Promise<number> {
    const envelope = await this.request({ module: "proxy", action: "eth_blockNumber" });
    return typeof envelope.result === "string" ? Number(envelope.result) : 0;
  }

  // `warnOnCap` controls whether hitting the page cap logs a truncation warning. Callers
  // that intentionally cap results (e.g. the first-100-trades view, maxPages: 1) pass false,
  // since for them truncation is expected rather than a data-quality concern.
  async getLogs(options: { address: string; topic0: string; fromBlock: number; toBlock: number; offset?: number; maxPages?: number; warnOnCap?: boolean }): Promise<EtherscanLog[]> {
    const { address, topic0, fromBlock, toBlock, offset = 1000, maxPages = 5, warnOnCap = true } = options;
    const logs: EtherscanLog[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const envelope = await this.request({
        module: "logs",
        action: "getLogs",
        address,
        topic0,
        fromBlock: String(fromBlock),
        toBlock: String(toBlock),
        page: String(page),
        offset: String(offset)
      });
      const rows = Array.isArray(envelope.result) ? envelope.result as Array<Record<string, string>> : [];
      for (const row of rows) {
        logs.push({
          topics: Array.isArray(row.topics) ? row.topics as unknown as string[] : [],
          data: row.data,
          blockNumber: Number(row.blockNumber),
          timeStamp: Number(row.timeStamp),
          transactionHash: row.transactionHash,
          logIndex: Number(row.logIndex)
        });
      }
      if (rows.length < offset) break;
      if (page === maxPages && warnOnCap) {
        console.warn(`Etherscan getLogs hit the ${maxPages}-page cap for ${address}; older logs were not fetched.`);
      }
    }

    return logs;
  }

  // Every distinct address that has sent ETH to `address`, across both normal and internal
  // transactions, earliest first and capped at `maxFunders` distinct sources. Funding is
  // continuous (a wallet is topped up many times from many places), so we keep them all —
  // any one of them can tie a buyer to the founder's cluster. Costs exactly 2 API requests
  // regardless of `maxFunders` (the offset only changes the response size, not the count).
  async getIncomingTransfers(address: string, maxFunders = 12, opts: { priority?: number } = {}): Promise<IncomingTransfer[]> {
    const lower = address.toLowerCase();
    const params = (action: string) => ({
      module: "account",
      action,
      address,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: "1000",
      sort: "asc" as const
    });
    const [normal, internal] = await Promise.all([
      this.request(params("txlist"), opts),
      this.request(params("txlistinternal"), opts)
    ]);

    const transfers: IncomingTransfer[] = [];
    const collect = (envelope: EtherscanEnvelope, via: "external" | "internal") => {
      const rows = Array.isArray(envelope.result) ? envelope.result as Array<Record<string, string>> : [];
      for (const tx of rows) {
        // Skip reverted internal calls, zero-value moves, and self-sends.
        if (tx.isError === "1") continue;
        if (!tx.from || !tx.value || tx.value === "0") continue;
        if (tx.to?.toLowerCase() !== lower) continue;
        if (tx.from.toLowerCase() === lower) continue;
        transfers.push({ from: tx.from.toLowerCase(), value: tx.value, timeStamp: Number(tx.timeStamp), hash: tx.hash, via });
      }
    };
    collect(normal, "external");
    collect(internal, "internal");

    // Earliest first, then keep one (the first) transfer per distinct funder.
    transfers.sort((left, right) => left.timeStamp - right.timeStamp);
    const byFunder = new Map<string, IncomingTransfer>();
    for (const transfer of transfers) {
      if (!byFunder.has(transfer.from)) byFunder.set(transfer.from, transfer);
      if (byFunder.size >= maxFunders) break;
    }
    return [...byFunder.values()];
  }

  // Every distinct address that `address` has sent ETH to, across normal and internal
  // transactions, earliest first and capped at `maxRecipients`. The mirror image of
  // getIncomingTransfers — used by the research panel to walk the wallets a bot funded.
  // Costs exactly 2 API requests regardless of `maxRecipients`.
  async getOutgoingTransfers(address: string, maxRecipients = 25, opts: { priority?: number } = {}): Promise<IncomingTransfer[]> {
    const lower = address.toLowerCase();
    const params = (action: string) => ({
      module: "account",
      action,
      address,
      startblock: "0",
      endblock: "99999999",
      page: "1",
      offset: "1000",
      sort: "asc" as const
    });
    const [normal, internal] = await Promise.all([
      this.request(params("txlist"), opts),
      this.request(params("txlistinternal"), opts)
    ]);

    // Each transfer's `from` is the recipient the seed funded (we keep the field name so the
    // shape matches getIncomingTransfers and the funding-edge code can reuse it).
    const transfers: IncomingTransfer[] = [];
    const collect = (envelope: EtherscanEnvelope, via: "external" | "internal") => {
      const rows = Array.isArray(envelope.result) ? envelope.result as Array<Record<string, string>> : [];
      for (const tx of rows) {
        if (tx.isError === "1") continue;
        if (!tx.to || !tx.value || tx.value === "0") continue;
        if (tx.from?.toLowerCase() !== lower) continue;
        if (tx.to.toLowerCase() === lower) continue;
        transfers.push({ from: tx.to.toLowerCase(), value: tx.value, timeStamp: Number(tx.timeStamp), hash: tx.hash, via });
      }
    };
    collect(normal, "external");
    collect(internal, "internal");

    transfers.sort((left, right) => left.timeStamp - right.timeStamp);
    const byRecipient = new Map<string, IncomingTransfer>();
    for (const transfer of transfers) {
      if (!byRecipient.has(transfer.from)) byRecipient.set(transfer.from, transfer);
      if (byRecipient.size >= maxRecipients) break;
    }
    return [...byRecipient.values()];
  }

  // Reserve a rate-limit slot. Returns once it's this caller's turn; callers with a higher
  // priority are served first even if they enqueued later (but never starve a slot already
  // being waited out). Defaults to BACKGROUND priority.
  private schedule(priority: number = REQUEST_PRIORITY.BACKGROUND): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ priority, seq: this.queueSeq++, resolve, reject });
      void this.pump();
    });
  }

  // Drains the queue, releasing one waiter per MIN_INTERVAL_MS. The waiter to release is
  // chosen *after* the interval wait, so an interactive request that arrives mid-wait can
  // still claim the upcoming slot ahead of background traffic.
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const now = Date.now();
        if (now - this.windowStart >= DAY_MS) {
          this.windowStart = now;
          this.dailyCount = 0;
        }
        if (this.dailyCount >= DAILY_LIMIT) {
          const error = new Error("Etherscan daily request budget reached; skipping call");
          for (const waiter of this.queue.splice(0)) waiter.reject(error);
          break;
        }
        const slot = Math.max(Date.now(), this.nextSlot);
        const wait = slot - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        this.nextSlot = slot + MIN_INTERVAL_MS;
        this.dailyCount += 1;

        let best = 0;
        for (let index = 1; index < this.queue.length; index++) {
          const candidate = this.queue[index];
          const current = this.queue[best];
          if (candidate.priority > current.priority || (candidate.priority === current.priority && candidate.seq < current.seq)) {
            best = index;
          }
        }
        this.queue.splice(best, 1)[0].resolve();
      }
    } finally {
      this.pumping = false;
    }
  }

  private async request(params: Record<string, string>, opts: { priority?: number } = {}): Promise<EtherscanEnvelope> {
    const url = new URL(BASE_URL);
    url.search = new URLSearchParams({ chainid: CHAIN_ID, ...params, apikey: this.apiKey }).toString();

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.schedule(opts.priority);
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`Etherscan request failed with ${response.status}`);
        const envelope = (await response.json()) as EtherscanEnvelope;
        // "No records found" / "No transactions found" are empty results, not failures.
        if (envelope.status === "0" && /max.*rate limit/i.test(envelope.message ?? "")) {
          throw new Error("Etherscan rate limit reached");
        }
        return envelope;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_RETRIES - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
          continue;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Etherscan request failed");
  }
}
