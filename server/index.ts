import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler, type Request } from "express";
import mongoose from "mongoose";
import { LaunchAnalyzer } from "./LaunchAnalyzer.js";
import { EtherscanService } from "./EtherscanService.js";
import { LaunchIndexer } from "./LaunchIndexer.js";
import { LaunchRepository } from "./LaunchRepository.js";
import { MarketDataService } from "./MarketDataService.js";
import { PriceService } from "./PriceService.js";
import { RpcMetricsProvider } from "./RpcMetricsProvider.js";
import { WalletIntelService } from "./WalletIntelService.js";
import { exportDatabase, importDatabase, parseBackup } from "./BackupService.js";
import { DEFAULT_DEX_ID, listAdapters } from "./skills/registry.js";
import type { CreatorSort, DexInfo, LaunchSort, ResearchReport, WalletLabelKind } from "../types.js";

const port = process.env.PORT || 4000;
const startBlock = Number(process.env.BASE_START_BLOCK || 3200000);
const logChunk = Math.min(Math.max(Number(process.env.BASE_LOG_CHUNK) || 2000, 1), 2000);
// Background refresh loops only monitor launches newer than this, to cap Etherscan usage.
const monitorWindowHours = Math.max(Number(process.env.MONITOR_WINDOW_HOURS) || 24, 1);
const app = express();

// Shared infrastructure: one RPC provider, one rate-limited Etherscan client, and one
// price service, reused across every DEX adapter so rate limits and RPC metrics aggregate.
const provider = process.env.BASE_RPC_URL ? new RpcMetricsProvider(process.env.BASE_RPC_URL) : null;
const etherscan = process.env.BASESCAN_API_KEY ? new EtherscanService(process.env.BASESCAN_API_KEY) : null;
const priceService = etherscan ? new PriceService(etherscan) : null;

const adapters = listAdapters();
// One analyzer (and, in live mode, one indexer) per supported DEX. The ?dex= query param
// selects which one a request targets, defaulting to DEFAULT_DEX_ID.
const analyzers = new Map<string, LaunchAnalyzer>(
  adapters.map((adapter) => [adapter.id, new LaunchAnalyzer({ adapter, provider, etherscan, priceService, logChunk })])
);
const indexers = new Map<string, LaunchIndexer>();

const dexInfos: DexInfo[] = adapters.map((adapter) => ({
  id: adapter.id,
  label: adapter.label,
  network: adapter.network,
  factory: adapter.factoryAddress,
  poolTypeOptions: adapter.poolTypeOptions
}));

function resolveAnalyzer(request: Request): LaunchAnalyzer {
  const dex = typeof request.query.dex === "string" ? request.query.dex : "";
  return analyzers.get(dex) ?? analyzers.get(DEFAULT_DEX_ID)!;
}

app.use(cors({ origin: "*" }));
// Generous limit: a full DB backup uploaded to /api/backup/import can be many megabytes.
app.use(express.json({ limit: "256mb" }));

app.get("/api/dexes", (_request, response) => {
  response.json(dexInfos);
});

// Live per-DEX indexer state, for the start/stop controls.
app.get("/api/indexers", (_request, response) => {
  response.json(adapters.map((adapter) => {
    const indexer = indexers.get(adapter.id);
    return {
      dex: adapter.id,
      available: Boolean(indexer),
      enabled: indexer?.status.enabled ?? false,
      isRunning: indexer?.status.isRunning ?? false,
      indexedBlock: indexer?.status.indexedBlock ?? null,
      latestBlock: indexer?.status.latestBlock ?? null,
      error: indexer?.status.error ?? null
    };
  }));
});

app.post("/api/dex/:dex/start", (request, response) => {
  const indexer = indexers.get(request.params.dex);
  if (!indexer) {
    response.status(404).json({ error: "No indexer for this DEX (requires live mode + MongoDB)" });
    return;
  }
  indexer.start();
  response.json({ dex: request.params.dex, enabled: true });
});

app.post("/api/dex/:dex/stop", (request, response) => {
  const indexer = indexers.get(request.params.dex);
  if (!indexer) {
    response.status(404).json({ error: "No indexer for this DEX" });
    return;
  }
  indexer.stop();
  response.json({ dex: request.params.dex, enabled: false });
});

