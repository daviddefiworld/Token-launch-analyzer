import { formatEther } from "ethers";
import type { AttendeeClass, AttendeeNodeRole } from "../types.js";
import type { EtherscanService } from "./EtherscanService.js";
import type { LaunchRepository } from "./LaunchRepository.js";

// A wallet's first funder is an immutable property, so funding lookups are cached forever
// in Mongo. Because launch bots are reused across many launches, the cache amortizes fast:
// each wallet is investigated via Etherscan at most once, then served from cache everywhere.
export interface WalletFunding {
  address: string;
  fundingSource: string | null;
  firstFundedAt: string | null;
  fundingAmount: string | null;
  fetchedAt: string;
}

export interface TraderActivity {
  address: string;        // lowercased EOA (swap recipient)
  quoteRaw: bigint;       // summed quote-leg volume in raw units
  tradeCount: number;
  firstTradeMs: number | null;
}

export interface ClassifiedBuyer {
  address: string;
  classification: AttendeeClass;
  fundingSource: string | null;
  clusterId: number | null;
  quoteRaw: bigint;
  tradeCount: number;
  firstTradeMs: number | null;
}

export interface IntelCluster {
  id: number;
  kind: "creator-insider" | "coordinated";
  fundingSource: string | null;
  memberCount: number;
  quoteRaw: bigint;
}

export interface IntelGraphNode {
  address: string;
  role: AttendeeNodeRole;
  clusterId: number | null;
}

export interface IntelGraph {
  nodes: IntelGraphNode[];
  edges: { from: string; to: string }[];
}

export interface IntelResult {
  creatorFundingSource: string | null;
  buyers: ClassifiedBuyer[];
  clusters: IntelCluster[];
  graph: IntelGraph;
  insiderQuoteRaw: bigint;
  totalQuoteRaw: bigint;
  insiderBuyerCount: number;
  externalBuyerCount: number;
  complete: boolean;
}

// A funder that has seeded this many distinct cached wallets is treated as a public
// disperser (CEX hot wallet, bridge, router) rather than a sybil link. Tunable; high
// enough that a creator dispersing to a few dozen bots is still flagged.
const PUBLIC_FUNDER_THRESHOLD = 75;
// External buyers sharing one private funder with each other form a "coordinated" ring.
const MIN_COORDINATED_CLUSTER = 3;
// Cap the wallet graph to the top traders (by volume) plus their funders, for readability.
const GRAPH_MAX_TRADERS = 60;
// Known public funders on Base whose shared use is meaningless as a sybil signal. The
// out-degree heuristic catches the rest as the cache grows; extend this seed as needed.
const SEED_PUBLIC_FUNDERS = new Set<string>([
  "0x0000000000000000000000000000000000000000",
  "0x4200000000000000000000000000000000000010" // Base L2 standard bridge predeploy
]);

class DisjointSet {
  private readonly parent = new Map<string, string>();

  find(node: string): string {
    if (!this.parent.has(node)) {
      this.parent.set(node, node);
      return node;
    }
    let root = node;
    while (this.parent.get(root)! !== root) root = this.parent.get(root)!;
    // Path compression.
    let current = node;
    while (current !== root) {
      const next = this.parent.get(current)!;
      this.parent.set(current, root);
      current = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent.set(rootA, rootB);
  }
}

export class WalletIntelService {
  constructor(
    private readonly etherscan: EtherscanService,
    private readonly repository: LaunchRepository,
    private readonly maxNewLookups = 40
  ) {}

  // Single cached funding lookup, used by the creator profile.
  async getFunding(address: string): Promise<WalletFunding | null> {
    const key = address.toLowerCase();
    const { map } = await this.resolveFunding([key], this.maxNewLookups);
    return map.get(key) ?? null;
  }

