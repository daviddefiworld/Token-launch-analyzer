import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren, type ReactNode } from "react";
import type { ApiStatus, AttendeeBuyer, AttendeeGraph, AttendeeReport, CreatorPage, CreatorProfile, CreatorSort, CreatorSummary, DailyAnalyticsPoint, DexInfo, IndexerState, Launch, LaunchDailyAnalytics, LaunchPage, LaunchSort, LaunchStats, PoolType, RpcUsage, Trade, TradeSide } from "../../types.js";

const API_URL = (import.meta.env.VITE_API_URL || "http://localhost:4000").replace(/\/$/, "");

const formatUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(value);

// Compact USD (e.g. "$12.5K", "$1.2M") so a "real / total" pair fits on one line.
const formatUsdCompact = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value);

// "real / total" volume, both amounts visible at a glance. With collapseEqual, a single
// value is shown when real and total match (nothing was filtered out as insider volume).
const formatRealTotal = (real: number | null | undefined, total: number | null | undefined, collapseEqual = false) => {
  if (real == null) return total != null ? formatUsdCompact(total) : "—";
  const realText = formatUsdCompact(real);
  const totalText = formatUsdCompact(total ?? real);
  if (collapseEqual && realText === totalText) return totalText;
  return `${realText} / ${totalText}`;
};

const formatLaunchUsd = (value: number | null, marketDataUpdatedAt?: string | null) => {
  if (value == null) return marketDataUpdatedAt ? "No data" : "Pending";
  return formatUsd(value);
};

// Per-transaction values can be small, so keep cents for sub-$1k amounts.
const formatTradeUsd = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value < 1000 ? 2 : 0
  }).format(value);

const formatDate = (value: string | null | undefined) =>
  value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit"
      }).format(new Date(value))
    : "Not available";

const short = (address: string | null | undefined, size = 5) =>
  !address || address === "unknown"
    ? "Unknown"
    : `${address.slice(0, size + 2)}...${address.slice(-4)}`;

const baseScanAddress = (address: string) => `https://basescan.org/address/${address}`;

// A wallet address rendered as a BaseScan link (or plain text when unknown).
const WalletLink = ({ address, size = 5 }: { address: string | null | undefined; size?: number }) =>
  !address || address === "unknown"
    ? <span className="mono">Unknown</span>
    : <a className="address-link mono" href={baseScanAddress(address)} target="_blank" rel="noreferrer">{short(address, size)}</a>;

const formatDuration = (seconds: number) => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
};

const ATTENDEE_LABELS: Record<AttendeeBuyer["classification"], string> = {
  creator: "creator",
  "creator-funded": "creator-funded",
  "same-funder": "same funder",
  linked: "linked",
  external: "external"
};