app.get("/api/status", (request, response) => {
  const analyzer = resolveAnalyzer(request);
  response.json({
    mode: analyzer.mode,
    dex: analyzer.dexId,
    network: analyzer.adapter.network,
    factory: analyzer.adapter.factoryAddress,
    mongodb: mongoose.connection.readyState === 1,
    indexer: indexers.get(analyzer.dexId)?.status,
    availableDexes: dexInfos
  });
});

app.get("/api/launches", async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);
    const sort = ["newest", "oldest", "liquidity", "volume"].includes(String(request.query.sort))
      ? request.query.sort as LaunchSort
      : "newest";
    response.json(await resolveAnalyzer(request).getLaunches({
      cursor: typeof request.query.cursor === "string" ? request.query.cursor : undefined,
      search: typeof request.query.search === "string" ? request.query.search.trim() : undefined,
      poolType: typeof request.query.poolType === "string" ? request.query.poolType : undefined,
      minLiquidityUsd: toOptionalNumber(request.query.minLiquidityUsd),
      minVolumeUsd: toOptionalNumber(request.query.minVolumeUsd),
      createdWithinDays: toOptionalNumber(request.query.createdWithinDays),
      sort,
      limit
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/rpc-usage", (request, response) => {
  response.json(resolveAnalyzer(request).getRpcUsage());
});

app.post("/api/market-data/refresh", async (request, response, next) => {
  try {
    const indexer = indexers.get(resolveAnalyzer(request).dexId);
    if (!indexer) {
      response.status(503).json({ error: "Market data refresh requires live indexing" });
      return;
    }
    const limit = Math.min(Math.max(Number(request.query.limit) || 50, 1), 100);
    // Refresh in the background so the request returns immediately; the UI polls for results.
    void indexer.refreshMarketData(limit, true).catch((error) => {
      console.warn(`Manual market refresh failed: ${error instanceof Error ? error.message : error}`);
    });
    response.json({ started: true, limit });
  } catch (error) {
    next(error);
  }
});

app.get("/api/launches/stats", async (request, response, next) => {
  try {
    response.json(await resolveAnalyzer(request).getLaunchStats());
  } catch (error) {
    next(error);
  }
});

app.get("/api/launches/analytics/daily", async (request, response, next) => {
  try {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 7), 90);
    response.json(await resolveAnalyzer(request).getDailyAnalytics(days));
  } catch (error) {
    next(error);
  }
});

app.get("/api/creators", async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);
    const sort = ["launchCount", "newest", "oldest"].includes(String(request.query.sort))
      ? request.query.sort as CreatorSort
      : "launchCount";
    response.json(await resolveAnalyzer(request).getCreators({
      cursor: typeof request.query.cursor === "string" ? request.query.cursor : undefined,
      search: typeof request.query.search === "string" ? request.query.search.trim() : undefined,
      sort,
      limit
    }));
  } catch (error) {
    next(error);
  }
});

app.get("/api/creators/:address", async (request, response, next) => {
  try {
    response.json(await resolveAnalyzer(request).getCreator(request.params.address));
  } catch (error) {
    next(error);
  }
});

app.get("/api/launches/:poolAddress/trades", async (request, response, next) => {
  try {
    response.json(await resolveAnalyzer(request).getFirstTrades(request.params.poolAddress));
  } catch (error) {
    next(error);
  }
});

app.get("/api/launches/:poolAddress/attendees", async (request, response, next) => {
  try {
    response.json(await resolveAnalyzer(request).getAttendees(request.params.poolAddress));
  } catch (error) {
    next(error);
  }
});

