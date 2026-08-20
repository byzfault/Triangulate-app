import { api, ApiError, BudgetExceededError, RequestBudget } from './client.js';
import { cache } from './cache.js';
import { config, type Filters } from './config.js';
import {
  deriveLaunch,
  INDEX_FLOOR,
  extractBatchPositions,
  extractPagination,
  extractTraders,
  normalisePosition,
  normaliseTokenMeta,
} from './normalise.js';
import type { Position, ProgressEvent, ResultRow, SearchResult, SearchWarning, TokenMeta, TrackRecord } from './types.js';
import { fetchPriceSeries } from './prices.js';
import { scoreWallet } from './scoring/index.js';
import type { PriceSeries, ScoringContext } from './scoring/types.js';

const PAGE_SIZE = 200;
const BATCH_PAIRS = 200;

/**
 * The docs disagree with the endpoint index on this path, so we try both once and remember
 * which one answered for the rest of the process.
 */
const BATCH_PATHS = ['/v2/pnl/positions/batch', '/v2/pnl/batch/positions'];
let knownBatchPath: string | null = null;

type Emit = (e: ProgressEvent) => void;

export async function runSearch(
  mints: string[],
  filters: Filters,
  emit: Emit,
  budget: RequestBudget,
): Promise<SearchResult> {
  const startedAt = Date.now();
  const warnings: SearchWarning[] = [];
  // Declared up front because finish() reads them on the early-return path too.
  const rows: ResultRow[] = [];
  let anchorPositions: Position[] = [];
  let intersectionSize = 0;
  let walletsChecked = 0;
  const warn = (kind: SearchWarning['kind'], message: string) => {
    const warning = { kind, message };
    warnings.push(warning);
    emit({ type: 'warning', warning });
  };

  // ---- Phase 1: token metadata -------------------------------------------------------
  const tokens: TokenMeta[] = [];
  for (const mint of mints) {
    emit({ type: 'phase', mint, phase: 'metadata', detail: 'Fetching token info' });
    tokens.push(await fetchTokenMeta(mint, budget));
  }

  for (const t of tokens) {
    if (t.firstPoolAt === null) {
      warn(
        'partial',
        `${t.symbol}: no pool creation time available, so the sniper filter and first-buy timing can't be applied to it.`,
      );
    }
  }

  // ---- Phase 2: pick the anchor ------------------------------------------------------
  // The smallest token anchors the search: we enumerate it in full and probe the rest
  // against it, so cost tracks the smallest token rather than the largest.
  //
  // Size comes from the metadata already fetched above. The traders endpoint's
  // `pagination.total` looks like a global count but actually reports the size of the page
  // just returned, so probing it would rank every token identically.
  const anchor = [...tokens].sort((a, b) => sizeOf(a) - sizeOf(b))[0]!;
  const others = tokens.filter((t) => t.mint !== anchor.mint);

  // ---- Phase 3: enumerate the anchor -------------------------------------------------
  emit({ type: 'phase', mint: anchor.mint, phase: 'anchor', detail: 'Listing traders' });

  anchorPositions = await enumerateTraders(anchor, filters, budget, emit, warn);

  if (anchorPositions.length === 0) {
    warn('notice', `No qualifying buyers found for ${anchor.symbol}, so the intersection is empty.`);
    return finish();
  }

  // ---- Phase 4: batch-probe the other tokens -----------------------------------------
  // Wallets are narrowed token by token: only survivors of token B get probed against C.
  let candidates = anchorPositions.map((p) => p.wallet);
  const byMint = new Map<string, Map<string, Position>>();
  byMint.set(anchor.mint, new Map(anchorPositions.map((p) => [p.wallet, p])));

  for (const token of others) {
    emit({
      type: 'phase',
      mint: token.mint,
      phase: 'intersect',
      detail: `Checking ${candidates.length.toLocaleString()} wallets`,
    });

    const found = await batchPositions(token.mint, candidates, filters, budget, emit);
    byMint.set(token.mint, found);

    // A wallet with no position, or with no actual buys, is out — transfers don't count.
    candidates = candidates.filter((w) => {
      const pos = found.get(w);
      return pos !== undefined && pos.buys > 0;
    });

    if (candidates.length === 0) break;
  }

  intersectionSize = candidates.length;

  // ---- Phase 5: derive each token's launch time --------------------------------------
  // Pool `createdAt` is often missing or belongs to a later migration, so it can't anchor
  // the "early" window on its own. One page of first-buyers per token, sorted locally,
  // gives a far better reference. Their own chronological ordering is unreliable — roughly
  // a third of consecutive pairs come back out of order — so we only use it as a sample.
  emit({ type: 'phase', mint: null, phase: 'launch', detail: 'Establishing launch times' });

  for (const token of tokens) {
    const sample = await sampleFirstBuys(token.mint, filters, budget);
    const observed = [
      ...sample,
      ...[...(byMint.get(token.mint)?.values() ?? [])].map((p) => p.firstBuy),
    ];
    const { launchAt, source, truncated } = deriveLaunch(observed, token.firstPoolAt);
    token.launchAt = launchAt;
    token.launchSource = source;
    token.historyTruncated = truncated;

    if (truncated) {
      warn(
        'capped',
        `${token.symbol} launched before ${new Date(INDEX_FLOOR)
          .toISOString()
          .slice(0, 10)}, which is where Solana Tracker's PnL history begins. Its early buyers aren't in the data and its realized PnL is missing everything before that date, so the early-buyer and sniper filters are skipped for this token. Treat its numbers as a floor, not a total.`,
      );
    } else if (launchAt === null) {
      warn('partial', `${token.symbol}: couldn't establish a launch time, so timing filters are skipped for it.`);
    }
  }

  // ---- Phase 6: free filters ---------------------------------------------------------
  emit({ type: 'phase', mint: null, phase: 'ranking', detail: 'Applying filters' });

  const deployerSet = new Set(tokens.flatMap((t) => t.deployers));

  for (const wallet of candidates) {
    const perToken: ResultRow['perToken'] = {};
    let combinedRealized = 0;
    let combinedUnrealized = 0;
    let totalBuys = 0;
    let totalSells = 0;
    let profitableTokens = 0;
    let sniper = false;
    let maxHoldSecs: number | null = null;
    let walletLifetimeTrades: number | null = null;
    let identityType: string | null = null;
    let isArbitrage = false;

    for (const token of tokens) {
      const pos = byMint.get(token.mint)?.get(wallet);
      if (!pos) continue;

      // Only the anchor's /traders records carry wallet-wide fields; batch lookups don't.
      if (pos.walletLifetimeTrades !== null) walletLifetimeTrades = pos.walletLifetimeTrades;
      if (pos.identityType !== null) identityType = pos.identityType;
      if (pos.isArbitrage) isArbitrage = true;
      if (pos.holdTimeSecs !== null) maxHoldSecs = Math.max(maxHoldSecs ?? 0, pos.holdTimeSecs);

      const hoursAfterLaunch =
        token.launchAt !== null && pos.firstBuy !== null ? (pos.firstBuy - token.launchAt) / 3600_000 : null;

      if (token.historyTruncated) {
        // The launch predates the index, so every wallet looks "late" against it. Judging
        // timing here would reject everyone; abstain for this token instead.
      } else if (hoursAfterLaunch !== null) {
        const secsAfter = hoursAfterLaunch * 3600;
        if (secsAfter >= 0 && secsAfter < filters.sniperWindowSecs) sniper = true;
      }

      combinedRealized += pos.realized;
      combinedUnrealized += pos.unrealized;
      totalBuys += pos.buys;
      totalSells += pos.sells;
      if (pos.realized > 0) profitableTokens += 1;

      perToken[token.mint] = {
        realized: pos.realized,
        unrealized: pos.unrealized,
        buys: pos.buys,
        sells: pos.sells,
        balance: pos.balance,
        roi: pos.roi,
        invested: pos.invested,
        proceeds: pos.proceeds,
        hoursAfterLaunch,
        holdTimeSecs: pos.holdTimeSecs,
        lastTradeAt: pos.lastTrade,
        tokensBought: pos.tokensBought,
        tokensSold: pos.tokensSold,
      };
    }

    const deployer = deployerSet.has(wallet);
    const bot = totalBuys + totalSells > filters.maxTotalSwaps;

    // Unconditional exclusions. These aren't preferences — a sniper, a bot, a deployer or
    // an arbitrage account is never the wallet being looked for, so there's no setting.
    if (sniper) continue;
    if (bot) continue;
    if (deployer) continue;
    if (isArbitrage || identityType === 'bot' || identityType === 'pool') continue;

    const positions = Object.values(perToken);
    const rois = positions.map((p) => p.roi).filter((r): r is number => typeof r === 'number');
    const bestRoi = rois.length > 0 ? Math.max(...rois) : null;
    const sortedRois = [...rois].sort((a, b) => a - b);
    const medianRoi = sortedRois.length > 0 ? sortedRois[Math.floor(sortedRois.length / 2)]! : null;
    const totalInvested = positions.reduce((a, p) => a + (p.invested || 0), 0);

    // Stake floor first: a $3 position showing 4,000% ROI is noise, not skill.
    if (totalInvested < filters.minInvestedUsd) continue;

    // The multiple. Best-of rather than median, because one enormous winner is exactly the
    // pattern being hunted — the wallet that turned a small stake into a life-changing one.
    if (bestRoi === null || bestRoi < filters.minRoiPercent) continue;

    // Conviction, not accumulation: a position taken in a few buys, not averaged into
    // dozens of times by a script.
    if (positions.some((p) => p.buys > filters.maxBuysPerToken)) continue;

    // Realised, not paper. Gains that were never sold aren't gains.
    if (filters.requireRealisedProfit && !positions.some((p) => p.sells > 0 && p.realized > 0)) continue;

    const needed = filters.requireProfitOnAll ? tokens.length : filters.minProfitableTokens;
    if (profitableTokens < needed) continue;

    rows.push({
      wallet,
      combinedRealized,
      combinedUnrealized,
      totalBuys,
      totalSells,
      profitableTokens,
      tradesInWindow: null,
      walletLifetimeTrades,
      winRate: null,
      closedPositions: null,
      avgHoldSecs: null,
      walletRoi: null,
      avgPnlPerAsset: null,
      bigWinRate: null,
      maxHoldSecs,
      bestRoi,
      medianRoi,
      totalInvested,
      perToken,
      flags: { sniper, deployer, bot },
      score: null,
    });
  }

  // ---- Phase 7: scoring --------------------------------------------------------------
  // Tier 1 makes no per-wallet calls. The only network cost here is the price series, which
  // is per *token* and cached, so it doesn't scale with the number of wallets.
  emit({ type: 'phase', mint: null, phase: 'scoring', detail: 'Scoring wallets' });

  const prices = new Map<string, PriceSeries>();
  for (const token of tokens) {
    const series = await fetchPriceSeries(token, budget);
    if (series) prices.set(token.mint, series);
  }

  const scoringCtx: ScoringContext = {
    tokens,
    prices,
    // No per-wallet calls are made any more, so scoring works purely from token-side data
    // and reports whichever components that leaves unmeasurable.
    hasWalletData: false,
    requireProfitOnAll: filters.requireProfitOnAll,
    now: Date.now(),
  };

  for (const row of rows) row.score = scoreWallet(row, scoringCtx);

  // Excluded wallets are dropped rather than shown with a null score: the hard gates are
  // disqualifying, not merely unflattering.
  const scored = rows.filter((r) => r.score?.excluded == null);
  const excludedCount = rows.length - scored.length;
  if (excludedCount > 0) {
    warn('notice', `${excludedCount} wallet${excludedCount === 1 ? '' : 's'} removed by the scoring exclusions (sniper, transfer-inflated PnL, or deployer).`);
  }
  rows.length = 0;
  rows.push(...scored);

  rows.sort((a, b) => (b.bestRoi ?? 0) - (a.bestRoi ?? 0));

  // ---- Phase 8: recent activity ------------------------------------------------------
  // The one filter that costs a request per wallet. Three things keep that affordable: a
  // free lifetime-trades pre-filter, running only after scoring, and checking just the
  // top-scoring wallets rather than everything that survived.
  if (!filters.checkRecentActivity && !filters.checkWalletProfitability) return finish();

  const toCheck = rows.slice(0, filters.maxWalletChecks);
  if (rows.length > toCheck.length) {
    warn(
      'capped',
      `The per-wallet checks ran on the top ${toCheck.length} by ROI; ${
        rows.length - toCheck.length
      } more passed the free filters but weren't checked.`,
    );
  }

  const kept: ResultRow[] = [];
  for (const [i, row] of toCheck.entries()) {
    emit({
      type: 'phase',
      mint: null,
      phase: 'activity',
      detail: `Verifying wallet ${i + 1}/${toCheck.length}`,
    });

    // Is it profitable across everything it trades, or did it just catch these tokens?
    if (filters.checkWalletProfitability) {
      const record = await walletTrackRecord(row.wallet, budget);
      walletsChecked += 1;
      if (!record) continue;

      row.walletRoi = record.roi;
      row.winRate = record.winRate;
      row.closedPositions = record.closedPositions;
      row.avgHoldSecs = record.avgHoldSecs;
      row.bigWinRate = record.bigWinRate;

      const roi = record.roi;
      if (typeof roi !== 'number' || !Number.isFinite(roi) || roi < filters.minWalletRoi) continue;

      if (filters.minWinRate > 0) {
        const win = record.winRate;
        if (typeof win !== 'number' || !Number.isFinite(win) || win < filters.minWinRate) continue;
      }
    }

    if (filters.checkRecentActivity) {
      row.tradesInWindow = await walletTradesInWindow(row.wallet, filters, budget);
      if (row.tradesInWindow === null) continue;
      if (row.tradesInWindow < filters.minTradesInWindow) continue;
      if (row.tradesInWindow > filters.maxTradesInWindow) continue;
    }

    kept.push(row);
  }

  rows.length = 0;
  rows.push(...kept);
  rows.sort((a, b) => (b.bestRoi ?? 0) - (a.bestRoi ?? 0));

  return finish();

  function finish(): SearchResult {
    return {
      mints,
      tokens,
      rows,
      warnings,
      stats: {
        requests: budget.requests,
        cacheHits: budget.cacheHits,
        anchorMint: anchor.mint,
        anchorWallets: anchorPositions.length,
        intersectionSize,
        activityChecked: walletsChecked,
        afterFilters: rows.length,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}

// ---------------------------------------------------------------------------------------

async function fetchTokenMeta(mint: string, budget: RequestBudget): Promise<TokenMeta> {
  const cached = cache.getTokenMeta(mint);
  if (cached) {
    budget.hit();
    return cached;
  }

  const raw = await api.get<unknown>(`/tokens/${mint}`, {}, budget);
  const meta = normaliseTokenMeta(raw, mint);
  cache.putTokenMeta(meta);
  // Supply lives on the pools, and entry market cap needs it later.
  cache.putSupply(mint, extractSupply(raw));
  return meta;
}

/**
 * Wallet-wide trade count over the recent window, across every token — not just the queried
 * ones, so a wallet that trades constantly elsewhere is caught even if it held these
 * patiently. One request per wallet, cached, which is why the caller checks so few.
 */
async function walletTradesInWindow(
  wallet: string,
  filters: Filters,
  budget: RequestBudget,
): Promise<number | null> {
  const cached = cache.getActivity(wallet, filters.activityWindowDays);
  if (cached !== undefined) {
    budget.hit();
    return cached;
  }

  try {
    const raw = await api.get<{ totals?: { trades?: number } }>(
      `/v2/pnl/wallets/${wallet}/performance`,
      { days: filters.activityWindowDays },
      budget,
    );
    const trades = typeof raw?.totals?.trades === 'number' ? raw.totals.trades : null;
    cache.putActivity(wallet, filters.activityWindowDays, trades);
    return trades;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return null;
  }
}

/**
 * The wallet's record across every token it has traded. `roi` here answers the question the
 * queried tokens can't: is this wallet profitable in general, or did it simply catch these?
 */
async function walletTrackRecord(wallet: string, budget: RequestBudget): Promise<TrackRecord | null> {
  const cached = cache.getWalletStats(wallet);
  if (cached !== undefined) {
    budget.hit();
    return cached;
  }

  try {
    const raw = await api.get<{
      analysis?: {
        winRate?: number;
        avgPnlPerAsset?: number;
        tokens?: { closed?: number };
        distribution?: Array<{ range?: string; rate?: number }>;
      };
      summary?: { roi?: number; timing?: { avgHoldTimeSecs?: number } };
    }>(`/v2/pnl/wallets/${wallet}`, {}, budget);

    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const dist = raw?.analysis?.distribution ?? [];
    const rateFor = (range: string) => dist.find((d) => d.range === range)?.rate ?? 0;

    const record: TrackRecord = {
      winRate: n(raw?.analysis?.winRate),
      closedPositions: n(raw?.analysis?.tokens?.closed),
      avgHoldSecs: n(raw?.summary?.timing?.avgHoldTimeSecs),
      roi: n(raw?.summary?.roi),
      avgPnlPerAsset: n(raw?.analysis?.avgPnlPerAsset),
      bigWinRate: dist.length > 0 ? rateFor('>500%') + rateFor('200-500%') : null,
    };
    cache.putWalletStats(wallet, record);
    return record;
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return null;
  }
}

/** Circulating supply, needed to turn a price into a market cap. */
function extractSupply(raw: unknown): number | null {
  const pools = (raw as { pools?: Array<{ tokenSupply?: number }> })?.pools ?? [];
  for (const pool of pools) {
    if (typeof pool.tokenSupply === 'number' && Number.isFinite(pool.tokenSupply) && pool.tokenSupply > 0) {
      return pool.tokenSupply;
    }
  }
  return null;
}

/** Relative size of a token, for anchor selection only. Smaller wins. */
function sizeOf(t: TokenMeta): number {
  return t.holders ?? t.txnsTotal ?? Number.MAX_SAFE_INTEGER;
}

/**
 * One page of the earliest buyers, used only as a sample for estimating the launch time.
 * We never rely on the order the API returns — it's roughly chronological at best.
 */
async function sampleFirstBuys(mint: string, filters: Filters, budget: RequestBudget): Promise<Array<number | null>> {
  try {
    const raw = await api.get<unknown>(
      `/v2/pnl/tokens/${mint}/first-buyers`,
      { limit: PAGE_SIZE, ...traderFilterParams(filters) },
      budget,
    );
    return extractTraders(raw).map((t) => normalisePosition(t, mint)?.firstBuy ?? null);
  } catch (err) {
    if (err instanceof BudgetExceededError) throw err;
    return []; // a launch estimate is a nice-to-have, not worth failing the whole query
  }
}



function traderFilterParams(filters: Filters) {
  return {
    excludeArbitrage: 'true',
    excludeZeroBuys: 'true', // transfers and airdrops never count as buys
    pnlMode: filters.pnlMode,
  };
}

async function enumerateTraders(
  token: TokenMeta,
  filters: Filters,
  budget: RequestBudget,
  emit: Emit,
  warn: (kind: SearchWarning['kind'], message: string) => void,
): Promise<Position[]> {
  const enumeration = cache.getEnumeration(token.mint);
  if (enumeration) {
    const cached = cache.listPositions(token.mint);
    if (cached.length > 0) {
      budget.hit();
      if (enumeration.truncated) {
        warn('capped', `${token.symbol}: cached trader list was capped at ${config.anchorWalletCap.toLocaleString()} wallets.`);
      }
      return cached.filter((p) => p.buys > 0);
    }
  }

  const positions: Position[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let truncated = false;

  for (;;) {
    const raw: unknown = await api.get<unknown>(
      `/v2/pnl/tokens/${token.mint}/traders`,
      {
        limit: PAGE_SIZE,
        sort: 'realized',
        direction: 'desc',
        cursor: cursor ?? undefined,
        ...traderFilterParams(filters),
      },
      budget,
    );

    for (const entry of extractTraders(raw)) {
      const pos = normalisePosition(entry, token.mint);
      if (pos && !seen.has(pos.wallet)) {
        seen.add(pos.wallet);
        positions.push(pos);
      }
    }

    emit({
      type: 'phase',
      mint: token.mint,
      phase: 'anchor',
      detail: `Listed ${positions.length.toLocaleString()} traders`,
    });

    if (positions.length >= config.anchorWalletCap) {
      truncated = true;
      warn(
        'capped',
        `${token.symbol} has more traders than the ${config.anchorWalletCap.toLocaleString()}-wallet cap. Results cover the most profitable wallets only.`,
      );
      break;
    }

    const page = extractPagination(raw);
    if (!page.hasMore || !page.nextCursor || page.nextCursor === cursor) break;
    cursor = page.nextCursor;
  }

  cache.putPositions(
    token.mint,
    positions.map((p) => ({ wallet: p.wallet, position: p })),
  );
  cache.putEnumeration(token.mint, positions.length, truncated);

  return positions.filter((p) => p.buys > 0);
}

async function batchPositions(
  mint: string,
  wallets: string[],
  filters: Filters,
  budget: RequestBudget,
  emit: Emit,
): Promise<Map<string, Position>> {
  const found = new Map<string, Position>();
  const toFetch: string[] = [];

  for (const wallet of wallets) {
    const cached = cache.getPosition(mint, wallet);
    if (cached === undefined) {
      toFetch.push(wallet);
    } else {
      budget.hit();
      if (cached) found.set(wallet, cached);
    }
  }

  for (let i = 0; i < toFetch.length; i += BATCH_PAIRS) {
    const chunk = toFetch.slice(i, i + BATCH_PAIRS);
    const body = { pairs: chunk.map((wallet) => ({ wallet, token: mint })) };

    const raw = await postBatch(body, filters, budget);
    const entries: Array<{ wallet: string; position: Position | null }> = chunk.map((w) => ({
      wallet: w,
      position: null,
    }));
    const index = new Map(entries.map((e) => [e.wallet, e]));

    for (const item of extractBatchPositions(raw)) {
      const pos = normalisePosition(item, mint);
      if (!pos) continue;
      const entry = index.get(pos.wallet);
      if (entry) entry.position = pos;
      found.set(pos.wallet, pos);
    }

    // Wallets absent from the response are cached as a definite "no position", so a repeat
    // query doesn't pay to ask again.
    cache.putPositions(mint, entries);

    emit({
      type: 'phase',
      mint,
      phase: 'intersect',
      detail: `Checked ${Math.min(i + BATCH_PAIRS, toFetch.length).toLocaleString()}/${toFetch.length.toLocaleString()}`,
    });
  }

  return found;
}

async function postBatch(body: unknown, filters: Filters, budget: RequestBudget): Promise<unknown> {
  // Batch defaults to strict; the anchor list is fetched with the user's mode, so pass it
  // here too or the two halves of the intersection wouldn't be computed the same way.
  const query = { pnlMode: filters.pnlMode };

  if (knownBatchPath) return api.post<unknown>(knownBatchPath, body, budget, query);

  let lastError: unknown;
  for (const path of BATCH_PATHS) {
    try {
      const raw = await api.post<unknown>(path, body, budget, query);
      knownBatchPath = path;
      return raw;
    } catch (err) {
      // Only a 404 means "wrong path" — anything else is a real failure worth surfacing.
      if (err instanceof BudgetExceededError) throw err;
      if (err instanceof ApiError && err.status === 404) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError ?? new ApiError('Batch position lookup failed on every known path.');
}
