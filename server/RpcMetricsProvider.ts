import { JsonRpcProvider, type JsonRpcApiProviderOptions, type Networkish } from "ethers";
import type { RpcMethodUsage, RpcUsage } from "../types.js";

export class RpcMetricsProvider extends JsonRpcProvider {
  private readonly startedAt = new Date().toISOString();
  private readonly methods = new Map<string, RpcMethodUsage>();

  constructor(url: string, network?: Networkish, options?: JsonRpcApiProviderOptions) {
    super(url, network, options);
  }

  override async send(method: string, params: Array<unknown> | Record<string, unknown>): Promise<unknown> {
    const usage = this.methods.get(method) ?? { method, count: 0, errors: 0, lastCalledAt: null };
    usage.count += 1;
    usage.lastCalledAt = new Date().toISOString();
    this.methods.set(method, usage);

    try {
      return await super.send(method, params);
    } catch (error) {
      usage.errors += 1;
      throw error;
    }
  }

  // Resolve the EOA that actually signed each transaction — the real trader behind a router
  // or aggregator, which the swap event only records as its `to`/`recipient` (often the
  // router contract). Keyed by lowercased tx hash, bounded concurrency to respect RPC
  // limits; failed lookups are omitted so callers can fall back to the event recipient.
  async getTransactionSenders(hashes: string[], concurrency = 10): Promise<Map<string, string>> {
    const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))];
    const senders = new Map<string, string>();
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < unique.length) {
        const hash = unique[cursor++];
        try {
          const tx = await this.getTransaction(hash);
          if (tx?.from) senders.set(hash, tx.from.toLowerCase());
        } catch {
          // Omit on failure; the caller falls back to the swap event recipient.
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length || 1) }, () => worker()));
    return senders;
  }

  getUsage(): RpcUsage {
    const methods = [...this.methods.values()].sort((left, right) => right.count - left.count);
    return {
      totalCalls: methods.reduce((sum, method) => sum + method.count, 0),
      totalErrors: methods.reduce((sum, method) => sum + method.errors, 0),
      startedAt: this.startedAt,
      methods
    };
  }
}
