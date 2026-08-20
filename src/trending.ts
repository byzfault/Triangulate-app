import { cache } from './cache.js';
import type { TrendingToken } from './types.js';

/**
 * Trending comes from GeckoTerminal rather than Solana Tracker or DexScreener.
 *
 *  - GeckoTerminal is free and keyless, and bills against nobody's quota, so these panels
 *    can never eat into the search budget.
 *  - DexScreener's free "top" endpoint is `/token-boosts/top/v1`, which ranks by
 *    `totalAmount` — the sum a project *paid* to promote itself, i.e. marketing spend
 *    rather than trading activity.
 *  - Solana Tracker's trending endpoint draws on the same 10,000 requests/month searches need.
 */
const API = 'https://api.geckoterminal.com/api/v2/networks/solana';

const LIMIT = 15;

/** 24h list: cheap, so it refreshes often. */
const H24_TTL_MS = 5 * 60_000;
const H24_PAGES = 2;

/**
 * 7-day list: no endpoint reports a window longer than 24h, so the real 7-day total is
 * summed from each pool's daily OHLCV candles — one request per pool. That's ~100 requests,
 * free but slow against GeckoTerminal's rate limit, so it's computed in the background and
 * cached for an hour rather than blocking a page load.
 */
const D7_TTL_MS = 60 * 60_000;
const D7_TREND_PAGES = 2;
const D7_TOP_PAGES = 5;
const D7_MAX_POOLS = 30;

/**
 * Quality gate.
 *
 * Ranking Solana pools by raw volume surfaces tokenised equities and wash-traded pools, not
 * memecoins: NVDA/SOL showed $124M of 24h volume against roughly zero liquidity, and TSLA
 * moved $19,000 per unique buyer. Real memecoin flow looks completely different — CLUG did
 * $596 per buyer across 18,591 of them.
 *
 * These thresholds encode that difference. Measured against an 87-pool sample they removed
 * every equity and every zero-liquidity pool while keeping the genuine memecoins.
 */
export const quality = {
  /** Below this there isn't a real market, however much "volume" is reported. */
  minLiquidityUsd: 15_000,
  /** Real memecoins have broad participation; a handful of wallets churning does not count. */
  minBuyers24h: 500,
  /** Retail trades are hundreds of dollars. Equities and institutional flow are thousands. */
  maxVolumePerBuyer: 5_000,
  /** Volume far beyond the liquidity backing it means wash trading. */
  maxChurn: 300,
  /** Volume far *below* liquidity means a parked major, not something being traded. */
  minChurn: 0.5,
  /**
   * Symbols that are never the subject of this kind of research. Matched case-insensitively
   * on the pool's base symbol — a curation aid, not a security boundary.
   */
  denySymbols: new Set(
    [
      'SOL', 'WSOL', 'USDC', 'USDT', 'USDS', 'USDE', 'PYUSD', 'EURC', 'DAI',
      'JITOSOL', 'MSOL', 'BSOL', 'INF', 'JUPSOL', 'HSOL', 'JSOL', 'LST',
      'WBTC', 'WETH', 'CBBTC', 'ZBTC', 'JLP',
    ].map((x) => x.toUpperCase()),
  ),
};

/** True when a pool looks like a genuinely traded memecoin rather than an equity or a wash. */
function isQualityPool(p: PoolRow): boolean {
  if (quality.denySymbols.has(p.symbol.toUpperCase())) return false;

  const vol = p.volume24h ?? 0;
  const liq = p.liquidity ?? 0;
  const buyers = p.buyers24h ?? 0;

  if (liq < quality.minLiquidityUsd) return false;
  if (buyers < quality.minBuyers24h) return false;
  if (vol / Math.max(buyers, 1) > quality.maxVolumePerBuyer) return false;

  const churn = vol / Math.max(liq, 1);
  return churn >= quality.minChurn && churn <= quality.maxChurn;
}

/**
 * GeckoTerminal's free tier documents ~30 calls/minute, but in practice it starts returning
 * 429 after a handful of OHLCV requests even at 2.4s spacing, and the budget is shared
 * across endpoints. Pacing alone is therefore not enough — every call has to be prepared to
 * back off and retry, or a long run silently loses most of its results.
 */