app.post("/api/launches/:poolAddress/attendees/analyze", async (request, response, next) => {
  try {
    const analyzer = resolveAnalyzer(request);
    const indexer = indexers.get(analyzer.dexId);
    if (!indexer) {
      response.status(503).json({ error: "Attendee analysis requires live indexing" });
      return;
    }
    const pool = request.params.poolAddress;
    // Validate the cheap precondition up front so the UI gets a clear reason instead of an
    // analysis that silently produces nothing (the swap classifier needs a known quote token
    // to value trades). The heavy funding lookups still run in the background below.
    const launch = await analyzer.getLaunch(pool);
    if (!launch) {
      response.status(404).json({ error: "Launch not found" });
      return;
    }
    if (!launch.quoteAddress) {
      response.status(422).json({ error: "This launch's quote token isn't recognized on-chain, so swap-level attendee analysis isn't available for it." });
      return;
    }
    // Runs in the background (funding lookups can take a while); the UI polls the GET.
    void indexer.analyzeLaunchNow(pool).catch((error) => {
      console.warn(`Attendee analysis failed for ${pool}: ${error instanceof Error ? error.message : error}`);
    });
    response.json({ started: true });
  } catch (error) {
    next(error);
  }
});

// ---- Manual wallet labels (rug bots / watchlist) — global across DEXes ----

const VALID_LABEL_KINDS: WalletLabelKind[] = ["rug-bot", "watch"];

app.get("/api/labels", async (request, response, next) => {
  try {
    const repository = resolveAnalyzer(request).repository;
    if (!repository) {
      response.json([]);
      return;
    }
    response.json(await repository.getWalletLabels());
  } catch (error) {
    next(error);
  }
});

app.post("/api/labels", async (request, response, next) => {
  try {
    const repository = resolveAnalyzer(request).repository;
    if (!repository) {
      response.status(503).json({ error: "Labeling requires live mode + MongoDB" });
      return;
    }
    const address = typeof request.body?.address === "string" ? request.body.address.trim() : "";
    const kind = request.body?.kind as WalletLabelKind;
    const note = typeof request.body?.note === "string" ? request.body.note.trim() || null : null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      response.status(422).json({ error: "A valid 0x wallet address is required" });
      return;
    }
    if (!VALID_LABEL_KINDS.includes(kind)) {
      response.status(422).json({ error: `kind must be one of: ${VALID_LABEL_KINDS.join(", ")}` });
      return;
    }
    response.json(await repository.setWalletLabel(address, kind, note));
  } catch (error) {
    next(error);
  }
});

app.delete("/api/labels/:address", async (request, response, next) => {
  try {
    const repository = resolveAnalyzer(request).repository;
    if (!repository) {
      response.status(503).json({ error: "Labeling requires live mode + MongoDB" });
      return;
    }
    await repository.removeWalletLabel(request.params.address);
    response.json({ removed: true });
  } catch (error) {
    next(error);
  }
});

// On-demand research walk around one address (cache-first, bounded live fetch). Returns the
// funding-graph connections and whether the address ties into any tagged rug bot's cluster.
app.get("/api/research/:address", async (request, response, next) => {
  try {
    const analyzer = resolveAnalyzer(request);
    const { repository, walletIntel } = analyzer;
    if (!repository || !walletIntel) {
      response.status(503).json({ error: "Address research requires live mode (BASESCAN_API_KEY + MongoDB)" });
      return;
    }
    const address = request.params.address.trim().toLowerCase();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
      response.status(422).json({ error: "A valid 0x wallet address is required" });
      return;
    }
    const labelMap = await repository.getWalletLabelMap();
    const rugBots = [...labelMap.entries()].filter(([, kind]) => kind === "rug-bot").map(([wallet]) => wallet);

    const research = await walletIntel.research(address, { rugBots });
    const linkedRugBots = research.connections.filter((connection) => labelMap.get(connection.address) === "rug-bot").map((connection) => connection.address);
    const seedLabel = labelMap.get(address) ?? null;
    const rugConnected = seedLabel === "rug-bot" || research.connections.some((connection) => connection.inCluster && labelMap.get(connection.address) === "rug-bot");

    const report: ResearchReport = {
      address: research.address,
      label: seedLabel,
      rugConnected,
      connectionCount: research.connections.length,
      linkedRugBots,
      connections: research.connections.map((connection) => ({ ...connection, label: labelMap.get(connection.address) ?? null })),
      graph: { nodes: research.graph.nodes.map((node) => ({ ...node, volumeUsd: null })), edges: research.graph.edges },
      walletsExplored: research.walletsExplored,
      complete: research.complete,
      updatedAt: new Date().toISOString()
    };
    response.json(report);
  } catch (error) {
    next(error);
  }
});

