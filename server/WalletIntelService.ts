import { formatEther } from "ethers";
import type { AttendeeClass, AttendeeNodeRole } from "../types.js";
import { REQUEST_PRIORITY, type EtherscanService } from "./EtherscanService.js";
import type { LaunchRepository } from "./LaunchRepository.js";

// A single incoming ETH funding edge: `from` topped up the wallet (via a normal or an
// internal/contract transfer). Stored so the whole funding graph can be reconstructed.
export interface FundingInflow {
  from: string;
  via: "external" | "internal";
  txHash: string;
  value: string;
  timeStamp: number;
}

// Wallet funding is cached in Mongo. Because launch bots are reused across many launches,
// the cache amortizes fast: each wallet is investigated via Etherscan at most once (2 API
// requests), then served from cache everywhere. `funders` holds every distinct ETH source
// (funding is continuous, not a single transfer); the legacy scalar fields mirror the
// earliest funder for display and backward compatibility with pre-graph cached docs.
export interface WalletFunding {
  address: string;
  funders: FundingInflow[];
  fundingSource: string | null;
  fundingTxHash: string | null;
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
  fundingTxHash: string | null;
  fundingVia: "external" | "internal" | null;
  funderCount: number;
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

export interface ResearchConnectionRaw {
  address: string;
  direction: "seed" | "funder" | "funded" | "both";
  hops: number;
  inCluster: boolean;
  via: "external" | "internal" | null;
  txHash: string | null;
}

export interface IntelResearch {
  address: string;
  connections: ResearchConnectionRaw[];
  graph: IntelGraph;
  walletsExplored: number;
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
// Upper bound on graph nodes so dense funder fan-outs stay legible.
const GRAPH_MAX_NODES = 140;
// Distinct funding sources kept per wallet (one Etherscan lookup yields all of them).
const MAX_FUNDERS_PER_WALLET = 12;
// How many funder hops to walk out from the core wallets (founder -> ... -> bot chains).
// Each new wallet costs 2 Etherscan requests, so this is bounded by the lookup budget and
// by the funding cache (re-walked hops are free once warm).
const MAX_FUNDING_HOPS = 3;
// ---- Address research panel (bidirectional manual walk) ----
// How many hops to walk out from the seed in each direction.
const RESEARCH_HOPS = 4;
// Lookup budget for one research walk (each incoming/outgoing fetch is one unit, ~2 requests).
const RESEARCH_MAX_LOOKUPS = 120;
// Distinct recipients kept per wallet when walking outgoing (funded) edges live.
const RESEARCH_OUT_FANOUT = 25;
// Caps so dense bot fan-outs stay legible / payloads stay bounded.
const RESEARCH_GRAPH_MAX_NODES = 160;
const RESEARCH_MAX_CONNECTIONS = 300;
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
  // insider (the creator's cluster — wash trading) vs external (real demand). Walks the full
  // ETH funding graph: every wallet's distinct funders (normal + contract/internal), out to
  // MAX_FUNDING_HOPS, so any path connecting a buyer to the founder marks it insider.
  async classify(creator: string, traders: TraderActivity[], opts: { maxNewLookups?: number; rugBots?: string[] } = {}): Promise<IntelResult> {
    const creatorKey = creator.toLowerCase();
    let remaining = opts.maxNewLookups ?? this.maxNewLookups;
    // Manually-tagged rug bots: their whole funding cluster is treated as insider, in
    // addition to the creator's. Seeding them into the core frontier walks their funding
    // graph too, so multi-hop links (rug bot -> intermediary -> buyer) are caught.
    const rugBots = new Set((opts.rugBots ?? []).map((address) => address.toLowerCase()));

    // Resolve funding creator-first, then by descending volume so the most impactful
    // buyers are classified even when the lookup budget is exhausted.
    const ordered = [...traders].sort((a, b) => (b.quoteRaw > a.quoteRaw ? 1 : b.quoteRaw < a.quoteRaw ? -1 : 0));
    const coreAddresses = [
      creatorKey,
      ...ordered.map((t) => t.address).filter((a) => a !== creatorKey),
      ...[...rugBots].filter((a) => a !== creatorKey)
    ];

    // Walk funder hops outward from the core wallets. Each hop resolves the funders
    // discovered by the previous one, within the remaining lookup budget; the funding cache
    // makes already-seen wallets free. The funder fan-out shrinks each hop in practice.
    const funding = new Map<string, WalletFunding>();
    let frontier = [...new Set(coreAddresses)];
    let coreResolved = 0;
    // Each hop spends from the shared budget (core wallets first); once it's exhausted,
    // deeper hops still extend the graph from cache hits at no API cost.
    for (let hop = 0; hop < MAX_FUNDING_HOPS && frontier.length; hop++) {
      const { map, newLookups } = await this.resolveFunding(frontier, Math.max(0, remaining));
      remaining -= newLookups;
      for (const [address, record] of map) if (!funding.has(address)) funding.set(address, record);
      if (hop === 0) coreResolved = coreAddresses.filter((address) => funding.has(address)).length;

      const next = new Set<string>();
      for (const address of frontier) {
        for (const inflow of this.fundersOf(funding.get(address))) {
          if (!funding.has(inflow.from)) next.add(inflow.from);
        }
      }
      frontier = [...next];
    }

    const creatorFunders = new Set(this.fundersOf(funding.get(creatorKey)).map((inflow) => inflow.from));

    // Out-degree of every funder we touched, to flag public dispersers (never the creator).
    const allFunders = [...new Set([...funding.values()].flatMap((record) => this.fundersOf(record).map((inflow) => inflow.from)))];
    const funderCounts = await this.repository.getFunderCounts(allFunders);
    // A tagged rug bot is a deliberate target, never a "public disperser", even when it has
    // seeded many wallets — so exempt it (like the creator) from the out-degree heuristic.
    const isPublic = (funder: string): boolean =>
      funder !== creatorKey && !rugBots.has(funder) && (SEED_PUBLIC_FUNDERS.has(funder) || (funderCounts.get(funder) ?? 0) >= PUBLIC_FUNDER_THRESHOLD);

    // Union each wallet with every (non-public) funder it ever received ETH from, so wallets
    // that share any private funder — directly or through a chain — merge into one cluster.
    const dsu = new DisjointSet();
    for (const [address, record] of funding) {
      for (const inflow of this.fundersOf(record)) {
        if (!isPublic(inflow.from)) dsu.union(address, inflow.from);
      }
    }
    const creatorRoot = dsu.find(creatorKey);
    // Cluster roots that contain a tagged rug bot — any wallet under one of these roots is
    // insider by association, just like the creator's own cluster.
    const rugRoots = new Set([...rugBots].map((bot) => dsu.find(bot)));

    let insiderQuoteRaw = 0n;
    let totalQuoteRaw = 0n;
    let insiderBuyerCount = 0;
    let externalBuyerCount = 0;
    let complete = coreResolved >= coreAddresses.length;

    // First pass: classify each buyer.
    const classified: ClassifiedBuyer[] = ordered.map((trader) => {
      totalQuoteRaw += trader.quoteRaw;
      const record = funding.get(trader.address);
      const funders = this.fundersOf(record);
      const primary = funders[0] ?? null;
      const classification = this.classifyOne(trader.address, creatorKey, creatorFunders, funders, dsu, creatorRoot, isPublic, rugBots, rugRoots);
      if (!record) complete = false;
      if (classification === "external") externalBuyerCount += 1;
      else { insiderBuyerCount += 1; insiderQuoteRaw += trader.quoteRaw; }
      return {
        address: trader.address,
        classification,
        fundingSource: primary?.from ?? null,
        fundingTxHash: primary?.txHash ?? null,
        fundingVia: primary?.via ?? null,
        funderCount: funders.length,
        clusterId: null,
        quoteRaw: trader.quoteRaw,
        tradeCount: trader.tradeCount,
        firstTradeMs: trader.firstTradeMs
      };
    });

    const clusters = this.buildClusters(classified, funding, creatorFunders, isPublic);
    const graph = this.buildGraph(classified, funding, creatorKey, creatorRoot, dsu, isPublic, rugBots, rugRoots);
    const creatorFundingSource = [...creatorFunders][0] ?? null;
    return { creatorFundingSource, buyers: classified, clusters, graph, insiderQuoteRaw, totalQuoteRaw, insiderBuyerCount, externalBuyerCount, complete };
  }