const GECKO_MIN_INTERVAL_MS = 3000;
const GECKO_MAX_ATTEMPTS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let lastCall = 0;
/** Serialises callers so concurrent work can't defeat the spacing. */
let chain: Promise<unknown> = Promise.resolve();

async function geckoFetch(path: string): Promise<unknown> {
  const run = chain.then(() => geckoFetchInner(path));
  // Keep the chain alive regardless of this call's outcome.
  chain = run.catch(() => undefined);
  return run;
}

async function geckoFetchInner(path: string): Promise<unknown> {
  let backoff = 6000;

  for (let attempt = 1; attempt <= GECKO_MAX_ATTEMPTS; attempt++) {
    const wait = Math.max(0, lastCall + GECKO_MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();

    const res = await fetch(`${API}${path}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });

    if (res.ok) return res.json();

    if (res.status === 429 && attempt < GECKO_MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff);
      backoff = Math.min(backoff * 2, 60_000);
      continue;
    }

    throw new Error(`GeckoTerminal returned ${res.status} for ${path}`);
  }

  throw new Error(`GeckoTerminal kept rate limiting ${path}`);
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

interface GeckoPool {
  attributes?: {
    address?: string;
    name?: string;
    volume_usd?: { h24?: string | number };
    price_change_percentage?: { h24?: string | number };
    market_cap_usd?: string | number | null;
    fdv_usd?: string | number | null;
    reserve_in_usd?: string | number | null;
    transactions?: { h24?: { buyers?: number; sellers?: number } };
  };
  relationships?: { base_token?: { data?: { id?: string } } };
}

interface PoolRow extends TrendingToken {
  pool: string;
  liquidity: number | null;
  buyers24h: number | null;
}

function toPoolRow(pool: GeckoPool): PoolRow | null {
  // Base token ids look like "solana_<mint>".
  const id = pool.relationships?.base_token?.data?.id ?? '';
  const mint = id.startsWith('solana_') ? id.slice('solana_'.length) : '';
  const address = pool.attributes?.address ?? '';
  if (!mint || !address) return null;

  // Pool names are "SYMBOL / QUOTE"; the base symbol is the half we want.
  const name = pool.attributes?.name ?? mint.slice(0, 8);
  return {
    pool: address,
    mint,
    name,
    symbol: name.split('/')[0]?.trim() || name,
    volume24h: num(pool.attributes?.volume_usd?.h24),
    priceChange24h: num(pool.attributes?.price_change_percentage?.h24),
    marketCap: num(pool.attributes?.market_cap_usd) ?? num(pool.attributes?.fdv_usd),
    liquidity: num(pool.attributes?.reserve_in_usd),
    buyers24h: num(pool.attributes?.transactions?.h24?.buyers),
  };
}

async function listPools(path: string, pages: number): Promise<PoolRow[]> {
  const out: PoolRow[] = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const body = (await geckoFetch(`${path}?page=${page}`)) as { data?: GeckoPool[] };
      for (const pool of body?.data ?? []) {
        const row = toPoolRow(pool);
        if (row) out.push(row);
      }
    } catch (err) {
      if (page === 1) throw err;
      break; // one good page still renders something useful
    }
  }
  return out;
}

// ---- 24h ------------------------------------------------------------------------------

let h24InFlight: Promise<TrendingToken[]> | null = null;

export async function getTrending24h(): Promise<{
  tokens: TrendingToken[];
  fetchedAt: number;
  cached: boolean;
}> {
  const hit = cache.getTrending(H24_TTL_MS);
  // Sliced on read as well as on write, so an entry cached by an earlier build with a
  // different length can't leak through.
  if (hit) return { ...hit, tokens: hit.tokens.slice(0, LIMIT), cached: true };

  if (!h24InFlight) {
    h24InFlight = fetch24h().finally(() => {
      h24InFlight = null;
    });
  }

  const tokens = await h24InFlight;
  const fetchedAt = Date.now();
  if (tokens.length > 0) cache.putTrending(tokens, fetchedAt);
  return { tokens, fetchedAt, cached: false };
}

async function fetch24h(): Promise<TrendingToken[]> {
  // Trending alone is too thin once the quality gate is applied, so the volume listing is
  // pulled in as well and the two are merged.
  const pools = [
    ...(await listPools('/trending_pools', H24_PAGES)),
    ...(await listPools('/pools', 2)),
  ];
  return dedupeByMint(pools)
    .filter(isQualityPool)
    .sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0))
    .slice(0, LIMIT);
}

// ---- 7 day ----------------------------------------------------------------------------

let d7InFlight: Promise<void> | null = null;

export function getTrending7d(): {
  tokens: TrendingToken[];
  fetchedAt: number | null;
  computing: boolean;
} {
  const hit = cache.getTrending7d(D7_TTL_MS);

  // Kick off a refresh when the cache is cold or stale, but never block on it — the caller
  // gets whatever is already known and the panel fills in on a later poll.
  if (!hit && !d7InFlight) {
    d7InFlight = compute7d()
      .catch(() => undefined)
      .finally(() => {
        d7InFlight = null;
      });
  }

  const stale = cache.getTrending7d(Number.MAX_SAFE_INTEGER);
  return {
    tokens: hit?.tokens ?? stale?.tokens ?? [],
    fetchedAt: hit?.fetchedAt ?? stale?.fetchedAt ?? null,
    computing: d7InFlight !== null,
  };
}

/**
 * Sums seven days of daily candles per pool.
 *
 * The candidate set is today's trending pools plus the top pools by 24h volume — the
 * listings are only ever sorted by 24h, so a token that ran hard five days ago and has since
 * gone quiet can fall outside it. That's a real limitation of ranking a 7-day window using
 * 24h-sorted inputs, and why the panel says "top pools by 7-day volume" rather than claiming
 * to be exhaustive.
 */
async function compute7d(): Promise<void> {
  // Filtering before the OHLCV pass matters twice over: it keeps equities and wash-traded
  // pools out of the ranking, and it means a request is only spent on pools that could
  // plausibly appear in the final list.
  const candidates = dedupeByMint([
    ...(await listPools('/trending_pools', D7_TREND_PAGES)),
    ...(await listPools('/pools', D7_TOP_PAGES)),
  ])
    .filter(isQualityPool)
    .slice(0, D7_MAX_POOLS);

  const scored: TrendingToken[] = [];
  let failed = 0;

  for (const c of candidates) {
    try {
      const body = (await geckoFetch(`/pools/${c.pool}/ohlcv/day?aggregate=1&limit=7`)) as {
        data?: { attributes?: { ohlcv_list?: number[][] } };
      };
      const list = body?.data?.attributes?.ohlcv_list ?? [];
      // Each candle is [timestamp, open, high, low, close, volume].
      const total = list.reduce((sum, candle) => sum + (num(candle[5]) ?? 0), 0);
      if (total > 0) scored.push({ ...c, volume24h: total });
    } catch {
      failed += 1;
    }

    // Publish as we go. A run that dies partway then still leaves a usable panel, rather
    // than discarding everything it had already paid for.
    if (scored.length > 0 && scored.length % 5 === 0) publish(scored);
  }

  if (failed > 0) {
    console.warn(`[trending] 7-day pass: ${failed}/${candidates.length} pools unreadable (likely rate limited)`);
  }
  if (scored.length > 0) publish(scored);

  function publish(rows: TrendingToken[]) {
    const tokens = [...rows].sort((a, b) => (b.volume24h ?? 0) - (a.volume24h ?? 0)).slice(0, LIMIT);
    cache.putTrending7d(tokens, Date.now());
  }
}

function dedupeByMint(rows: PoolRow[]): PoolRow[] {
  const byMint = new Map<string, PoolRow>();
  for (const r of rows) {
    // Keep the deepest pool for a mint, since that's the one carrying its real volume.
    const existing = byMint.get(r.mint);
    if (!existing || (r.volume24h ?? 0) > (existing.volume24h ?? 0)) byMint.set(r.mint, r);
  }
  return [...byMint.values()];
}