const fetchJson = async <T,>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_URL}${path}`, init);
  if (!response.ok) throw new Error((await response.json()).error || "Request failed");
  return response.json();
};

// Every API request targets a single DEX via ?dex=. This appends it, picking the right
// separator for paths that already carry a query string.
const withDex = (path: string, dex: string) =>
  `${path}${path.includes("?") ? "&" : "?"}dex=${encodeURIComponent(dex)}`;

const DEFAULT_DEX = "aerodrome";

function App() {
  const [dex, setDex] = useState<string>(DEFAULT_DEX);
  const [availableDexes, setAvailableDexes] = useState<DexInfo[]>([]);
  const [indexerStates, setIndexerStates] = useState<IndexerState[]>([]);
  const [status, setStatus] = useState<ApiStatus | null>(null);
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [selected, setSelected] = useState<Launch | null>(null);
  const [creator, setCreator] = useState<CreatorProfile | null>(null);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [attendees, setAttendees] = useState<AttendeeReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [search, setSearch] = useState("");
  const [poolType, setPoolType] = useState<PoolType>("all");
  const [sort, setSort] = useState<LaunchSort>("newest");
  const [minLiquidityUsd, setMinLiquidityUsd] = useState("");
  const [minVolumeUsd, setMinVolumeUsd] = useState("");
  const [createdWithinDays, setCreatedWithinDays] = useState("");
  const [tradeFilter, setTradeFilter] = useState<TradeSide | "all">("all");
  const [page, setPage] = useState<"overview" | "creators" | "analytics" | "rpc">("overview");
  const [rpcUsage, setRpcUsage] = useState<RpcUsage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalLaunches, setTotalLaunches] = useState(0);
  const [launchStats, setLaunchStats] = useState<LaunchStats | null>(null);
  const [error, setError] = useState("");
  const [refreshingMarket, setRefreshingMarket] = useState(false);
  const scrollSentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchJson<DexInfo[]>("/api/dexes")
      .then((dexes) => { if (dexes.length) setAvailableDexes(dexes); })
      .catch((requestError: Error) => setError(requestError.message));
  }, []);

  const loadIndexers = useCallback(() => fetchJson<IndexerState[]>("/api/indexers")
    .then(setIndexerStates)
    .catch(() => undefined), []);

  useEffect(() => {
    void loadIndexers();
    const timer = setInterval(() => void loadIndexers(), 5_000);
    return () => clearInterval(timer);
  }, [loadIndexers]);

  const toggleIndexer = useCallback(async (targetDex: string, enable: boolean) => {
    try {
      await fetchJson<{ enabled: boolean }>(`/api/dex/${targetDex}/${enable ? "start" : "stop"}`, { method: "POST" });
      await loadIndexers();
    } catch (requestError) {
      setError((requestError as Error).message);
    }
  }, [loadIndexers]);

  useEffect(() => {
    const loadStatus = () => fetchJson<ApiStatus>(withDex("/api/status", dex))
      .then(setStatus)
      .catch((requestError: Error) => setError(requestError.message));
    void loadStatus();
    const statusTimer = setInterval(() => void loadStatus(), 5_000);
    const loadStats = () => fetchJson<LaunchStats>(withDex("/api/launches/stats", dex))
      .then(setLaunchStats)
      .catch((requestError: Error) => setError(requestError.message));
    void loadStats();
    const statsTimer = setInterval(() => void loadStats(), 15_000);

    return () => {
      clearInterval(statusTimer);
      clearInterval(statsTimer);
    };
  }, [dex]);

  const loadLaunches = useCallback(async (cursor?: string) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    const params = new URLSearchParams({ limit: "30", dex });
    if (cursor) params.set("cursor", cursor);
    if (search.trim()) params.set("search", search.trim());
    if (poolType !== "all") params.set("poolType", poolType);
    if (minLiquidityUsd) params.set("minLiquidityUsd", minLiquidityUsd);
    if (minVolumeUsd) params.set("minVolumeUsd", minVolumeUsd);
    if (createdWithinDays) params.set("createdWithinDays", createdWithinDays);
    params.set("sort", sort);

    try {
      const page = await fetchJson<LaunchPage>(`/api/launches?${params}`);
      setLaunches((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      setTotalLaunches(page.total);
      setSelected((currentLaunch) => {
        if (!currentLaunch) return page.items[0] ?? null;
        if (cursor) return currentLaunch;
        return page.items.find((launch) => launch.id === currentLaunch.id) ?? page.items[0] ?? null;
      });
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [createdWithinDays, dex, minLiquidityUsd, minVolumeUsd, poolType, search, sort]);

  const refreshMarketData = useCallback(async () => {
    if (refreshingMarket || status?.mode !== "live") return;
    setRefreshingMarket(true);
    setError("");
    try {
      await fetchJson<{ started: boolean }>(withDex("/api/market-data/refresh?limit=50", dex), { method: "POST" });
      // The server refreshes in the background; poll stats for progressive updates.
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        setLaunchStats(await fetchJson<LaunchStats>(withDex("/api/launches/stats", dex)));
      }
      setLaunches([]);
      setNextCursor(null);
      await loadLaunches();
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setRefreshingMarket(false);
    }
  }, [dex, loadLaunches, refreshingMarket, status?.mode]);

  useEffect(() => {
    if (page !== "rpc") return;
    const loadUsage = () => fetchJson<RpcUsage>(withDex("/api/rpc-usage", dex))
      .then(setRpcUsage)
      .catch((requestError: Error) => setError(requestError.message));
    void loadUsage();
    const timer = setInterval(() => void loadUsage(), 3_000);
    return () => clearInterval(timer);
  }, [dex, page]);

  // The pool-type taxonomy differs per DEX, so reset the filter when switching DEX, and
  // clear any stale error so a previous DEX's failure doesn't leak into the new context.
  useEffect(() => {
    setPoolType("all");
    setSelected(null);
    setError("");
  }, [dex]);

  useEffect(() => {
    setLaunches([]);
    setNextCursor(null);
    const timer = setTimeout(() => void loadLaunches(), 250);
    return () => clearTimeout(timer);
  }, [loadLaunches]);

  useEffect(() => {
    const sentinel = scrollSentinel.current;
    if (!sentinel || !nextCursor) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadingMore) void loadLaunches(nextCursor);
    }, { rootMargin: "160px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadLaunches, loadingMore, nextCursor]);

  useEffect(() => {
    // On a DEX switch, `dex` updates before `selected` is reset, leaving a launch from the
    // old DEX paired with the new dex. Skip the fetch in that mismatched render — the
    // pool wouldn't exist under the new (dex-scoped) DEX and would 404 spuriously.
    if (!selected || selected.dex !== dex) return;
    setCreator(null);
    setTrades([]);
    setAttendees(null);
    Promise.all([
      fetchJson<CreatorProfile>(withDex(`/api/creators/${selected.creator}`, dex)),
      fetchJson<Trade[]>(withDex(`/api/launches/${selected.poolAddress}/trades`, dex)),
      fetchJson<AttendeeReport>(withDex(`/api/launches/${selected.poolAddress}/attendees`, dex))
    ])
      .then(([nextCreator, nextTrades, nextAttendees]) => {
        setCreator(nextCreator);
        setTrades(nextTrades);
        setAttendees(nextAttendees);
      })
      .catch((requestError: Error) => setError(requestError.message));
  }, [dex, selected]);

  const analyzeAttendees = useCallback(async () => {
    if (!selected || analyzing || status?.mode !== "live") return;
    setAnalyzing(true);
    setError("");
    const pool = selected.poolAddress;
    try {
      await fetchJson<{ started: boolean }>(withDex(`/api/launches/${pool}/attendees/analyze`, dex), { method: "POST" });
      // Classification runs in the background; poll until the report is marked analyzed.
      // A cold first analysis can take ~30s (many uncached funding lookups), so poll a while.
      for (let attempt = 0; attempt < 16; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const report = await fetchJson<AttendeeReport>(withDex(`/api/launches/${pool}/attendees`, dex));
        setAttendees(report);
        if (report.analyzed) break;
      }
    } catch (requestError) {
      setError((requestError as Error).message);
    } finally {
      setAnalyzing(false);
    }
  }, [analyzing, dex, selected, status?.mode]);

  const filteredTrades = trades.filter((trade) => tradeFilter === "all" || trade.side === tradeFilter);
  const buyCount = trades.filter((trade) => trade.side === "buy").length;
  const sellCount = trades.length - buyCount;
  const currentDex = availableDexes.find((item) => item.id === dex);
  const dexLabel = currentDex?.label ?? "DEX";
  const poolTypeOptions = currentDex?.poolTypeOptions ?? [];
  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">{dexLabel.slice(0, 1)}</div>
          <div>
            <strong>Launch Intel</strong>
            <span>Multi-DEX analyzer</span>
          </div>
        </div>
        <label className="dex-switcher">
          <span className="eyebrow">DEX</span>
          <select className="select-control" value={dex} onChange={(event) => setDex(event.target.value)}>
            {(availableDexes.length ? availableDexes : [{ id: dex, label: dexLabel, network: "Base", factory: "", poolTypeOptions: [] }]).map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </label>
        {indexerStates.some((state) => state.available) && (
          <div className="indexer-controls">
            <span className="eyebrow">Indexers</span>
            {availableDexes.map((item) => {
              const state = indexerStates.find((entry) => entry.dex === item.id);
              const enabled = state?.enabled ?? false;
              return (
                <div className="indexer-row" key={item.id}>
                  <i className={`status-dot ${enabled ? "on" : "off"}`} />
                  <span className="indexer-name">{item.label}</span>
                  <button
                    type="button"
                    className={`indexer-toggle ${enabled ? "on" : "off"}`}
                    disabled={!state?.available}
                    onClick={() => void toggleIndexer(item.id, !enabled)}
                    title={enabled ? "Stop indexing this DEX" : "Start indexing this DEX"}
                  >
                    {enabled ? "Stop" : "Start"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <nav>
          <button onClick={() => setPage("overview")} className={`nav-item ${page === "overview" ? "active" : ""}`}><GridIcon /> Overview</button>
          <button onClick={() => setPage("creators")} className={`nav-item ${page === "creators" ? "active" : ""}`}><UsersIcon /> Creators</button>
          <button onClick={() => setPage("analytics")} className={`nav-item ${page === "analytics" ? "active" : ""}`}><BarChartIcon /> Analytics</button>
          <button onClick={() => setPage("rpc")} className={`nav-item ${page === "rpc" ? "active" : ""}`}><PulseIcon /> RPC usage</button>
        </nav>
        <div className="sidebar-bottom">
          <div className="network-card">
            <span className="eyebrow">Network</span>
            <strong><i className="status-dot" /> Base mainnet</strong>
            <small>{status ? (status.mode === "live" ? "RPC connected" : "Demo dataset") : "Connecting..."}</small>
            {status?.mode === "live" && (
              <small>
                {status.indexer?.indexedBlock == null
                  ? "Preparing index..."
                  : `Indexed block ${status.indexer.indexedBlock.toLocaleString()}`}
              </small>
            )}
          </div>
          <span className="version">{dexLabel} · {currentDex?.network ?? "Base"}</span>
        </div>
      </aside>

      <section className="workspace">
        {page === "rpc" ? <RpcUsagePage usage={rpcUsage} /> : page === "creators" ? <CreatorsPage dex={dex} onError={setError} /> : page === "analytics" ? <AnalyticsPage dex={dex} onError={setError} /> : <>
        <header className="topbar">
          <div>
            <span className="eyebrow">{dexLabel} · {currentDex?.network ?? "Base"}</span>
            <h1>Launch intelligence</h1>
          </div>
          <div className="topbar-actions">
            {status?.mode === "demo" && <span className="demo-pill">Demo mode</span>}
            <div className="avatar">PX</div>
          </div>
        </header>

        {error && <div className="error-banner">{error}</div>}

        <section className="metrics">
          <Metric label="24h volume (real / total)" value={launchStats ? formatRealTotal(launchStats.dayRealVolumeUsd, launchStats.dayVolumeUsd) : "—"} hint="External / all · launched ≤ 24h" icon={<ChartIcon />} />
          <Metric label="Launches (24h)" value={launchStats?.dayLaunchCount ?? 0} hint="Pools launched today" icon={<RocketIcon />} />
          <Metric label={`Launches ≥ $${launchStats?.minVolumeUsd ?? 100}`} value={launchStats?.dayLaunchCountMinVolume ?? 0} hint="With real traction" icon={<PulseIcon />} />
          <Metric label="Active creators" value={launchStats?.dayActiveCreators ?? 0} hint="Unique · last 24h" icon={<UsersIcon />} />
        </section>

        <section className="analyst-grid">
          <div className="launch-panel panel">
            <div className="panel-heading">
              <div>
                <span className="eyebrow">Factory index</span>
                <h2>Recent launches</h2>
              </div>
              {status?.mode === "live" && (
                <button
                  type="button"
                  className="refresh-button"
                  onClick={() => void refreshMarketData()}
                  disabled={refreshingMarket || loading}
                  title="Refresh liquidity and volume from DexScreener"
                >
                  <RefreshIcon />
                  {refreshingMarket ? "Refreshing..." : "Refresh market data"}
                </button>
              )}
            </div>
            <div className="toolbar">
              <label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search token, wallet, pool" /></label>
              {poolTypeOptions.length > 0 && (
                <select className="select-control" value={poolType} onChange={(event) => setPoolType(event.target.value as PoolType)}>
                  <option value="all">All pools</option>
                  {poolTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              )}
              <select className="select-control" value={sort} onChange={(event) => setSort(event.target.value as LaunchSort)}>
                <option value="newest">Newest</option><option value="oldest">Oldest</option><option value="liquidity">Liquidity</option><option value="volume">24h volume</option><option value="realVolume">Real volume</option>
              </select>
              <select className="select-control" value={createdWithinDays} onChange={(event) => setCreatedWithinDays(event.target.value)}>
                <option value="">Any token age at LP</option><option value="1">Created &lt; 1d before LP</option><option value="3">Created &lt; 3d before LP</option><option value="7">Created &lt; 1w before LP</option><option value="30">Created &lt; 1mo before LP</option>
              </select>
              <input className="number-control" type="number" min="0" value={minLiquidityUsd} onChange={(event) => setMinLiquidityUsd(event.target.value)} placeholder="Min liq $" />
              <input className="number-control" type="number" min="0" value={minVolumeUsd} onChange={(event) => setMinVolumeUsd(event.target.value)} placeholder="Min vol $" />
            </div>
            <div className="launch-table table-shell">
              <div className="table-row table-head">
                <span>Pair</span><span>Creator</span><span>Liquidity</span><span>Real / total vol</span>
              </div>
              {loading && <div className="empty-state">Indexing launches...</div>}
              {!loading && launches.map((launch) => (
                <button
                  className={`table-row launch-row ${selected?.id === launch.id ? "selected" : ""}`}
                  key={launch.id}
                  onClick={() => setSelected(launch)}
                >
                  <span className="pair-cell"><b className={`token-logo token-${launch.tokenSymbol.toLowerCase()}`}>{launch.tokenSymbol.slice(0, 1)}</b><span><strong>{launch.tokenSymbol}</strong><small>{launch.quoteSymbol} · {formatDate(launch.createdAt)}</small></span></span>
                  <span className="mono">{short(launch.creator)}</span>
                  <span>{formatLaunchUsd(launch.liquidityUsd, launch.marketDataUpdatedAt)}</span>
                  <span className="vol-cell">
                    <strong>{launch.externalVolumeUsd != null ? formatRealTotal(launch.externalVolumeUsd, launch.volumeUsd, true) : formatLaunchUsd(launch.volumeUsd, launch.marketDataUpdatedAt)}</strong>
                    {launch.insiderRatio != null && launch.insiderRatio >= 0.05 && (
                      <small className={`insider-tag ${launch.insiderRatio >= 0.4 ? "high" : ""}`}>{Math.round(launch.insiderRatio * 100)}% insider</small>
                    )}
                  </span>
                </button>
              ))}
              <div className="scroll-sentinel" ref={scrollSentinel}>{loadingMore ? "Loading more launches..." : nextCursor ? "Scroll for more" : "All launches loaded"}</div>
            </div>
          </div>

          <aside className="detail-column">
            <section className="selected-card panel">
              {selected ? (
                <>
                  <div className="selected-title">
                    <b className={`token-logo large token-${selected.tokenSymbol.toLowerCase()}`}>{selected.tokenSymbol.slice(0, 1)}</b>
                    <div><span className="eyebrow">Selected pool</span><h2>{selected.pair}</h2><small className="mono">{short(selected.poolAddress, 7)}</small></div>
                  </div>
                  <div className="pool-stats">
                    <div><span>Pool type</span><strong>{selected.poolTypeLabel}</strong></div>
                    <div><span>Created</span><strong>{formatDate(selected.createdAt)}</strong></div>
                    <div><span>Block</span><strong>{selected.blockNumber.toLocaleString()}</strong></div>
                    <div><span>Token created</span><strong>{formatDate(selected.tokenCreatedAt)}</strong></div>
                    <div><span>Token age at LP</span><strong>{selected.tokenAgeAtLaunchHours != null ? `${selected.tokenAgeAtLaunchHours.toFixed(1)} hours` : "Unknown"}</strong></div>
                    <div>
                      <span>Token contract</span>
                      <strong>
                        <a className="address-link mono" href={`https://basescan.org/address/${selected.tokenAddress}`} target="_blank" rel="noreferrer">
                          {short(selected.tokenAddress, 7)} <ArrowIcon />
                        </a>
                      </strong>
                    </div>
                  </div>
                  <div className="pool-links">
                    <a className="primary-button" href={`https://basescan.org/address/${selected.poolAddress}`} target="_blank" rel="noreferrer">Pool on BaseScan <ArrowIcon /></a>
                    <a className="secondary-button" href={`https://basescan.org/address/${selected.tokenAddress}`} target="_blank" rel="noreferrer">Token on BaseScan <ArrowIcon /></a>
                  </div>
                </>
              ) : <div className="empty-state">Select a launch</div>}
            </section>

            <CreatorProfilePanel profile={creator} loading={Boolean(selected && !creator)} historyLimit={3} />
          </aside>
        </section>

        <section className="flow-panel panel">
          <div className="panel-heading">
            <div><span className="eyebrow">Early order flow</span><h2>First 100 buyers & sellers</h2></div>
            <div className="flow-summary"><span><i className="buy-dot" /> {buyCount} buys</span><span><i className="sell-dot" /> {sellCount} sells</span></div>
          </div>
          <div className="toolbar flow-toolbar">
            <div className="filter-row">
              {(["all", "buy", "sell"] as const).map((item) => <button key={item} onClick={() => setTradeFilter(item)} className={tradeFilter === item ? "filter active" : "filter"}>{item}</button>)}
            </div>
            <span className="muted">{trades.length} indexed trades</span>
          </div>
          <div className="trade-table table-shell">
            <div className="table-row table-head">
              <span>#</span><span>Side</span><span>Wallet</span><span>Value</span><span>Token amount</span><span>Time</span><span>Tx</span>
            </div>
            {filteredTrades.slice(0, 12).map((trade) => (
              <div className="table-row trade-row" key={trade.id}>
                <span className="muted">{String(trade.rank).padStart(2, "0")}</span>
                <span><b className={`side ${trade.side}`}>{trade.side}</b></span>
                <span className="mono">{short(trade.trader, 7)}</span>
                <span>{trade.amountUsd != null ? formatTradeUsd(trade.amountUsd) : "—"}</span>
                <span>{trade.tokenAmount?.toLocaleString() || "On-chain"}</span>
                <span>{formatDate(trade.timestamp)}</span>
                <a className="tx-link" href={`https://basescan.org/tx/${trade.txHash}`} target="_blank" rel="noreferrer"><ArrowIcon /></a>
              </div>
            ))}
          </div>
        </section>

        <AttendeeIntelPanel
          report={attendees}
          loading={Boolean(selected && !attendees)}
          analyzing={analyzing}
          mode={status?.mode}
          onAnalyze={() => void analyzeAttendees()}
        />
        </>}
      </section>
    </main>
  );
}