  // On-demand bidirectional walk of the ETH funding graph around one address, independent of
  // any launch. Walks both incoming funders (cache + live) and outgoing funded wallets
  // (cached reverse edges + a bounded live fetch), out to RESEARCH_HOPS, so the deep bot
  // connections the launch-anchored classifier misses can be surfaced manually. Tagged rug
  // bots are exempt from the public-disperser heuristic so a prolific bot's cluster holds.
  async research(address: string, opts: { maxNewLookups?: number; hops?: number; rugBots?: string[] } = {}): Promise<IntelResearch> {
    const seed = address.toLowerCase();
    const hops = opts.hops ?? RESEARCH_HOPS;
    let remaining = opts.maxNewLookups ?? RESEARCH_MAX_LOOKUPS;
    const rugBots = new Set((opts.rugBots ?? []).map((bot) => bot.toLowerCase()));

    type Dir = "seed" | "funder" | "funded" | "both";
    const meta = new Map<string, { direction: Dir; hops: number; via: "external" | "internal" | null; txHash: string | null }>();
    meta.set(seed, { direction: "seed", hops: 0, via: null, txHash: null });

    // Every discovered funding edge: `funder` sent ETH to `child`. Deduped by child|funder.
    const edges: { child: string; funder: string; via: "external" | "internal"; txHash: string | null }[] = [];
    const edgeKeys = new Set<string>();
    const funding = new Map<string, WalletFunding>();

    const seen = new Set<string>([seed]);
    let frontier = [seed];

    for (let hop = 0; hop < hops && frontier.length; hop++) {
      // Incoming funders (cache-first, live within budget). Interactive priority so the
      // user's research jumps ahead of the background indexing/refresh loops on the limiter.
      const { map, newLookups } = await this.resolveFunding(frontier, Math.max(0, remaining), REQUEST_PRIORITY.INTERACTIVE);
      remaining -= newLookups;
      for (const [addr, record] of map) if (!funding.has(addr)) funding.set(addr, record);

      // Outgoing edges: cached reverse index (free) plus a bounded live fetch so a cold bot
      // — never touched by prior launch analyses — still reveals the wallets it funded.
      const discovered: { child: string; funder: string; via: "external" | "internal"; txHash: string | null; from: Dir }[] = [];
      for (const addr of frontier) {
        for (const inflow of this.fundersOf(funding.get(addr))) {
          discovered.push({ child: addr, funder: inflow.from, via: inflow.via, txHash: inflow.txHash || null, from: "funder" });
        }
      }
      for (const edge of await this.repository.getWalletsFundedBy(frontier)) {
        discovered.push({ child: edge.address, funder: edge.funder, via: edge.via, txHash: edge.txHash, from: "funded" });
      }
      for (const addr of frontier) {
        if (remaining <= 0) break;
        try {
          const outgoing = await this.etherscan.getOutgoingTransfers(addr, RESEARCH_OUT_FANOUT, { priority: REQUEST_PRIORITY.INTERACTIVE });
          remaining -= 1;
          for (const out of outgoing) discovered.push({ child: out.from, funder: addr, via: out.via, txHash: out.hash || null, from: "funded" });
        } catch (error) {
          console.warn(`Outgoing lookup failed for ${addr}: ${error instanceof Error ? error.message : error}`);
        }
      }

      const next = new Set<string>();
      for (const edge of discovered) {
        const key = `${edge.child}|${edge.funder}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          edges.push({ child: edge.child, funder: edge.funder, via: edge.via, txHash: edge.txHash });
        }
        // The neighbor is whichever endpoint isn't the frontier wallet that produced the edge.
        const neighbor = edge.from === "funder" ? edge.funder : edge.child;
        const existing = meta.get(neighbor);
        if (!existing) {
          meta.set(neighbor, { direction: edge.from, hops: hop + 1, via: edge.via, txHash: edge.txHash });
        } else if (existing.direction !== "seed" && existing.direction !== edge.from) {
          existing.direction = "both";
        }
        if (!seen.has(neighbor)) { seen.add(neighbor); next.add(neighbor); }
      }
      frontier = [...next];
    }

    // The walk completed if it exhausted the graph without running out of budget mid-way.
    const complete = frontier.length === 0 && remaining > 0;

    // Cluster membership: treat funding edges as undirected, drop public dispersers (but
    // never the seed or a tagged rug bot), and ask which wallets share the seed's component.
    const funderCounts = await this.repository.getFunderCounts([...new Set(edges.map((edge) => edge.funder))]);
    const isPublic = (funder: string): boolean =>
      funder !== seed && !rugBots.has(funder) && (SEED_PUBLIC_FUNDERS.has(funder) || (funderCounts.get(funder) ?? 0) >= PUBLIC_FUNDER_THRESHOLD);
    const dsu = new DisjointSet();
    for (const edge of edges) if (!isPublic(edge.funder)) dsu.union(edge.child, edge.funder);
    const seedRoot = dsu.find(seed);
    const inCluster = (addr: string): boolean => dsu.find(addr) === seedRoot;

    const connections: ResearchConnectionRaw[] = [...meta.entries()]
      .filter(([addr]) => addr !== seed)
      .map(([addr, info]) => ({ address: addr, direction: info.direction, hops: info.hops, inCluster: inCluster(addr), via: info.via, txHash: info.txHash }))
      // Cluster members first, then by closeness, so the strongest links surface at the top.
      .sort((a, b) => Number(b.inCluster) - Number(a.inCluster) || a.hops - b.hops)
      .slice(0, RESEARCH_MAX_CONNECTIONS);

    const graph = this.buildResearchGraph(seed, connections, edges, rugBots, inCluster);
    return { address: seed, connections, graph, walletsExplored: meta.size, complete };
  }

  // Node/edge graph for the research panel. Includes the seed plus the highest-priority
  // connections (cluster members and rug bots first) up to RESEARCH_GRAPH_MAX_NODES.
  private buildResearchGraph(
    seed: string,
    connections: ResearchConnectionRaw[],
    edges: { child: string; funder: string }[],
    rugBots: Set<string>,
    inCluster: (addr: string) => boolean
  ): IntelGraph {
    const ranked = [...connections].sort((a, b) =>
      Number(rugBots.has(b.address)) - Number(rugBots.has(a.address)) ||
      Number(b.inCluster) - Number(a.inCluster) ||
      a.hops - b.hops
    );
    const included = new Set<string>([seed]);
    for (const connection of ranked) {
      if (included.size >= RESEARCH_GRAPH_MAX_NODES) break;
      included.add(connection.address);
    }

    const graphEdges = edges
      .filter((edge) => included.has(edge.child) && included.has(edge.funder))
      .map((edge) => ({ from: edge.child, to: edge.funder }));

    const nodes: IntelGraphNode[] = [...included].map((address) => {
      if (address === seed) return { address, role: "seed", clusterId: null };
      if (rugBots.has(address)) return { address, role: "rug", clusterId: null };
      return { address, role: inCluster(address) ? "insider" : "funder", clusterId: null };
    });
    return { nodes, edges: graphEdges };
  }

  // All funders of a wallet, tolerating legacy cached docs that predate the `funders` array
  // (those carry only the single scalar fundingSource).
  private fundersOf(record: WalletFunding | undefined): FundingInflow[] {
    if (!record) return [];
    if (record.funders?.length) return record.funders;
    if (record.fundingSource) {
      return [{ from: record.fundingSource, via: "external", txHash: record.fundingTxHash ?? "", value: "0", timeStamp: 0 }];
    }
    return [];
  }

  // Build a funding-relationship graph: the top traders, the creator, and several hops of
  // their private funders, with an edge from each wallet to every wallet that funded it.
  private buildGraph(
    buyers: ClassifiedBuyer[],
    funding: Map<string, WalletFunding>,
    creatorKey: string,
    creatorRoot: string,
    dsu: DisjointSet,
    isPublic: (funder: string) => boolean,
    rugBots: Set<string>,
    rugRoots: Set<string>
  ): IntelGraph {
    const fundersOfAddr = (address: string): string[] =>
      this.fundersOf(funding.get(address)).map((inflow) => inflow.from).filter((from) => !isPublic(from));

    const included = new Set<string>([creatorKey, ...buyers.slice(0, GRAPH_MAX_TRADERS).map((buyer) => buyer.address)]);
    for (let hop = 0; hop < MAX_FUNDING_HOPS && included.size < GRAPH_MAX_NODES; hop++) {
      for (const address of [...included]) {
        for (const funder of fundersOfAddr(address)) {
          if (included.size >= GRAPH_MAX_NODES) break;
          included.add(funder);
        }
      }
    }

    const edges: { from: string; to: string }[] = [];
    for (const address of included) {
      for (const funder of fundersOfAddr(address)) {
        if (included.has(funder)) edges.push({ from: address, to: funder });
      }
    }

    const byAddress = new Map(buyers.map((buyer) => [buyer.address, buyer]));
    const nodes: IntelGraphNode[] = [...included].map((address) => {
      if (address === creatorKey) return { address, role: "creator", clusterId: 0 };
      if (rugBots.has(address)) return { address, role: "rug", clusterId: null };
      const buyer = byAddress.get(address);
      if (buyer) {
        const role: AttendeeNodeRole = buyer.classification === "rug-bot"
          ? "rug"
          : buyer.classification === "external"
            ? (buyer.clusterId != null ? "coordinated" : "external")
            : "insider";
        return { address, role, clusterId: buyer.clusterId };
      }
      // Funder-only node: red if it sits inside the creator's or a rug bot's cluster.
      const root = dsu.find(address);
      return { address, role: root === creatorRoot || rugRoots.has(root) ? "insider" : "funder", clusterId: null };
    });

    return { nodes, edges };
  }

  private classifyOne(
    address: string,
    creatorKey: string,
    creatorFunders: Set<string>,
    funders: FundingInflow[],
    dsu: DisjointSet,
    creatorRoot: string,
    isPublic: (funder: string) => boolean,
    rugBots: Set<string>,
    rugRoots: Set<string>
  ): AttendeeClass {
    if (address === creatorKey) return "creator";
    // A manually-tagged rug bot, or any wallet sharing its funding cluster, is insider.
    if (rugBots.has(address) || rugRoots.has(dsu.find(address))) return "rug-bot";
    if (funders.some((inflow) => inflow.from === creatorKey)) return "creator-funded";
    if (funders.some((inflow) => creatorFunders.has(inflow.from) && !isPublic(inflow.from))) return "same-funder";
    if (dsu.find(address) === creatorRoot) return "linked";
    return "external";
  }

  // Cluster 0 is always the creator's insider group; coordinated rings are groups of
  // external buyers (>= MIN_COORDINATED_CLUSTER) that share any one private funder.
  private buildClusters(buyers: ClassifiedBuyer[], funding: Map<string, WalletFunding>, creatorFunders: Set<string>, isPublic: (funder: string) => boolean): IntelCluster[] {
    const clusters: IntelCluster[] = [];

    const insiders = buyers.filter((b) => b.classification !== "external");
    if (insiders.length) {
      for (const buyer of insiders) buyer.clusterId = 0;
      clusters.push({
        id: 0,
        kind: "creator-insider",
        fundingSource: [...creatorFunders][0] ?? null,
        memberCount: insiders.length,
        quoteRaw: insiders.reduce((sum, b) => sum + b.quoteRaw, 0n)
      });
    }

    // Group external buyers by every private funder they share, then keep the funders that
    // tie together enough buyers. A buyer is assigned to the first (largest-priority) ring.
    const byFunder = new Map<string, ClassifiedBuyer[]>();
    for (const buyer of buyers) {
      if (buyer.classification !== "external") continue;
      for (const inflow of this.fundersOf(funding.get(buyer.address))) {
        if (isPublic(inflow.from)) continue;
        const group = byFunder.get(inflow.from) ?? [];
        group.push(buyer);
        byFunder.set(inflow.from, group);
      }
    }
    let nextId = 1;
    for (const [funder, group] of [...byFunder.entries()].sort((a, b) => b[1].length - a[1].length)) {
      const fresh = group.filter((buyer) => buyer.clusterId == null);
      if (fresh.length < MIN_COORDINATED_CLUSTER) continue;
      const id = nextId++;
      for (const buyer of fresh) buyer.clusterId = id;
      clusters.push({ id, kind: "coordinated", fundingSource: funder, memberCount: fresh.length, quoteRaw: fresh.reduce((sum, b) => sum + b.quoteRaw, 0n) });
    }

    return clusters;
  }

  // Cache-first funding resolution. Up to `maxNew` uncached addresses are fetched from
  // Etherscan (2 requests each; the rest are left for a later pass once the cache warms).
  // Returns the resolved map plus the number of fresh wallet lookups performed.
  private async resolveFunding(addresses: string[], maxNew: number, priority: number = REQUEST_PRIORITY.BACKGROUND): Promise<{ map: Map<string, WalletFunding>; newLookups: number }> {
    const keys = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (!keys.length) return { map: new Map(), newLookups: 0 };

    const cached = await this.repository.getWalletFundings(keys);
    const result = new Map(cached);
    const missing = keys.filter((key) => !result.has(key));

    const toFetch = missing.slice(0, Math.max(0, maxNew));
    const fetched: WalletFunding[] = [];
    for (const address of toFetch) {
      try {
        const inflows = await this.etherscan.getIncomingTransfers(address, MAX_FUNDERS_PER_WALLET, { priority });
        const primary = inflows[0];
        const record: WalletFunding = {
          address,
          funders: inflows.map((inflow) => ({ from: inflow.from, via: inflow.via, txHash: inflow.hash, value: inflow.value, timeStamp: inflow.timeStamp })),
          fundingSource: primary ? primary.from : null,
          fundingTxHash: primary ? primary.hash : null,
          firstFundedAt: primary ? new Date(primary.timeStamp * 1000).toISOString() : null,
          fundingAmount: primary ? `${Number(formatEther(primary.value)).toFixed(4)} ETH` : null,
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
