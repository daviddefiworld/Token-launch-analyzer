import type { AttendeeBuyer, AttendeeClass, AttendeeCluster, AttendeeGraphEdge, AttendeeGraphNode, AttendeeNodeRole, AttendeeReport, CreatorProfile, CreatorSummary, DailyAnalyticsPoint, Launch, LaunchDailyAnalytics, Trade } from "../types.js";

export const demoLaunches: Launch[] = [
  {
    id: "0x08d7a39c3f546a781ff991cc28a31f9aa9c42401",
    dex: "aerodrome",
    poolAddress: "0x08d7a39c3f546a781ff991cc28a31f9aa9c42401",
    tokenAddress: "0x87f47f9b081a4a87e7e3cb7d288f7473d6c5b101",
    tokenSymbol: "NOVA",
    tokenCreatedAt: "2026-05-31T18:42:00.000Z",
    tokenCreatedBlock: 31056411,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "NOVA / WETH",
    creator: "0x74fca2de9ff5e05a802d41e190f4eb6ebc76ac81",
    createdAt: "2026-05-31T19:42:00.000Z",
    blockNumber: 31058211,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 84210,
    volumeUsd: 391420,
    firstTrades: 100,
    risk: "medium"
  },
  {
    id: "0xa92e6fb936ed12b26f5962ec2559df73f3eeb502",
    dex: "aerodrome",
    poolAddress: "0xa92e6fb936ed12b26f5962ec2559df73f3eeb502",
    tokenAddress: "0x924820b47126bda8dfd04d43c191e9705a1cb102",
    tokenSymbol: "FLUX",
    tokenCreatedAt: "2026-05-31T15:18:00.000Z",
    tokenCreatedBlock: 31050960,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "USDC",
    pair: "FLUX / USDC",
    creator: "0x45af1bb84985cb89083be2b9827449cd1034ee72",
    createdAt: "2026-05-31T16:18:00.000Z",
    blockNumber: 31052760,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 127900,
    volumeUsd: 218340,
    firstTrades: 100,
    risk: "low"
  },
  {
    id: "0xc5d74f1339cbba61e3d2272e0ca47e84d3c5b203",
    dex: "aerodrome",
    poolAddress: "0xc5d74f1339cbba61e3d2272e0ca47e84d3c5b203",
    tokenAddress: "0xaf41a2de9d5d32cb9d3d874212e9cb9c53df3103",
    tokenSymbol: "MINT",
    tokenCreatedAt: "2026-05-30T08:07:00.000Z",
    tokenCreatedBlock: 30939538,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "MINT / WETH",
    creator: "0x74fca2de9ff5e05a802d41e190f4eb6ebc76ac81",
    createdAt: "2026-05-30T09:07:00.000Z",
    blockNumber: 30941338,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 42680,
    volumeUsd: 88630,
    firstTrades: 94,
    risk: "high"
  },
  {
    id: "0x7ab29b5090abe11c2409f6984b33f99778bf6404",
    dex: "aerodrome",
    poolAddress: "0x7ab29b5090abe11c2409f6984b33f99778bf6404",
    tokenAddress: "0xf534ff993dce9d40a6995bc934623d29d36cb104",
    tokenSymbol: "OPAL",
    tokenCreatedAt: "2026-05-29T21:31:00.000Z",
    tokenCreatedBlock: 30901966,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "USDC",
    pair: "OPAL / USDC",
    creator: "0x3be6dbdbd4795723bb42af035e6fb599ebf02977",
    createdAt: "2026-05-29T22:31:00.000Z",
    blockNumber: 30903766,
    poolType: "stable",
    poolTypeLabel: "Stable",
    liquidityUsd: 310500,
    volumeUsd: 190240,
    firstTrades: 100,
    risk: "low"
  },
  {
    id: "0xf8072fe0179d639c27422112a2b99bb21ced2505",
    dex: "aerodrome",
    poolAddress: "0xf8072fe0179d639c27422112a2b99bb21ced2505",
    tokenAddress: "0xac4bcc5a4874bb09ae7860cb0d427baedbecc105",
    tokenSymbol: "EMBER",
    tokenCreatedAt: "2026-05-29T10:54:00.000Z",
    tokenCreatedBlock: 30864841,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "EMBER / WETH",
    creator: "0xa3ee959813eafe9df1f7428f9160d60354e73cc9",
    createdAt: "2026-05-29T11:54:00.000Z",
    blockNumber: 30866641,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 19120,
    volumeUsd: 72210,
    firstTrades: 67,
    risk: "high"
  },
  {
    id: "0x496ad4c89b7414433b4a59dbbe49cad4a34a4606",
    dex: "aerodrome",
    poolAddress: "0x496ad4c89b7414433b4a59dbbe49cad4a34a4606",
    tokenAddress: "0xe9fddc8af2db5e0219049af44a412663a11eb106",
    tokenSymbol: "VECTOR",
    tokenCreatedAt: "2026-05-28T17:22:00.000Z",
    tokenCreatedBlock: 30803306,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "VECTOR / WETH",
    creator: "0x8382d2d1fc40b70868586f0d4e0f254c9378bd38",
    createdAt: "2026-05-28T18:22:00.000Z",
    blockNumber: 30805106,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 63940,
    volumeUsd: 41290,
    firstTrades: 42,
    risk: "medium"
  },
  {
    id: "0x1c0a3f7b2d9e54a6b8f10c2d3e4f5061728394a7",
    dex: "uniswap-v3",
    poolAddress: "0x1c0a3f7b2d9e54a6b8f10c2d3e4f5061728394a7",
    tokenAddress: "0x55b2c1d9e3f4a6b7c8091a2b3c4d5e6f70819207",
    tokenSymbol: "ORBIT",
    tokenCreatedAt: "2026-05-31T12:05:00.000Z",
    tokenCreatedBlock: 31045220,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "ORBIT / WETH",
    creator: "0x9a17b3c2de45f6a7b8091c2d3e4f50617283a4b9",
    createdAt: "2026-05-31T13:05:00.000Z",
    blockNumber: 31047020,
    poolType: "3000",
    poolTypeLabel: "0.30%",
    liquidityUsd: 256800,
    volumeUsd: 612300,
    firstTrades: 100,
    risk: "medium"
  },
  {
    id: "0x2d1b4f8c3eaf65b7c9091d2e3f405162839405b8",
    dex: "uniswap-v3",
    poolAddress: "0x2d1b4f8c3eaf65b7c9091d2e3f405162839405b8",
    tokenAddress: "0x66c3d2eaf405b6c7d8192a3b4c5d6e7f8091a3b0",
    tokenSymbol: "PIXEL",
    tokenCreatedAt: "2026-05-30T20:48:00.000Z",
    tokenCreatedBlock: 30978500,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "USDC",
    pair: "PIXEL / USDC",
    creator: "0x74fca2de9ff5e05a802d41e190f4eb6ebc76ac81",
    createdAt: "2026-05-30T21:48:00.000Z",
    blockNumber: 30980300,
    poolType: "500",
    poolTypeLabel: "0.05%",
    liquidityUsd: 489100,
    volumeUsd: 845600,
    firstTrades: 100,
    risk: "low"
  },
  {
    id: "0x3e2c5a9d4fbf76c8da192e3f405162738495061c",
    dex: "uniswap-v3",
    poolAddress: "0x3e2c5a9d4fbf76c8da192e3f405162738495061c",
    tokenAddress: "0x77d4e3fb506c7d8e92a3b4c5d6e7f8091a2b4c01",
    tokenSymbol: "QUARK",
    tokenCreatedAt: "2026-05-29T06:12:00.000Z",
    tokenCreatedBlock: 30853110,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "QUARK / WETH",
    creator: "0x55ac1de9ff5e05a802d41e190f4eb6ebc76ac82",
    createdAt: "2026-05-29T07:12:00.000Z",
    blockNumber: 30854910,
    poolType: "10000",
    poolTypeLabel: "1.00%",
    liquidityUsd: 38400,
    volumeUsd: 51720,
    firstTrades: 73,
    risk: "high"
  },
  {
    id: "0x4f3d6bae50cf87d9eb1a2f3405162738495061d2",
    dex: "uniswap-v2",
    poolAddress: "0x4f3d6bae50cf87d9eb1a2f3405162738495061d2",
    tokenAddress: "0x88e5f40617d8e9fa2b3c4d5e6f7809102b3c4d12",
    tokenSymbol: "GROK",
    tokenCreatedAt: "2026-05-31T09:33:00.000Z",
    tokenCreatedBlock: 31040120,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "WETH",
    pair: "GROK / WETH",
    creator: "0x45af1bb84985cb89083be2b9827449cd1034ee72",
    createdAt: "2026-05-31T10:33:00.000Z",
    blockNumber: 31041920,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 71500,
    volumeUsd: 132450,
    firstTrades: 88,
    risk: "medium"
  },
  {
    id: "0x5a4e7cbf61d098eafc1b2e3405162738495061e3",
    dex: "uniswap-v2",
    poolAddress: "0x5a4e7cbf61d098eafc1b2e3405162738495061e3",
    tokenAddress: "0x99f6051728e9fab3c4d5e6f78091023b4c5d6e23",
    tokenSymbol: "BASED",
    tokenCreatedAt: "2026-05-30T03:27:00.000Z",
    tokenCreatedBlock: 30912740,
    tokenAgeAtLaunchHours: 1,
    quoteSymbol: "USDC",
    pair: "BASED / USDC",
    creator: "0x8382d2d1fc40b70868586f0d4e0f254c9378bd38",
    createdAt: "2026-05-30T04:27:00.000Z",
    blockNumber: 30914540,
    poolType: "volatile",
    poolTypeLabel: "Volatile",
    liquidityUsd: 24300,
    volumeUsd: 60780,
    firstTrades: 54,
    risk: "high"
  }
];