  // Classify a launch's buyers against the creator's funding graph and split volume into
  // insider (the creator's cluster — wash trading) vs external (real demand).
  async classify(creator: string, traders: TraderActivity[], opts: { maxNewLookups?: number } = {}): Promise<IntelResult> {
    const creatorKey = creator.toLowerCase();
    const budget = opts.maxNewLookups ?? this.maxNewLookups;

    // Resolve funding creator-first, then by descending volume so the most impactful
    // buyers are classified even when the lookup budget is exhausted.
    const ordered = [...traders].sort((a, b) => (b.quoteRaw > a.quoteRaw ? 1 : b.quoteRaw < a.quoteRaw ? -1 : 0));
    const coreAddresses = [creatorKey, ...ordered.map((t) => t.address).filter((a) => a !== creatorKey)];
    const firstHop = await this.resolveFunding(coreAddresses, budget);
    const funding = firstHop.map;
    const resolvedCount = funding.size;

    // Second hop: resolve the funders themselves so creator -> intermediary -> bot chains
    // connect, with whatever budget remains.
    const firstHopFunders = [...new Set([...funding.values()].map((f) => f.fundingSource).filter((f): f is string => !!f))];
    const secondHop = await this.resolveFunding(firstHopFunders, Math.max(0, budget - firstHop.newLookups));
    for (const [address, record] of secondHop.map) if (!funding.has(address)) funding.set(address, record);

    const creatorFundingSource = funding.get(creatorKey)?.fundingSource ?? null;

    // Out-degree of every funder we touched, to flag public dispersers (never the creator).
    const allFunders = [...new Set([...funding.values()].map((f) => f.fundingSource).filter((f): f is string => !!f))];
    const funderCounts = await this.repository.getFunderCounts(allFunders);
    const isPublic = (funder: string): boolean =>
      funder !== creatorKey && (SEED_PUBLIC_FUNDERS.has(funder) || (funderCounts.get(funder) ?? 0) >= PUBLIC_FUNDER_THRESHOLD);

    // Union each wallet with its (non-public) funder; shared private funders thus merge.
    const dsu = new DisjointSet();
    for (const [address, record] of funding) {
      const funder = record.fundingSource;
      if (funder && !isPublic(funder)) dsu.union(address, funder);
    }
    const creatorRoot = dsu.find(creatorKey);

    let insiderQuoteRaw = 0n;
    let totalQuoteRaw = 0n;
    let insiderBuyerCount = 0;
    let externalBuyerCount = 0;
    let complete = resolvedCount >= coreAddresses.length;

    // First pass: classify each buyer.
    const classified: ClassifiedBuyer[] = ordered.map((trader) => {
      totalQuoteRaw += trader.quoteRaw;
      const record = funding.get(trader.address);
      const fundingSource = record?.fundingSource ?? null;
      const classification = this.classifyOne(trader.address, creatorKey, creatorFundingSource, fundingSource, dsu, creatorRoot, isPublic);
      if (!record) complete = false;
      if (classification === "external") externalBuyerCount += 1;
      else { insiderBuyerCount += 1; insiderQuoteRaw += trader.quoteRaw; }
      return { address: trader.address, classification, fundingSource, clusterId: null, quoteRaw: trader.quoteRaw, tradeCount: trader.tradeCount, firstTradeMs: trader.firstTradeMs };
    });

    const clusters = this.buildClusters(classified, creatorFundingSource, isPublic);
    const graph = this.buildGraph(classified, funding, creatorKey, creatorRoot, dsu, isPublic);
    return { creatorFundingSource, buyers: classified, clusters, graph, insiderQuoteRaw, totalQuoteRaw, insiderBuyerCount, externalBuyerCount, complete };
  }

  // Build a funding-relationship graph: the top traders, the creator, and up to two hops of
  // their private funders, with an edge from each wallet to the wallet that funded it.
  private buildGraph(
    buyers: ClassifiedBuyer[],
    funding: Map<string, WalletFunding>,
    creatorKey: string,
    creatorRoot: string,
    dsu: DisjointSet,
    isPublic: (funder: string) => boolean
  ): IntelGraph {
    const funderOf = (address: string): string | null => {
      const funder = funding.get(address)?.fundingSource;
      return funder && !isPublic(funder) ? funder : null;
    };

    const included = new Set<string>([creatorKey, ...buyers.slice(0, GRAPH_MAX_TRADERS).map((buyer) => buyer.address)]);
    for (let hop = 0; hop < 2; hop++) {
      for (const address of [...included]) {
        const funder = funderOf(address);
        if (funder) included.add(funder);
      }
    }

    const edges: { from: string; to: string }[] = [];
    for (const address of included) {
      const funder = funderOf(address);
      if (funder && included.has(funder)) edges.push({ from: address, to: funder });
    }

    const byAddress = new Map(buyers.map((buyer) => [buyer.address, buyer]));
    const nodes: IntelGraphNode[] = [...included].map((address) => {
      if (address === creatorKey) return { address, role: "creator", clusterId: 0 };
      const buyer = byAddress.get(address);
      if (buyer) {
        const role: AttendeeNodeRole = buyer.classification === "external" ? (buyer.clusterId != null ? "coordinated" : "external") : "insider";
        return { address, role, clusterId: buyer.clusterId };
      }
      // Funder-only node: red if it sits inside the creator's cluster, neutral otherwise.
      return { address, role: dsu.find(address) === creatorRoot ? "insider" : "funder", clusterId: null };
    });

    return { nodes, edges };
  }

