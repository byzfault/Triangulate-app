import { config } from './config.js';
import { db } from './db.js';
import type { Position, TokenMeta, TrackRecord, TrendingToken } from './types.js';
import type { DeepCheckData, PriceSeries } from '../tools/triangulate/scoring/types.js';

db.exec(`
  CREATE TABLE IF NOT EXISTS token_meta (
    mint       TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS positions (
    mint       TEXT NOT NULL,
    wallet     TEXT NOT NULL,
    json       TEXT,              -- NULL means "provider has no position here" (negative cache)
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (mint, wallet)
  );

  CREATE INDEX IF NOT EXISTS positions_by_mint ON positions (mint);

  -- Records that a token's full trader list was enumerated, so we can serve the whole
  -- anchor set from cache instead of re-paginating it.
  CREATE TABLE IF NOT EXISTS enumerated (
    mint       TEXT PRIMARY KEY,
    total      INTEGER NOT NULL,
    truncated  INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Trending list, shared process-wide with a short TTL.
  CREATE TABLE IF NOT EXISTS trending (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Computed 7-day volume ranking. Expensive to build (one OHLCV call per pool), so the
  -- result is cached and refreshed in the background rather than on the request path.
  CREATE TABLE IF NOT EXISTS trending_7d (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Price series per mint. Historical candles are immutable, so these never expire; only
  -- the tail is ever missing, and the entry timestamps we look up are always in the past.
  CREATE TABLE IF NOT EXISTS price_series (
    mint       TEXT PRIMARY KEY,
    json       TEXT,
    fetched_at INTEGER NOT NULL
  );

  -- Circulating supply per mint, captured from token metadata.
  CREATE TABLE IF NOT EXISTS supply (
    mint   TEXT PRIMARY KEY,
    supply REAL
  );

  -- Tier-2 deep checks. Per-trade history is immutable, so this is kept indefinitely.
  CREATE TABLE IF NOT EXISTS deep_check (
    wallet     TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );

  -- Wallet-wide track record, one request per wallet.
  CREATE TABLE IF NOT EXISTS wallet_stats (
    wallet     TEXT PRIMARY KEY,
    json       TEXT,              -- NULL means the provider had no data
    fetched_at INTEGER NOT NULL
  );

  -- Rolling wallet activity, one request per wallet, so very much worth caching.
  CREATE TABLE IF NOT EXISTS activity (
    wallet     TEXT NOT NULL,
    days       INTEGER NOT NULL,
    trades     INTEGER,           -- NULL means the provider had no data for this wallet
    fetched_at INTEGER NOT NULL,
    PRIMARY KEY (wallet, days)
  );
`);

/** Bump whenever TrackRecord gains or changes a field, to invalidate older cached rows. */
const STATS_SCHEMA_VERSION = 2;

const ttlMs = () => config.cacheTtlHours * 3600_000;
const fresh = (fetchedAt: number) => Date.now() - fetchedAt < ttlMs();