// Synthesize attendee-intelligence aggregates so the real-volume column and sybil badges
// are populated in demo mode. Ratios are hand-picked per launch to show a range.
const DEMO_INSIDER_RATIOS = [0.42, 0.08, 0.61, 0.05, 0.55, 0.18, 0.34, 0.11, 0.72, 0.27, 0.49];
for (const [index, launch] of demoLaunches.entries()) {
  const insiderRatio = DEMO_INSIDER_RATIOS[index] ?? 0.2;
  const approxBuyers = Math.max(3, Math.round((launch.firstTrades ?? 30) / 3));
  launch.insiderRatio = insiderRatio;
  launch.insiderVolumeUsd = Math.round((launch.volumeUsd ?? 0) * insiderRatio);
  launch.externalVolumeUsd = (launch.volumeUsd ?? 0) - launch.insiderVolumeUsd;
  launch.insiderBuyerCount = Math.round(approxBuyers * insiderRatio);
  launch.externalBuyerCount = approxBuyers - launch.insiderBuyerCount;
  launch.intelUpdatedAt = launch.createdAt;
}

const wallets = [
  "0x40a93fa77036720eac1ba73cc9a1b67924d1c801",
  "0xc818e430f54a564960f8bdc8755add473742c802",
  "0x89ca8677306bcdfb6424f31be655e80b01edc803",
  "0x0115c67c8736c12e31d466747dc7966a0245c804",
  "0x660be470416d327c3924abf26bb120368f3dc805",
  "0x4e579082d03f6ee7fce916762f935d28af44c806"
];

