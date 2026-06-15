import type { LaunchRepository } from "./LaunchRepository.js";
import type { RpcMetricsProvider } from "./RpcMetricsProvider.js";

// Hard cap on per-call RPC tx lookups, so a pathologically busy pool can't trigger an
// unbounded fan-out. Beyond this, callers fall back to the swap event recipient.
const MAX_TX_LOOKUPS = 2500;

// Map each swap transaction hash to the EOA that actually signed it — the real buyer behind
// any router/aggregator (the swap event only records its `to`, which is usually the router).
// Cache-first (tx -> signer is immutable), then RPC for the misses. Uses the RPC provider,
// NOT Etherscan, so it doesn't touch the Etherscan rate budget. Failed/unknown hashes are
// simply absent from the map; callers fall back to the event recipient.
export async function resolveTxTraders(
  hashes: string[],
  repository: LaunchRepository | null,
  provider: RpcMetricsProvider | null
): Promise<Map<string, string>> {
  const unique = [...new Set(hashes.map((hash) => hash.toLowerCase()))].slice(0, MAX_TX_LOOKUPS);
  if (!unique.length) return new Map();

  const resolved = repository ? await repository.getTxSenders(unique) : new Map<string, string>();
  const missing = unique.filter((hash) => !resolved.has(hash));
  if (provider && missing.length) {
    const fetched = await provider.getTransactionSenders(missing);
    if (repository && fetched.size) {
      await repository.saveTxSenders([...fetched].map(([hash, from]) => ({ hash, from })));
    }
    for (const [hash, from] of fetched) resolved.set(hash, from);
  }
  return resolved;
}