export const cache = {
  getTokenMeta(mint: string): TokenMeta | null {
    const row = db.prepare('SELECT json, fetched_at FROM token_meta WHERE mint = ?').get(mint) as
      | { json: string; fetched_at: number }
      | undefined;
    if (!row || !fresh(row.fetched_at)) return null;
    return JSON.parse(row.json) as TokenMeta;
  },

  putTokenMeta(meta: TokenMeta) {
    db.prepare('INSERT OR REPLACE INTO token_meta (mint, json, fetched_at) VALUES (?, ?, ?)').run(
      meta.mint,
      JSON.stringify(meta),
      Date.now(),
    );
  },

  /** Returns undefined for "unknown", null for "known to have no position". */
  getPosition(mint: string, wallet: string): Position | null | undefined {
    const row = db.prepare('SELECT json, fetched_at FROM positions WHERE mint = ? AND wallet = ?').get(mint, wallet) as
      | { json: string | null; fetched_at: number }
      | undefined;
    if (!row || !fresh(row.fetched_at)) return undefined;
    return row.json === null ? null : (JSON.parse(row.json) as Position);
  },

  putPositions(mint: string, entries: Array<{ wallet: string; position: Position | null }>) {
    const stmt = db.prepare('INSERT OR REPLACE INTO positions (mint, wallet, json, fetched_at) VALUES (?, ?, ?, ?)');
    const now = Date.now();
    const tx = db.transaction((rows: typeof entries) => {
      for (const { wallet, position } of rows) {
        stmt.run(mint, wallet, position ? JSON.stringify(position) : null, now);
      }
    });
    tx(entries);
  },

  getEnumeration(mint: string): { total: number; truncated: boolean } | null {
    const row = db.prepare('SELECT total, truncated, fetched_at FROM enumerated WHERE mint = ?').get(mint) as
      | { total: number; truncated: number; fetched_at: number }
      | undefined;
    if (!row || !fresh(row.fetched_at)) return null;
    return { total: row.total, truncated: row.truncated === 1 };
  },

  putEnumeration(mint: string, total: number, truncated: boolean) {
    db.prepare('INSERT OR REPLACE INTO enumerated (mint, total, truncated, fetched_at) VALUES (?, ?, ?, ?)').run(
      mint,
      total,
      truncated ? 1 : 0,
      Date.now(),
    );
  },

  /** All cached positions for a fully-enumerated token. */
  listPositions(mint: string): Position[] {
    const rows = db
      .prepare('SELECT json FROM positions WHERE mint = ? AND json IS NOT NULL')
      .all(mint) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as Position);
  },

  /** undefined = not cached; null = cached, provider had no data. */
  getActivity(wallet: string, days: number): number | null | undefined {
    const row = db.prepare('SELECT trades, fetched_at FROM activity WHERE wallet = ? AND days = ?').get(wallet, days) as
      | { trades: number | null; fetched_at: number }
      | undefined;
    // A rolling window goes stale faster than position data, so it gets a shorter life.
    if (!row || Date.now() - row.fetched_at > Math.min(ttlMs(), 6 * 3600_000)) return undefined;
    return row.trades;
  },

  putActivity(wallet: string, days: number, trades: number | null) {
    db.prepare('INSERT OR REPLACE INTO activity (wallet, days, trades, fetched_at) VALUES (?, ?, ?, ?)').run(
      wallet,
      days,
      trades,
      Date.now(),
    );
  },

  getWalletStats(wallet: string): TrackRecord | null | undefined {
    const row = db.prepare('SELECT json, fetched_at FROM wallet_stats WHERE wallet = ?').get(wallet) as
      | { json: string | null; fetched_at: number }
      | undefined;
    if (!row || !fresh(row.fetched_at)) return undefined;
    if (row.json === null) return null;

    const parsed = JSON.parse(row.json) as TrackRecord & { _v?: number };
    // A row written before a field was added would come back with that field undefined,
    // which reads as "no opinion" rather than "missing" at the call site. Treat any
    // older shape as a cache miss instead.
    if (parsed._v !== STATS_SCHEMA_VERSION) return undefined;
    return parsed;
  },

  putWalletStats(wallet: string, stats: TrackRecord | null) {
    db.prepare('INSERT OR REPLACE INTO wallet_stats (wallet, json, fetched_at) VALUES (?, ?, ?)').run(
      wallet,
      stats ? JSON.stringify({ ...stats, _v: STATS_SCHEMA_VERSION }) : null,
      Date.now(),
    );
  },

  getTrending(ttlMs: number): { tokens: TrendingToken[]; fetchedAt: number } | null {
    const row = db.prepare('SELECT json, fetched_at FROM trending WHERE id = 1').get() as
      | { json: string; fetched_at: number }
      | undefined;
    if (!row || Date.now() - row.fetched_at > ttlMs) return null;
    return { tokens: JSON.parse(row.json) as TrendingToken[], fetchedAt: row.fetched_at };
  },

  putTrending(tokens: TrendingToken[], fetchedAt: number) {
    db.prepare('INSERT OR REPLACE INTO trending (id, json, fetched_at) VALUES (1, ?, ?)').run(
      JSON.stringify(tokens),
      fetchedAt,
    );
  },

  /** undefined = not cached; null = cached, no series available. */
  getPriceSeries(mint: string): PriceSeries | null | undefined {
    const row = db.prepare('SELECT json FROM price_series WHERE mint = ?').get(mint) as
      | { json: string | null }
      | undefined;
    if (!row) return undefined;
    return row.json === null ? null : (JSON.parse(row.json) as PriceSeries);
  },

  putPriceSeries(mint: string, series: PriceSeries | null) {
    db.prepare('INSERT OR REPLACE INTO price_series (mint, json, fetched_at) VALUES (?, ?, ?)').run(
      mint,
      series ? JSON.stringify(series) : null,
      Date.now(),
    );
  },

  getSupply(mint: string): number | null {
    const row = db.prepare('SELECT supply FROM supply WHERE mint = ?').get(mint) as
      | { supply: number | null }
      | undefined;
    return row?.supply ?? null;
  },

  putSupply(mint: string, supply: number | null) {
    db.prepare('INSERT OR REPLACE INTO supply (mint, supply) VALUES (?, ?)').run(mint, supply);
  },

  getDeepCheck(wallet: string): DeepCheckData | null {
    const row = db.prepare('SELECT json FROM deep_check WHERE wallet = ?').get(wallet) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as DeepCheckData) : null;
  },

  putDeepCheck(wallet: string, data: DeepCheckData) {
    db.prepare('INSERT OR REPLACE INTO deep_check (wallet, json, fetched_at) VALUES (?, ?, ?)').run(
      wallet,
      JSON.stringify(data),
      Date.now(),
    );
  },

  getTrending7d(ttlMs: number): { tokens: TrendingToken[]; fetchedAt: number } | null {
    const row = db.prepare('SELECT json, fetched_at FROM trending_7d WHERE id = 1').get() as
      | { json: string; fetched_at: number }
      | undefined;
    if (!row || Date.now() - row.fetched_at > ttlMs) return null;
    return { tokens: JSON.parse(row.json) as TrendingToken[], fetchedAt: row.fetched_at };
  },

  putTrending7d(tokens: TrendingToken[], fetchedAt: number) {
    db.prepare('INSERT OR REPLACE INTO trending_7d (id, json, fetched_at) VALUES (1, ?, ?)').run(
      JSON.stringify(tokens),
      fetchedAt,
    );
  },

  clear(mint: string) {
    db.prepare('DELETE FROM positions WHERE mint = ?').run(mint);
    db.prepare('DELETE FROM enumerated WHERE mint = ?').run(mint);
    db.prepare('DELETE FROM token_meta WHERE mint = ?').run(mint);
  },
};