export const buildDemoTrades = (launch: Launch): Trade[] =>
  Array.from({ length: launch.firstTrades ?? 0 }, (_, index) => {
    const isBuy = index % 3 !== 1;
    const amountUsd = 142 + ((index * 731) % 4900);
    return {
      id: `${launch.poolAddress}-${index}`,
      rank: index + 1,
      side: isBuy ? "buy" : "sell",
      trader: wallets[index % wallets.length],
      amountUsd,
      tokenAmount: Math.round(amountUsd * (18.4 + (index % 7))),
      timestamp: new Date(new Date(launch.createdAt).getTime() + index * 47000).toISOString(),
      txHash: `0x${(index + 101).toString(16).padStart(64, "0")}`
    };
  });

// A synthetic attendee report derived from the demo trades, flagging a deterministic
// subset as the creator's insider cluster (same private funder).
export const buildDemoAttendeeReport = (launch: Launch): AttendeeReport => {
  const trades = buildDemoTrades(launch);
  const creatorFundingSource = "0x983ac2683af532eeed4f31ed18de96f4f16a30a1";
  const launchMs = new Date(launch.createdAt).getTime();

  const byTrader = new Map<string, { volumeUsd: number; tradeCount: number; firstTradeAt: string }>();
  for (const trade of trades) {
    const entry = byTrader.get(trade.trader) ?? { volumeUsd: 0, tradeCount: 0, firstTradeAt: trade.timestamp };
    entry.volumeUsd += trade.amountUsd ?? 0;
    entry.tradeCount += 1;
    if (trade.timestamp < entry.firstTradeAt) entry.firstTradeAt = trade.timestamp;
    byTrader.set(trade.trader, entry);
  }

  const buyers: AttendeeBuyer[] = [...byTrader.entries()].map(([address, entry], index) => {
    const insider = index % 3 === 0;
    const classification: AttendeeClass = !insider ? "external" : index === 0 ? "creator-funded" : "same-funder";
    return {
      address,
      classification,
      fundingSource: insider ? creatorFundingSource : `0x${(index + 0x5100).toString(16).padStart(40, "0")}`,
      fundingTxHash: `0x${(index + 0xf100).toString(16).padStart(64, "0")}`,
      fundingVia: (index % 4 === 0 ? "internal" : "external") as "external" | "internal",
      funderCount: insider ? 2 + (index % 3) : 1,
      clusterId: insider ? 0 : null,
      tradeCount: entry.tradeCount,
      volumeUsd: Math.round(entry.volumeUsd),
      firstTradeAt: entry.firstTradeAt,
      secondsAfterLaunch: Math.max(0, Math.round((new Date(entry.firstTradeAt).getTime() - launchMs) / 1000))
    };
  }).sort((left, right) => (right.volumeUsd ?? 0) - (left.volumeUsd ?? 0));

  const insiderBuyers = buyers.filter((buyer) => buyer.classification !== "external");
  const insiderVolumeUsd = insiderBuyers.reduce((sum, buyer) => sum + (buyer.volumeUsd ?? 0), 0);
  const totalVolumeUsd = buyers.reduce((sum, buyer) => sum + (buyer.volumeUsd ?? 0), 0);
  const clusters: AttendeeCluster[] = insiderBuyers.length
    ? [{ id: 0, kind: "creator-insider", fundingSource: creatorFundingSource, memberCount: insiderBuyers.length, volumeUsd: insiderVolumeUsd }]
    : [];

  const nodes: AttendeeGraphNode[] = [
    { address: launch.creator, role: "creator", clusterId: 0, volumeUsd: null },
    { address: creatorFundingSource, role: "insider", clusterId: 0, volumeUsd: null }
  ];
  const edges: AttendeeGraphEdge[] = [{ from: launch.creator, to: creatorFundingSource }];
  for (const buyer of buyers) {
    const role: AttendeeNodeRole = buyer.classification === "external" ? "external" : "insider";
    nodes.push({ address: buyer.address, role, clusterId: buyer.clusterId, volumeUsd: buyer.volumeUsd });
    const funder = buyer.classification === "creator-funded"
      ? launch.creator
      : buyer.classification === "external"
        ? buyer.fundingSource
        : creatorFundingSource;
    if (funder) {
      if (buyer.classification === "external" && !nodes.some((node) => node.address === funder)) {
        nodes.push({ address: funder, role: "funder", clusterId: null, volumeUsd: null });
      }
      edges.push({ from: buyer.address, to: funder });
    }
  }

  return {
    poolAddress: launch.poolAddress,
    dex: launch.dex,
    creator: launch.creator,
    creatorFundingSource,
    analyzed: true,
    complete: true,
    analyzedTrades: trades.length,
    buyerCount: buyers.length,
    insiderBuyerCount: insiderBuyers.length,
    externalBuyerCount: buyers.length - insiderBuyers.length,
    totalVolumeUsd,
    externalVolumeUsd: totalVolumeUsd - insiderVolumeUsd,
    insiderVolumeUsd,
    insiderRatio: totalVolumeUsd > 0 ? insiderVolumeUsd / totalVolumeUsd : 0,
    buyers,
    clusters,
    graph: { nodes, edges },
    updatedAt: launch.createdAt
  };
};