  private classifyOne(
    address: string,
    creatorKey: string,
    creatorFundingSource: string | null,
    fundingSource: string | null,
    dsu: DisjointSet,
    creatorRoot: string,
    isPublic: (funder: string) => boolean
  ): AttendeeClass {
    if (address === creatorKey) return "creator";
    if (fundingSource === creatorKey) return "creator-funded";
    if (fundingSource && creatorFundingSource && fundingSource === creatorFundingSource && !isPublic(fundingSource)) return "same-funder";
    if (dsu.find(address) === creatorRoot) return "linked";
    return "external";
  }

  // Cluster 0 is always the creator's insider group; coordinated rings are groups of
  // external buyers (>= MIN_COORDINATED_CLUSTER) that share one private funder.
  private buildClusters(buyers: ClassifiedBuyer[], creatorFundingSource: string | null, isPublic: (funder: string) => boolean): IntelCluster[] {
    const clusters: IntelCluster[] = [];

    const insiders = buyers.filter((b) => b.classification !== "external");
    if (insiders.length) {
      for (const buyer of insiders) buyer.clusterId = 0;
      clusters.push({
        id: 0,
        kind: "creator-insider",
        fundingSource: creatorFundingSource,
        memberCount: insiders.length,
        quoteRaw: insiders.reduce((sum, b) => sum + b.quoteRaw, 0n)
      });
    }

    const byFunder = new Map<string, ClassifiedBuyer[]>();
    for (const buyer of buyers) {
      if (buyer.classification !== "external" || !buyer.fundingSource || isPublic(buyer.fundingSource)) continue;
      const group = byFunder.get(buyer.fundingSource) ?? [];
      group.push(buyer);
      byFunder.set(buyer.fundingSource, group);
    }
    let nextId = 1;
    for (const [funder, group] of byFunder) {
      if (group.length < MIN_COORDINATED_CLUSTER) continue;
      const id = nextId++;
      for (const buyer of group) buyer.clusterId = id;
      clusters.push({ id, kind: "coordinated", fundingSource: funder, memberCount: group.length, quoteRaw: group.reduce((sum, b) => sum + b.quoteRaw, 0n) });
    }

    return clusters;
  }

  // Cache-first funding resolution. Up to `maxNew` uncached addresses are fetched from
  // Etherscan (the rest are left unresolved for a later pass once the cache warms).
  // Returns the resolved map plus the number of fresh Etherscan lookups performed.
  private async resolveFunding(addresses: string[], maxNew: number): Promise<{ map: Map<string, WalletFunding>; newLookups: number }> {
    const keys = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (!keys.length) return { map: new Map(), newLookups: 0 };

    const cached = await this.repository.getWalletFundings(keys);
    const result = new Map(cached);
    const missing = keys.filter((key) => !result.has(key));

    const toFetch = missing.slice(0, Math.max(0, maxNew));
    const fetched: WalletFunding[] = [];
    for (const address of toFetch) {
      try {
        const transfer = await this.etherscan.getFirstIncomingTransfer(address);
        const record: WalletFunding = {
          address,
          fundingSource: transfer ? transfer.from.toLowerCase() : null,
          firstFundedAt: transfer ? new Date(transfer.timeStamp * 1000).toISOString() : null,
          fundingAmount: transfer ? `${Number(formatEther(transfer.value)).toFixed(4)} ETH` : null,
          fetchedAt: new Date().toISOString()
        };
        fetched.push(record);
        result.set(address, record);
      } catch (error) {
        console.warn(`Funding lookup failed for ${address}: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (fetched.length) await this.repository.saveWalletFundings(fetched);
    return { map: result, newLookups: fetched.length };
  }
}
