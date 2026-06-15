// Thin, rate-limited client over the Etherscan v2 API (Base, chainid 8453).
//
// Free tier limits: 5 calls/sec and 100,000 calls/day. Every public method funnels
// through schedule(), which serializes requests to stay safely under both ceilings.

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

export class EtherscanService {
  private nextSlot = 0;
  private dailyCount = 0;
  private windowStart = Date.now();
  private ethPrice: { value: number; at: number } | null = null;

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
  async getIncomingTransfers(address: string, maxFunders = 12): Promise<IncomingTransfer[]> {
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
      this.request(params("txlist")),
      this.request(params("txlistinternal"))
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

  private async schedule(): Promise<void> {
    const now = Date.now();
    if (now - this.windowStart >= DAY_MS) {
      this.windowStart = now;
      this.dailyCount = 0;
    }
    if (this.dailyCount >= DAILY_LIMIT) {
      throw new Error("Etherscan daily request budget reached; skipping call");
    }
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + MIN_INTERVAL_MS;
    this.dailyCount += 1;
    const wait = slot - now;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  }

  private async request(params: Record<string, string>): Promise<EtherscanEnvelope> {
    const url = new URL(BASE_URL);
    url.search = new URLSearchParams({ chainid: CHAIN_ID, ...params, apikey: this.apiKey }).toString();

    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await this.schedule();
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
