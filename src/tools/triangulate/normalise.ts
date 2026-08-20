import type { Position, TokenMeta } from '../../shared/types.js';

/**
 * Solana Tracker's docs describe several nesting shapes for the same figures across the
 * /traders, /first-buyers and /positions/batch endpoints (pnl.realized vs pnl.token.realized,
 * position.balance vs balance, and so on). Rather than guess one and break on the others,
 * every field is read through a path list and the first hit wins.
 */
function pick(obj: unknown, paths: string[]): unknown {
  for (const path of paths) {
    let cur: unknown = obj;
    let ok = true;
    for (const key of path.split('.')) {
      if (cur && typeof cur === 'object' && key in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[key];
      } else {
        ok = false;
        break;
      }
    }
    if (ok && cur !== undefined && cur !== null) return cur;
  }
  return undefined;
}

function numAt(obj: unknown, paths: string[], fallback = 0): number {
  const v = pick(obj, paths);
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

function msAt(obj: unknown, paths: string[]): number | null {
  const v = pick(obj, paths);
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  // Some fields come back in seconds; anything below ~2001 in ms is really a second value.
  return n < 1e12 ? n * 1000 : n;
}

function strAt(obj: unknown, paths: string[]): string | undefined {
  const v = pick(obj, paths);
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function normalisePosition(raw: unknown, mintFallback: string): Position | null {
  const wallet = strAt(raw, ['wallet', 'address', 'owner', 'walletAddress']);
  if (!wallet) return null;

  return {
    wallet,
    mint: strAt(raw, ['token', 'mint', 'tokenAddress', 'meta.mint']) ?? mintFallback,
    realized: numAt(raw, ['pnl.realized', 'pnl.token.realized', 'realized', 'realizedPnl']),
    unrealized: numAt(raw, ['pnl.unrealized', 'pnl.token.unrealized', 'unrealized', 'unrealizedPnl']),
    invested: numAt(raw, ['invested', 'volume.buyUsd', 'totalInvested']),
    roi: (() => {
      const v = pick(raw, ['roi', 'pnl.roi']);
      const n = typeof v === 'string' ? Number(v) : v;
      return typeof n === 'number' && Number.isFinite(n) ? n : null;
    })(),
    proceeds: numAt(raw, ['proceeds', 'volume.sellUsd', 'totalProceeds']),
    buys: numAt(raw, ['counts.buys', 'buys', 'buyTransactions']),
    sells: numAt(raw, ['counts.sells', 'sells', 'sellTransactions']),
    balance: numAt(raw, ['position.balance', 'balance', 'current.balance', 'holding']),
    firstBuy: msAt(raw, ['timing.firstBuy', 'firstBuy', 'timing.firstTrade', 'firstTrade']),
    firstTrade: msAt(raw, ['timing.firstTrade', 'firstTrade']),
    lastTrade: msAt(raw, ['timing.lastTrade', 'lastTrade']),
    holdTimeSecs: (() => {
      const v = numAt(raw, ['timing.holdTimeSecs', 'holdTimeSecs', 'summary.timing.avgHoldTimeSecs'], -1);
      return v >= 0 ? v : null;
    })(),
    walletLifetimeTrades: (() => {
      const v = numAt(raw, ['pnl.wallet.totalTrades', 'summary.counts.trades', 'counts.trades'], -1);
      return v >= 0 ? v : null;
    })(),
    tokensBought: (() => {
      const v = numAt(raw, ['volume.tokensBought', 'tokensBought'], -1);
      return v >= 0 ? v : null;
    })(),
    tokensSold: (() => {
      const v = numAt(raw, ['volume.tokensSold', 'tokensSold'], -1);
      return v >= 0 ? v : null;
    })(),
    identityType: strAt(raw, ['identity.type', 'type']) ?? null,
    isArbitrage: pick(raw, ['tags.isArbitrage', 'isArbitrage']) === true,
  };
}

/**
 * Solana mainnet predates any real token launch we'd query, so anything earlier than this
 * is a corrupt record rather than an early buy.
 */
const EARLIEST_CREDIBLE = Date.parse('2020-01-01T00:00:00Z');

/**
 * Solana Tracker's PnL index starts here. Verified by querying tokens launched years apart
 * — BONK (2022), RAY (2021), WIF and POPCAT — which all report their earliest first-buy at
 * 2023-12-30T13:10Z to the minute.
 *
 * For any token that launched before this, the API's history is truncated: its "first
 * buyers" are merely the first buyers after the index opened, and realized PnL omits every
 * earlier trade. Timing filters are meaningless on such tokens, so we detect and flag them
 * rather than silently returning nothing.
 */
export const INDEX_FLOOR = Date.parse('2023-12-30T13:10:00Z');
const FLOOR_TOLERANCE_MS = 6 * 3600_000;

/**
 * Estimates a token's launch from the earliest credible first-buy actually observed.
 *
 * Pool `createdAt` can't be trusted for this: many pools omit it, and the earliest pool that
 * does report one is often a later migration rather than the original (WIF reports 2024-05
 * against a 2023-12 launch). Observed buys are the ground truth we already hold.
 */
export function deriveLaunch(
  firstBuys: Array<number | null>,
  poolCreatedAt: number | null,
): { launchAt: number | null; source: 'observed' | 'pool' | 'none'; truncated: boolean } {
  const credible = firstBuys.filter((t): t is number => t !== null && t >= EARLIEST_CREDIBLE).sort((a, b) => a - b);

  if (credible.length === 0) {
    return poolCreatedAt !== null
      ? { launchAt: poolCreatedAt, source: 'pool', truncated: false }
      : { launchAt: null, source: 'none', truncated: false };
  }

  // The first buy we can actually see beats pool creation in both directions: pools are
  // often created well before trading opens (BONK's reports 8 Dec against a ~25 Dec start),
  // and the earliest pool reporting a date is often a later migration (WIF reports 2024-05
  // against a 2023-12 start). A pool with no trades in it isn't a launch.
  const observed = credible[0]!;

  // Sitting on the index floor means the real launch is older than the data, not that the
  // token launched that day.
  const truncated = observed <= INDEX_FLOOR + FLOOR_TOLERANCE_MS;

  return { launchAt: observed, source: 'observed', truncated };
}

export function normaliseTokenMeta(raw: unknown, mint: string): TokenMeta {
  const pools = (pick(raw, ['pools']) as unknown[] | undefined) ?? [];

  let firstPoolAt: number | null = null;
  const deployers = new Set<string>();

  for (const pool of pools) {
    const created = msAt(pool, ['createdAt', 'created_at', 'creationTime']);
    if (created !== null && (firstPoolAt === null || created < firstPoolAt)) firstPoolAt = created;

    const deployer = strAt(pool, ['deployer', 'creator', 'owner']);
    if (deployer) deployers.add(deployer);
  }

  // `token.creator` is an object ({name, site}) on some tokens and absent on others, so it
  // only contributes when it's actually a wallet string.
  const creator = strAt(raw, ['token.creation.creator', 'token.creator', 'creator']);
  if (creator) deployers.add(creator);

  let txnsTotal: number | null = null;
  for (const pool of pools) {
    const t = numAt(pool, ['txns.total'], -1);
    if (t >= 0) txnsTotal = (txnsTotal ?? 0) + t;
  }

  const holdersRaw = numAt(raw, ['holders'], -1);

  return {
    mint,
    symbol: strAt(raw, ['token.symbol', 'symbol']) ?? '???',
    name: strAt(raw, ['token.name', 'name']) ?? mint.slice(0, 8),
    decimals: numAt(raw, ['token.decimals', 'decimals'], 6),
    firstPoolAt,
    deployers: [...deployers],
    holders: holdersRaw >= 0 ? holdersRaw : null,
    txnsTotal,
    launchAt: firstPoolAt,
    launchSource: firstPoolAt !== null ? 'pool' : 'none',
    historyTruncated: false,
  };
}

/** Pulls the trader array out of a /traders response regardless of its wrapper key. */
export function extractTraders(raw: unknown): unknown[] {
  const candidates = ['traders', 'holders', 'data', 'results', 'positions'];
  for (const key of candidates) {
    const v = pick(raw, [key]);
    if (Array.isArray(v)) return v;
  }
  return Array.isArray(raw) ? raw : [];
}

export function extractPagination(raw: unknown): { nextCursor: string | null; hasMore: boolean; total: number | null } {
  const nextCursorRaw = pick(raw, ['pagination.nextCursor', 'nextCursor', 'cursor', 'pagination.cursor']);
  const nextCursor =
    typeof nextCursorRaw === 'string' || typeof nextCursorRaw === 'number' ? String(nextCursorRaw) : null;

  const hasMoreRaw = pick(raw, ['pagination.hasMore', 'hasMore', 'hasNextPage', 'pagination.hasNextPage']);
  const totalRaw = pick(raw, ['pagination.total', 'total', 'pagination.count']);
  const total = typeof totalRaw === 'number' && Number.isFinite(totalRaw) ? totalRaw : null;

  return {
    nextCursor,
    hasMore: hasMoreRaw === true || (hasMoreRaw === undefined && nextCursor !== null),
    total,
  };
}

/** Pulls positions out of a batch-lookup response regardless of its wrapper key. */
export function extractBatchPositions(raw: unknown): unknown[] {
  const candidates = ['positions', 'results', 'data', 'found'];
  for (const key of candidates) {
    const v = pick(raw, [key]);
    if (Array.isArray(v)) return v;
  }
  return Array.isArray(raw) ? raw : [];
}