// ---- Full backup: export every collection (data + indexer settings) to one JSON file,
// and restore the whole database from such a file. ----

app.get("/api/backup/export", async (_request, response, next) => {
  try {
    const db = mongoose.connection.db;
    if (mongoose.connection.readyState !== 1 || !db) {
      response.status(503).json({ error: "Export requires live mode + MongoDB" });
      return;
    }
    const stamp = new Date();
    const json = await exportDatabase(db, stamp.toISOString());
    const filename = `launch-analyzer-backup-${stamp.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    response.send(json);
  } catch (error) {
    next(error);
  }
});

app.post("/api/backup/import", async (request, response, next) => {
  try {
    const db = mongoose.connection.db;
    if (mongoose.connection.readyState !== 1 || !db) {
      response.status(503).json({ error: "Import requires live mode + MongoDB" });
      return;
    }
    // express.json() already parsed the uploaded backup into a plain object (the $-prefixed
    // Extended-JSON wrappers survive as ordinary keys). Re-stringify so parseBackup can run it
    // back through EJSON.parse and reconstruct the BSON types (ObjectId _ids, etc.).
    const raw = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
    let backup;
    try {
      backup = parseBackup(raw);
    } catch (error) {
      response.status(422).json({ error: error instanceof Error ? error.message : "Invalid backup file" });
      return;
    }

    // Pause every running indexer first so an in-flight sync can't overwrite the data we're
    // about to restore. persist=false leaves the stored on/off flags untouched — the import
    // overwrites them anyway, and resume() below re-applies whatever the backup contained.
    const running = [...indexers.values()].filter((indexer) => indexer.status.enabled);
    for (const indexer of running) indexer.stop(false);

    const summary = await importDatabase(db, backup);

    // Rehydrate each indexer from the freshly-restored settings (checkpoint, on/off choice,
    // refresh throttles) and restart the ones the backup had enabled — so imported indexer
    // state takes effect live without a server restart.
    await Promise.all([...indexers.values()].map((indexer) => indexer.resume()));

    response.json({ imported: true, exportedAt: backup.exportedAt, collections: summary });
  } catch (error) {
    next(error);
  }
});

const errorHandler: ErrorRequestHandler = (error: Error, _request, response, _next) => {
  console.error(error);
  response.status(error.message === "Launch not found" ? 404 : 500).json({ error: error.message });
};

app.use(errorHandler);

async function start(): Promise<void> {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      // One shared funding cache / classifier across all DEXes — bot wallets are reused, so
      // a wallet investigated for one launch is served from cache for every other.
      let walletIntel: WalletIntelService | null = null;
      for (const adapter of adapters) {
        const analyzer = analyzers.get(adapter.id)!;
        // The default adapter also clears any pre-multi-DEX cached launches on first run.
        const repository = new LaunchRepository(adapter.id, adapter.id === DEFAULT_DEX_ID, monitorWindowHours);
        analyzer.repository = repository;
        if (etherscan && !walletIntel) walletIntel = new WalletIntelService(etherscan, repository);
        analyzer.walletIntel = walletIntel;
        if (analyzer.mode === "live") {
          const marketDataService = new MarketDataService(adapter, etherscan, priceService, analyzer.provider, walletIntel, repository);
          indexers.set(adapter.id, new LaunchIndexer({ analyzer, repository, marketDataService, startBlock, blockChunk: logChunk, defaultEnabled: adapter.id === DEFAULT_DEX_ID }));
        }
      }
    } catch (error) {
      console.error("MongoDB connection failed:", error);
    }
  } else if (provider) {
    console.warn("MONGODB_URI is required to index and cache live launch data.");
  }

  app.listen(port, () => {
    const mode = provider ? "live" : "demo";
    console.log(`Launch analyzer API listening on http://localhost:${port} (${mode} mode) — DEXes: ${adapters.map((adapter) => adapter.id).join(", ")}`);
    void Promise.all([...indexers.values()].map((indexer) => indexer.resume()));
  });
}

void start();

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