export const buildDemoCreator = (creator: string, launches: Launch[] = demoLaunches): CreatorProfile => {
  const previousLaunches = launches.filter((launch) => launch.creator === creator);
  return {
    address: creator,
    firstFundedAt: "2026-04-16T08:22:14.000Z",
    fundingSource: "0x983ac2683af532eeed4f31ed18de96f4f16a30a1",
    fundingAmount: "1.28 ETH",
    launchCount: previousLaunches.length,
    previousLaunches,
    labels: previousLaunches.length > 1 ? ["repeat creator", "fresh funding"] : ["first observed launch"]
  };
};

function fillDailyPoints(days: number, aggregated: DailyAnalyticsPoint[]): DailyAnalyticsPoint[] {
  const byDate = new Map(aggregated.map((point) => [point.date, point]));
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const points: DailyAnalyticsPoint[] = [];

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(end);
    date.setUTCDate(date.getUTCDate() - offset);
    const key = date.toISOString().slice(0, 10);
    points.push(byDate.get(key) ?? { date: key, launchCount: 0, volumeUsd: 0 });
  }

  return points;
}

export const buildDemoDailyAnalytics = (days: number, launches: Launch[] = demoLaunches): LaunchDailyAnalytics => {
  const grouped = new Map<string, DailyAnalyticsPoint>();
  for (const launch of launches) {
    const date = launch.createdAt.slice(0, 10);
    const existing = grouped.get(date);
    if (existing) {
      existing.launchCount += 1;
      existing.volumeUsd += launch.volumeUsd ?? 0;
    } else {
      grouped.set(date, { date, launchCount: 1, volumeUsd: launch.volumeUsd ?? 0 });
    }
  }
  return { days, points: fillDailyPoints(days, [...grouped.values()]) };
};

export const buildDemoCreators = (launches: Launch[] = demoLaunches): CreatorSummary[] => {
  const grouped = new Map<string, CreatorSummary>();
  for (const launch of launches) {
    const existing = grouped.get(launch.creator);
    if (existing) {
      existing.launchCount += 1;
      if (launch.createdAt < existing.firstLaunchAt) existing.firstLaunchAt = launch.createdAt;
      if (launch.createdAt > existing.lastLaunchAt) existing.lastLaunchAt = launch.createdAt;
    } else {
      grouped.set(launch.creator, {
        address: launch.creator,
        launchCount: 1,
        firstLaunchAt: launch.createdAt,
        lastLaunchAt: launch.createdAt
      });
    }
  }
  return [...grouped.values()].sort((left, right) => right.launchCount - left.launchCount);
};
