import "dotenv/config";
import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import mongoose from "mongoose";
import { AerodromeAnalyzer } from "./AerodromeAnalyzer.js";
import { EtherscanService } from "./EtherscanService.js";
import { LaunchIndexer } from "./LaunchIndexer.js";
import { LaunchRepository } from "./LaunchRepository.js";
import { MarketDataService } from "./MarketDataService.js";
import { PriceService } from "./PriceService.js";
import type { CreatorSort, LaunchSort, PoolType } from "../types.js";

const port = process.env.PORT || 4000;
const startBlock = Number(process.env.BASE_START_BLOCK || 3200000);
const logChunk = Math.min(Math.max(Number(process.env.BASE_LOG_CHUNK) || 2000, 1), 2000);
const app = express();
const etherscan = process.env.BASESCAN_API_KEY ? new EtherscanService(process.env.BASESCAN_API_KEY) : null;
const priceService = etherscan ? new PriceService(etherscan) : null;
const analyzer = new AerodromeAnalyzer({
  rpcUrl: process.env.BASE_RPC_URL,
  etherscan,
  priceService,
  logChunk
});
let indexer: LaunchIndexer | null = null;

app.use(cors({ origin: "*" }));
app.use(express.json());

app.get("/api/status", (_request, response) => {
  response.json({
    mode: analyzer.mode,
    network: "Base",
    factory: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
    mongodb: mongoose.connection.readyState === 1,
    indexer: indexer?.status
  });
});

app.get("/api/launches", async (request, response, next) => {
  try {
    const limit = Math.min(Math.max(Number(request.query.limit) || 30, 1), 100);
    const poolType = ["all", "stable", "volatile"].includes(String(request.query.poolType))
      ? request.query.poolType as PoolType
      : undefined;
    const sort = ["newest", "oldest", "liquidity", "volume"].includes(String(request.query.sort))
      ? request.query.sort as LaunchSort
      : "newest";
    response.json(await analyzer.getLaunches({
      cursor: typeof request.query.cursor === "string" ? request.query.cursor : undefined,
      search: typeof request.query.search === "string" ? request.query.search.trim() : undefined,
      poolType,
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

app.get("/api/rpc-usage", (_request, response) => {
  response.json(analyzer.getRpcUsage());
});

app.post("/api/market-data/refresh", async (request, response, next) => {
  try {
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

app.get("/api/launches/stats", async (_request, response, next) => {
  try {
    response.json(await analyzer.getLaunchStats());
  } catch (error) {
    next(error);
  }
});

app.get("/api/launches/analytics/daily", async (request, response, next) => {
  try {
    const days = Math.min(Math.max(Number(request.query.days) || 30, 7), 90);
    response.json(await analyzer.getDailyAnalytics(days));
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
    response.json(await analyzer.getCreators({
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
    response.json(await analyzer.getCreator(request.params.address));
  } catch (error) {
    next(error);
  }
});

app.get("/api/launches/:poolAddress/trades", async (request, response, next) => {
  try {
    response.json(await analyzer.getFirstTrades(request.params.poolAddress));
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
      const repository = new LaunchRepository();
      analyzer.repository = repository;
      if (analyzer.mode === "live") {
        indexer = new LaunchIndexer({ analyzer, repository, marketDataService: new MarketDataService(etherscan, priceService, analyzer.provider), startBlock, blockChunk: logChunk });
      }
    } catch (error) {
      console.error("MongoDB connection failed:", error);
    }
  } else if (analyzer.mode === "live") {
    console.warn("MONGODB_URI is required to index and cache live launch data.");
  }

  app.listen(port, () => {
    console.log(`Aerodrome analyzer API listening on http://localhost:${port} (${analyzer.mode} mode)`);
    indexer?.start();
  });
}

void start();

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