function CreatorsPage({ dex, onError }: { dex: string; onError: (message: string) => void }) {
  const [creators, setCreators] = useState<CreatorSummary[]>([]);
  const [selected, setSelected] = useState<CreatorSummary | null>(null);
  const [profile, setProfile] = useState<CreatorProfile | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<CreatorSort>("launchCount");
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalCreators, setTotalCreators] = useState(0);
  const scrollSentinel = useRef<HTMLDivElement>(null);

  const loadCreators = useCallback(async (cursor?: string) => {
    cursor ? setLoadingMore(true) : setLoading(true);
    const params = new URLSearchParams({ limit: "30", sort, dex });
    if (cursor) params.set("cursor", cursor);
    if (search.trim()) params.set("search", search.trim());

    try {
      const page = await fetchJson<CreatorPage>(`/api/creators?${params}`);
      setCreators((current) => cursor ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
      setTotalCreators(page.total);
      setSelected((currentCreator) => currentCreator ?? page.items[0] ?? null);
    } catch (requestError) {
      onError((requestError as Error).message);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [dex, onError, search, sort]);

  useEffect(() => {
    setCreators([]);
    setNextCursor(null);
    const timer = setTimeout(() => void loadCreators(), 250);
    return () => clearTimeout(timer);
  }, [loadCreators]);

  useEffect(() => {
    const sentinel = scrollSentinel.current;
    if (!sentinel || !nextCursor) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting && !loadingMore) void loadCreators(nextCursor);
    }, { rootMargin: "160px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadCreators, loadingMore, nextCursor]);

  useEffect(() => {
    if (!selected) {
      setProfile(null);
      return;
    }
    setProfile(null);
    fetchJson<CreatorProfile>(withDex(`/api/creators/${selected.address}`, dex))
      .then(setProfile)
      .catch((requestError: Error) => onError(requestError.message));
  }, [dex, onError, selected]);

  const totalLaunches = creators.reduce((sum, creator) => sum + creator.launchCount, 0);
  const repeatCreators = creators.filter((creator) => creator.launchCount > 1).length;

  return <>
    <header className="topbar">
      <div>
        <span className="eyebrow">Wallet index</span>
        <h1>Creators</h1>
      </div>
    </header>

    <section className="metrics">
      <Metric label="Unique creators" value={totalCreators} delta={`${creators.length} loaded`} icon={<UsersIcon />} />
      <Metric label="Loaded launches" value={totalLaunches} hint="From visible creators" icon={<RocketIcon />} />
      <Metric label="Repeat creators" value={repeatCreators} hint="More than one launch" icon={<WalletIcon />} />
      <Metric label="Top creator" value={creators[0]?.launchCount ?? 0} hint={creators[0] ? short(creators[0].address, 6) : "Loading"} icon={<ChartIcon />} />
    </section>

    <section className="analyst-grid creators-grid">
      <div className="launch-panel panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">Launch wallets</span>
            <h2>All creators</h2>
          </div>
        </div>
        <div className="toolbar">
          <label className="search-box"><SearchIcon /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search wallet address" /></label>
          <select className="select-control" value={sort} onChange={(event) => setSort(event.target.value as CreatorSort)}>
            <option value="launchCount">Most launches</option>
            <option value="newest">Latest launch</option>
            <option value="oldest">First launch</option>
          </select>
        </div>
        <div className="creator-table table-shell">
          <div className="table-row table-head">
            <span>#</span><span>Creator</span><span>Token launches</span><span>First launch</span><span>Latest launch</span>
          </div>
          {loading && <div className="empty-state">Loading creators...</div>}
          {!loading && creators.map((creator, index) => (
            <button
              className={`table-row creator-row ${selected?.address === creator.address ? "selected" : ""}`}
              key={creator.address}
              onClick={() => setSelected(creator)}
            >
              <span className="muted">{String(index + 1).padStart(2, "0")}</span>
              <span className="mono">{short(creator.address, 8)}</span>
              <span><strong>{creator.launchCount}</strong></span>
              <span>{formatDate(creator.firstLaunchAt)}</span>
              <span>{formatDate(creator.lastLaunchAt)}</span>
            </button>
          ))}
          <div className="scroll-sentinel" ref={scrollSentinel}>{loadingMore ? "Loading more creators..." : nextCursor ? "Scroll for more" : "All creators loaded"}</div>
        </div>
      </div>

      <aside className="detail-column creators-detail">
        <CreatorProfilePanel profile={profile} loading={Boolean(selected && !profile)} emptyMessage="Select a creator" />
      </aside>
    </section>
  </>;
}

function CreatorProfilePanel({
  profile,
  loading,
  emptyMessage = "Select a launch",
  historyLimit
}: {
  profile: CreatorProfile | null;
  loading: boolean;
  emptyMessage?: string;
  historyLimit?: number;
}) {
  const launches = historyLimit != null
    ? (profile?.previousLaunches.slice(0, historyLimit) ?? [])
    : (profile?.previousLaunches ?? []);

  return (
    <section className="creator-card panel">
      <div className="panel-heading compact">
        <div>
          <span className="eyebrow">Wallet intelligence</span>
          <h2>Creator profile</h2>
        </div>
        <WalletIcon />
      </div>
      {profile ? (
        <div className="creator-profile-body">
          <div className="wallet-address">
            <strong className="mono">{short(profile.address, 8)}</strong>
            <a href={`https://basescan.org/address/${profile.address}`} target="_blank" rel="noreferrer"><ArrowIcon /></a>
          </div>
          <div className="creator-grid">
            <div><span>Token launches</span><strong>{profile.launchCount}</strong></div>
            <div><span>First funding</span><strong>{formatDate(profile.firstFundedAt)}</strong></div>
            <div><span>Funding amount</span><strong>{profile.fundingAmount || "Add API key"}</strong></div>
            <div><span>Funding source</span><strong className="mono">{short(profile.fundingSource, 6)}</strong></div>
          </div>
          {profile.labels.length > 0 && (
            <div className="tag-row">{profile.labels.map((label) => <span className="tag" key={label}>{label}</span>)}</div>
          )}
          <div className="history-heading">
            <strong>Launch history</strong>
            <span>{profile.launchCount} observed</span>
          </div>
          <div className="mini-history">
            {launches.length > 0 ? launches.map((launch) => (
              <div className="mini-history-item" key={launch.id}>
                <b className="mini-dot" />
                <div className="mini-history-main">
                  <strong>{launch.pair}</strong>
                  <span className="history-meta">{formatDate(launch.createdAt)}</span>
                </div>
                <div className="mini-history-stats">
                  <span>{formatLaunchUsd(launch.liquidityUsd, launch.marketDataUpdatedAt)} liq</span>
                  <span>{formatLaunchUsd(launch.volumeUsd, launch.marketDataUpdatedAt)} vol</span>
                </div>
              </div>
            )) : <div className="empty-state compact">No launches indexed yet</div>}
          </div>
        </div>
      ) : loading ? (
        <div className="empty-state compact">Loading wallet history...</div>
      ) : (
        <div className="empty-state compact">{emptyMessage}</div>
      )}
    </section>
  );
}

const ROLE_COLORS: Record<string, string> = {
  creator: "#ff5f6d",
  insider: "#ff9b9b",
  coordinated: "#f4c07a",
  external: "#7ff0aa",
  funder: "#8aa0bd"
};

// A small deterministic force-directed layout (circle init, no randomness) for the wallet
// funding graph: repulsion between all nodes, spring attraction along funding edges, light
// gravity to center; then normalize into the viewBox.
function computeGraphLayout(graph: AttendeeGraph, width: number, height: number) {
  const count = graph.nodes.length;
  const nodes = graph.nodes.map((node, index) => {
    const angle = (2 * Math.PI * index) / Math.max(1, count);
    return { ...node, x: Math.cos(angle) * 140, y: Math.sin(angle) * 140, vx: 0, vy: 0 };
  });
  const indexByAddress = new Map(nodes.map((node, index) => [node.address, index]));
  const edges = graph.edges
    .map((edge) => [indexByAddress.get(edge.from), indexByAddress.get(edge.to)] as [number | undefined, number | undefined])
    .filter((pair): pair is [number, number] => pair[0] != null && pair[1] != null);

  for (let iteration = 0; iteration < 220; iteration++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist2 = dx * dx + dy * dy + 0.01;
        const dist = Math.sqrt(dist2);
        const force = 1400 / dist2;
        const fx = (force * dx) / dist;
        const fy = (force * dy) / dist;
        nodes[i].vx += fx; nodes[i].vy += fy;
        nodes[j].vx -= fx; nodes[j].vy -= fy;
      }
    }
    for (const [a, b] of edges) {
      const dx = nodes[b].x - nodes[a].x;
      const dy = nodes[b].y - nodes[a].y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const force = (dist - 50) * 0.06;
      const fx = (force * dx) / dist;
      const fy = (force * dy) / dist;
      nodes[a].vx += fx; nodes[a].vy += fy;
      nodes[b].vx -= fx; nodes[b].vy -= fy;
    }
    for (const node of nodes) {
      node.vx -= node.x * 0.003;
      node.vy -= node.y * 0.003;
      node.x += Math.max(-10, Math.min(10, node.vx));
      node.y += Math.max(-10, Math.min(10, node.vy));
      node.vx *= 0.82; node.vy *= 0.82;
    }
  }

  const xs = nodes.map((node) => node.x);
  const ys = nodes.map((node) => node.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pad = 30;
  const scale = Math.min((width - pad * 2) / Math.max(1, maxX - minX), (height - pad * 2) / Math.max(1, maxY - minY));
  const maxVol = Math.max(1, ...nodes.map((node) => node.volumeUsd ?? 0));

  const laidOut = nodes.map((node) => ({
    address: node.address,
    role: node.role,
    volumeUsd: node.volumeUsd,
    x: pad + (node.x - minX) * scale,
    y: pad + (node.y - minY) * scale,
    r: node.role === "funder" ? 5 : 5 + Math.sqrt((node.volumeUsd ?? 0) / maxVol) * 10
  }));
  const layoutEdges = edges.map(([a, b]) => ({ x1: laidOut[a].x, y1: laidOut[a].y, x2: laidOut[b].x, y2: laidOut[b].y }));
  return { nodes: laidOut, edges: layoutEdges };
}

function WalletGraph({ graph }: { graph: AttendeeGraph }) {
  const width = 660;
  const height = 380;
  const layout = useMemo(() => computeGraphLayout(graph, width, height), [graph]);

  return (
    <div className="wallet-graph">
      <svg viewBox={`0 0 ${width} ${height}`} className="wallet-graph-svg" role="img" aria-label="Wallet funding relationships">
        {layout.edges.map((edge, index) => (
          <line key={index} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} className="graph-edge" />
        ))}
        {layout.nodes.map((node) => (
          <a key={node.address} href={baseScanAddress(node.address)} target="_blank" rel="noreferrer">
            <title>{`${node.address}\n${node.role}${node.volumeUsd != null ? ` · ${formatUsd(node.volumeUsd)}` : ""}\nClick to open on BaseScan`}</title>
            <circle
              cx={node.x}
              cy={node.y}
              r={node.r}
              fill={ROLE_COLORS[node.role] ?? "#8aa0bd"}
              stroke={node.role === "creator" ? "#fff" : "rgba(0,0,0,.35)"}
              strokeWidth={node.role === "creator" ? 2.5 : 1}
            />
          </a>
        ))}
      </svg>
      <div className="graph-legend">
        <span><i style={{ background: ROLE_COLORS.creator }} /> Creator</span>
        <span><i style={{ background: ROLE_COLORS.insider }} /> Insider</span>
        <span><i style={{ background: ROLE_COLORS.coordinated }} /> Sniper ring</span>
        <span><i style={{ background: ROLE_COLORS.external }} /> External</span>
        <span><i style={{ background: ROLE_COLORS.funder }} /> Funder</span>
      </div>
    </div>
  );
}

function AttendeeIntelPanel({
  report,
  loading,
  analyzing,
  mode,
  onAnalyze
}: {
  report: AttendeeReport | null;
  loading: boolean;
  analyzing: boolean;
  mode?: "demo" | "live";
  onAnalyze: () => void;
}) {
  const insiderPct = report?.insiderRatio != null ? Math.round(report.insiderRatio * 100) : null;

  return (
    <section className="attendee-panel panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">Funding-graph analysis</span>
          <h2>Attendee intelligence</h2>
        </div>
        {mode === "live" && (
          <button type="button" className="refresh-button" onClick={onAnalyze} disabled={analyzing || loading} title="Classify buyers by funding source and compute real volume">
            <RefreshIcon />
            {analyzing ? "Analyzing..." : report?.analyzed ? "Re-analyze" : "Run analysis"}
          </button>
        )}
      </div>

      {loading ? (
        <div className="empty-state">Loading attendee intel...</div>
      ) : !report || !report.analyzed ? (
        <div className="empty-state">
          {analyzing
            ? "Classifying buyers by funding source..."
            : mode === "live"
              ? "Not analyzed yet. Run analysis to classify buyers and compute real (external) volume."
              : "Attendee analysis runs in live mode (needs BASESCAN_API_KEY)."}
        </div>
      ) : (
        <>
          <section className="metrics attendee-metrics">
            <Metric label="Volume (real / total)" value={formatRealTotal(report.externalVolumeUsd, report.totalVolumeUsd)} hint="Real excludes insider cluster" icon={<ChartIcon />} />
            <Metric label="Insider volume" value={report.insiderVolumeUsd != null ? formatUsd(report.insiderVolumeUsd) : "—"} hint={insiderPct != null ? `${insiderPct}% of total` : "Self-buys / sybils"} icon={<ShieldIcon />} danger={insiderPct != null && insiderPct >= 30} />
            <Metric label="External buyers" value={report.externalBuyerCount} hint="Independent funding" icon={<UsersIcon />} />
            <Metric label="Insider buyers" value={report.insiderBuyerCount} hint="Creator's cluster" icon={<WalletIcon />} />
          </section>

          {insiderPct != null && (
            <div className="insider-bar" title={`${insiderPct}% of volume is from the creator's funding cluster`}>
              <div className={`insider-bar-fill ${insiderPct >= 40 ? "high" : ""}`} style={{ width: `${Math.min(100, insiderPct)}%` }} />
              <span>{insiderPct}% insider / sybil volume · {report.buyerCount} buyers analyzed</span>
            </div>
          )}

          {report.clusters.length > 0 && (
            <div className="cluster-row">
              {report.clusters.map((cluster) => (
                <div className={`cluster-chip ${cluster.kind}`} key={cluster.id}>
                  <strong>{cluster.kind === "creator-insider" ? "Creator cluster" : `Sniper ring #${cluster.id}`}</strong>
                  <span>{cluster.memberCount} wallets · {cluster.volumeUsd != null ? formatUsd(cluster.volumeUsd) : "—"}</span>
                  {cluster.fundingSource && (
                    <small className="cluster-funder">funder <WalletLink address={cluster.fundingSource} size={5} /></small>
                  )}
                </div>
              ))}
            </div>
          )}

          {report.graph && report.graph.nodes.length > 1 && (
            <div className="graph-section">
              <div className="graph-heading">
                <span className="eyebrow">Wallet relationships</span>
                <span className="muted">{report.graph.nodes.length} wallets · {report.graph.edges.length} funding links</span>
              </div>
              <WalletGraph graph={report.graph} />
            </div>
          )}

          <div className="attendee-table table-shell">
            <div className="table-row table-head">
              <span>Buyer</span><span>Class</span><span>Funder</span><span>Volume</span><span>After LP</span>
            </div>
            {report.buyers.slice(0, 20).map((buyer) => (
              <div className="table-row attendee-row" key={buyer.address}>
                <span><WalletLink address={buyer.address} size={7} /></span>
                <span><b className={`attendee-badge ${buyer.classification}`}>{ATTENDEE_LABELS[buyer.classification]}</b></span>
                <span><WalletLink address={buyer.fundingSource} size={5} /></span>
                <span>{buyer.volumeUsd != null ? formatTradeUsd(buyer.volumeUsd) : "—"}</span>
                <span>{buyer.secondsAfterLaunch != null ? formatDuration(buyer.secondsAfterLaunch) : "—"}</span>
              </div>
            ))}
          </div>

          {!report.complete && <div className="muted attendee-note">Partial result — some buyers are still pending a funding lookup. Re-analyze to refine.</div>}
        </>
      )}
    </section>
  );
}

function AnalyticsPage({ dex, onError }: { dex: string; onError: (message: string) => void }) {
  const [analytics, setAnalytics] = useState<LaunchDailyAnalytics | null>(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchJson<LaunchDailyAnalytics>(withDex(`/api/launches/analytics/daily?days=${days}`, dex))
      .then(setAnalytics)
      .catch((requestError: Error) => onError(requestError.message))
      .finally(() => setLoading(false));
  }, [days, dex, onError]);

  const points = analytics?.points ?? [];
  const totalLaunches = points.reduce((sum, point) => sum + point.launchCount, 0);
  const totalVolume = points.reduce((sum, point) => sum + point.volumeUsd, 0);
  const peakLaunches = Math.max(...points.map((point) => point.launchCount), 0);
  const peakVolume = Math.max(...points.map((point) => point.volumeUsd), 0);
  const avgLaunches = points.length ? (totalLaunches / points.length).toFixed(1) : "0";
  const busiestDay = points.reduce<DailyAnalyticsPoint | null>(
    (best, point) => (!best || point.launchCount > best.launchCount ? point : best),
    null
  );

  return <>
    <header className="topbar">
      <div>
        <span className="eyebrow">Trend index</span>
        <h1>Analytics</h1>
      </div>
      <div className="topbar-actions">
        <select className="select-control analytics-range" value={days} onChange={(event) => setDays(Number(event.target.value))}>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
          <option value={60}>Last 60 days</option>
          <option value={90}>Last 90 days</option>
        </select>
      </div>
    </header>

    <section className="metrics">
      <Metric label="Launches in range" value={totalLaunches} delta={`${days} day window`} icon={<RocketIcon />} />
      <Metric label="Volume in range" value={formatUsd(totalVolume)} hint="24h volume at index time" icon={<ChartIcon />} />
      <Metric label="Daily average" value={avgLaunches} hint="Launches per day" icon={<BarChartIcon />} />
      <Metric label="Busiest day" value={busiestDay?.launchCount ?? 0} hint={busiestDay ? formatChartDate(busiestDay.date) : "Loading"} icon={<PulseIcon />} />
    </section>

    <section className="analytics-grid">
      <article className="panel chart-panel">
        <div className="panel-heading compact">
          <div>
            <span className="eyebrow">Launch activity</span>
            <h2>Daily launch count</h2>
          </div>
          <span className="chart-peak">Peak {peakLaunches}</span>
        </div>
        {loading ? <div className="empty-state">Loading analytics...</div> : (
          <DailyBarChart
            points={points}
            valueKey="launchCount"
            formatValue={(value) => String(value)}
            color="#8effbd"
          />
        )}
      </article>

      <article className="panel chart-panel">
        <div className="panel-heading compact">
          <div>
            <span className="eyebrow">Market activity</span>
            <h2>Daily volume</h2>
          </div>
          <span className="chart-peak">Peak {formatUsd(peakVolume)}</span>
        </div>
        {loading ? <div className="empty-state">Loading analytics...</div> : (
          <DailyBarChart
            points={points}
            valueKey="volumeUsd"
            formatValue={(value) => formatUsd(value)}
            color="#7ab8ff"
          />
        )}
      </article>
    </section>
  </>;
}

