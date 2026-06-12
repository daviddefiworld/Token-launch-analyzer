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
import { DEFAULT_DEX_ID, listAdapters } from "./skills/registry.js";
import type { CreatorSort, DexInfo, LaunchSort } from "../types.js";

const port = process.env.PORT || 4000;
const startBlock = Number(process.env.BASE_START_BLOCK || 3200000);
const logChunk = Math.min(Math.max(Number(process.env.BASE_LOG_CHUNK) || 2000, 1), 2000);
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
app.use(express.json());

app.get("/api/dexes", (_request, response) => {
  response.json(dexInfos);
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

const errorHandler: ErrorRequestHandler = (error: Error, _request, response, _next) => {
  console.error(error);
  response.status(error.message === "Launch not found" ? 404 : 500).json({ error: error.message });
};

app.use(errorHandler);

async function start(): Promise<void> {
  if (process.env.MONGODB_URI) {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      for (const adapter of adapters) {
        const analyzer = analyzers.get(adapter.id)!;
        // The default adapter also clears any pre-multi-DEX cached launches on first run.
        const repository = new LaunchRepository(adapter.id, adapter.id === DEFAULT_DEX_ID);
        analyzer.repository = repository;
        if (analyzer.mode === "live") {
          const marketDataService = new MarketDataService(adapter, etherscan, priceService, analyzer.provider);
          indexers.set(adapter.id, new LaunchIndexer({ analyzer, repository, marketDataService, startBlock, blockChunk: logChunk }));
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
    for (const indexer of indexers.values()) indexer.start();
  });
}

void start();

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
