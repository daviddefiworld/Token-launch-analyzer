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