function DailyBarChart({
  points,
  valueKey,
  formatValue,
  color
}: {
  points: DailyAnalyticsPoint[];
  valueKey: "launchCount" | "volumeUsd";
  formatValue: (value: number) => string;
  color: string;
}) {
  const width = 640;
  const height = 240;
  const padding = { top: 18, right: 12, bottom: 34, left: 12 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxValue = Math.max(...points.map((point) => point[valueKey]), 1);
  const barGap = 4;
  const barWidth = Math.max((chartWidth - barGap * (points.length - 1)) / points.length, 2);
  const labelEvery = points.length > 20 ? Math.ceil(points.length / 8) : points.length > 12 ? 2 : 1;

  return (
    <div className="chart-wrap">
      <svg className="chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Daily ${valueKey} chart`}>
        {[0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + chartHeight * (1 - ratio);
          return <line key={ratio} x1={padding.left} x2={width - padding.right} y1={y} y2={y} className="chart-grid-line" />;
        })}
        {points.map((point, index) => {
          const value = point[valueKey];
          const barHeight = (value / maxValue) * chartHeight;
          const x = padding.left + index * (barWidth + barGap);
          const y = padding.top + chartHeight - barHeight;
          return (
            <g key={point.date}>
              <title>{`${formatChartDate(point.date)}: ${formatValue(value)}`}</title>
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, value > 0 ? 2 : 0)}
                rx={2}
                fill={color}
                opacity={value > 0 ? 0.92 : 0.18}
              />
              {index % labelEvery === 0 && (
                <text x={x + barWidth / 2} y={height - 10} className="chart-label" textAnchor="middle">
                  {formatChartDate(point.date, true)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const formatChartDate = (value: string, shortLabel = false) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return shortLabel
    ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(date)
    : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(date);
};

function RpcUsagePage({ usage }: { usage: RpcUsage | null }) {
  return <><header className="topbar"><div><span className="eyebrow">Base provider</span><h1>RPC usage</h1></div></header>
    <section className="metrics">
      <Metric label="Total RPC calls" value={usage?.totalCalls ?? 0} hint="Since API startup" icon={<PulseIcon />} />
      <Metric label="RPC errors" value={usage?.totalErrors ?? 0} hint="Provider failures" icon={<ShieldIcon />} danger />
      <Metric label="Tracked methods" value={usage?.methods.length ?? 0} hint="JSON-RPC methods" icon={<ChartIcon />} />
      <Metric label="Tracking since" value={usage ? formatDate(usage.startedAt) : "Loading"} hint="Current API process" icon={<RocketIcon />} />
    </section>
    <section className="panel rpc-panel"><div className="panel-heading"><div><span className="eyebrow">Method breakdown</span><h2>Base JSON-RPC calls</h2></div></div>
      <div className="rpc-table"><div className="table-row table-head"><span>Method</span><span>Calls</span><span>Errors</span><span>Last called</span></div>
        {usage?.methods.map((method) => <div className="table-row rpc-row" key={method.method}><strong className="mono">{method.method}</strong><span>{method.count.toLocaleString()}</span><span>{method.errors}</span><span>{formatDate(method.lastCalledAt)}</span></div>)}
      </div>
    </section></>;
}

function Metric({ label, value, delta, hint, icon, danger }: { label: string; value: string | number; delta?: string; hint?: string; icon: ReactNode; danger?: boolean }) {
  return <article className="metric-card panel"><div className={`metric-icon ${danger ? "danger" : ""}`}>{icon}</div><div><span>{label}</span><strong>{value}</strong><small className={danger ? "danger-text" : ""}>{delta || hint}</small></div></article>;
}

const Icon = ({ children }: PropsWithChildren) => <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>;
const UsersIcon = () => <Icon><path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1" /><circle cx="9" cy="7" r="3" /><path d="M22 19v-1a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></Icon>;
const GridIcon = () => <Icon><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></Icon>;
const PulseIcon = () => <Icon><path d="M3 12h4l3-7 4 14 3-7h4" /></Icon>;
const WalletIcon = () => <Icon><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H20v16H6.5A2.5 2.5 0 0 1 4 17.5z" /><path d="M4 7h16" /><path d="M15 13h2" /></Icon>;
const RocketIcon = () => <Icon><path d="M14 6c3-3 6-3 7-3 0 1 0 4-3 7l-4 4-4-4z" /><path d="m10 10-4 1-3 3 7 1 1 6 3-3 1-4" /><path d="M5 19c1-2 2-3 4-4" /></Icon>;
const ChartIcon = () => <Icon><path d="M4 19V5" /><path d="M4 19h16" /><path d="m7 14 4-4 3 3 5-6" /></Icon>;
const BarChartIcon = () => <Icon><path d="M5 19V9" /><path d="M10 19V5" /><path d="M15 19v-6" /><path d="M20 19V3" /><path d="M4 19h16" /></Icon>;
const ShieldIcon = () => <Icon><path d="M12 3 20 6v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M12 8v4" /><path d="M12 16h.01" /></Icon>;
const SearchIcon = () => <Icon><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></Icon>;
const ArrowIcon = () => <Icon><path d="M7 17 17 7" /><path d="M8 7h9v9" /></Icon>;
const RefreshIcon = () => <Icon><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></Icon>;

export default App;
