import type { CreatorProfile, CreatorSummary, DailyAnalyticsPoint, Launch, LaunchDailyAnalytics, Trade } from "../types.js";

export const demoLaunches: Launch[] = [
  {
    id: "0x08d7a39c3f546a781ff991cc28a31f9aa9c42401",
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
    stable: false,
    liquidityUsd: 84210,
    volumeUsd: 391420,
    firstTrades: 100,
    risk: "medium"
  },
  {
    id: "0xa92e6fb936ed12b26f5962ec2559df73f3eeb502",
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
    stable: false,
    liquidityUsd: 127900,
    volumeUsd: 218340,
    firstTrades: 100,
    risk: "low"
  },
  {
    id: "0xc5d74f1339cbba61e3d2272e0ca47e84d3c5b203",
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
    stable: false,
    liquidityUsd: 42680,
    volumeUsd: 88630,
    firstTrades: 94,
    risk: "high"
  },
  {
    id: "0x7ab29b5090abe11c2409f6984b33f99778bf6404",
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
    stable: true,
    liquidityUsd: 310500,
    volumeUsd: 190240,
    firstTrades: 100,
    risk: "low"
  },
  {
    id: "0xf8072fe0179d639c27422112a2b99bb21ced2505",
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
    stable: false,
    liquidityUsd: 19120,
    volumeUsd: 72210,
    firstTrades: 67,
    risk: "high"
  },
  {
    id: "0x496ad4c89b7414433b4a59dbbe49cad4a34a4606",
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
    stable: false,
    liquidityUsd: 63940,
    volumeUsd: 41290,
    firstTrades: 42,
    risk: "medium"
  }
];

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

export const buildDemoCreator = (creator: string): CreatorProfile => {
  const previousLaunches = demoLaunches.filter((launch) => launch.creator === creator);
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

export const buildDemoDailyAnalytics = (days: number): LaunchDailyAnalytics => {
  const grouped = new Map<string, DailyAnalyticsPoint>();
  for (const launch of demoLaunches) {
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

export const buildDemoCreators = (): CreatorSummary[] => {
  const grouped = new Map<string, CreatorSummary>();
  for (const launch of demoLaunches) {
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
