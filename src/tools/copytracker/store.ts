import { db } from '../../shared/db.js';
import type { PoolTrade } from '../../shared/gecko.js';
import type { BuyEvent, Observation } from './types.js';

/**
 * The persistent side of Copy Tracker.
 *
 * A single trace is weak evidence — one wallet buying ahead of another once is a coincidence.
 * The tool gets its power from accumulation: every event ever analysed for a follower stays
 * on record, so the confidence score is computed over the whole history rather than over
 * whatever tokens happened to be typed into the form today. Run it again next week with two
 * new coins and the same three candidates either keep leading or they don't.
 *
 * The free trade log feeds the same store from the other direction, recording live activity
 * on tracked tokens so that future windows can be answered without spending quota.
 */
db.exec(`
  -- Live trades captured free from GeckoTerminal.
  CREATE TABLE IF NOT EXISTS ct_trade_log (
    mint       TEXT NOT NULL,
    tx         TEXT NOT NULL,
    wallet     TEXT NOT NULL,
    side       TEXT NOT NULL,
    time       INTEGER NOT NULL,
    volume_usd REAL,
    PRIMARY KEY (mint, tx, wallet)
  );
  CREATE INDEX IF NOT EXISTS ct_trade_log_mint_time ON ct_trade_log (mint, time);

  -- Contiguous stretches of time the log actually covers for a mint. Without this we could
  -- not tell "no buys happened" apart from "we weren't watching", and would silently report
  -- an empty window as evidence of nobody leading.
  CREATE TABLE IF NOT EXISTS ct_log_coverage (
    mint    TEXT NOT NULL,
    from_ts INTEGER NOT NULL,
    to_ts   INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ct_log_coverage_mint ON ct_log_coverage (mint);

  -- Tokens the free logger polls.
  CREATE TABLE IF NOT EXISTS ct_tracked (
    mint      TEXT PRIMARY KEY,
    pool      TEXT,
    symbol    TEXT,
    added_at  INTEGER NOT NULL,
    last_poll INTEGER
  );

  -- One buy by a followed wallet.
  CREATE TABLE IF NOT EXISTS ct_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    follower     TEXT    NOT NULL,
    mint         TEXT    NOT NULL,
    symbol       TEXT,
    buy_ts       INTEGER NOT NULL,
    tx           TEXT,
    window_secs  INTEGER NOT NULL,
    scanned_buys INTEGER NOT NULL,
    source       TEXT    NOT NULL,
    incomplete   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    UNIQUE (follower, mint, buy_ts)
  );
  CREATE INDEX IF NOT EXISTS ct_events_follower ON ct_events (follower);

  -- A wallet that bought inside an event's window.
  CREATE TABLE IF NOT EXISTS ct_observations (
    event_id       INTEGER NOT NULL,
    candidate      TEXT    NOT NULL,
    lead_ms        INTEGER NOT NULL,
    buys_in_window INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (event_id, candidate)
  );
  CREATE INDEX IF NOT EXISTS ct_observations_candidate ON ct_observations (candidate);

  -- The followed wallet's own buy list. Walking its history is the single biggest cost in a
  -- trace — six pages regardless of how many tokens were entered — and past trades never
  -- change, so only the recent tail is worth refetching.
  CREATE TABLE IF NOT EXISTS ct_follower_buys (
    follower   TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

/** How long a cached buy list stays usable before the tail is considered stale. */
const BUYS_TTL_MS = 6 * 3600_000;

export const store = {
  /** Returns the event id, reusing the row when this buy has been analysed before. */
  saveEvent(follower: string, e: BuyEvent, windowSecs: number): number {
    db.prepare(
      `INSERT INTO ct_events (follower, mint, symbol, buy_ts, tx, window_secs, scanned_buys, source, incomplete, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (follower, mint, buy_ts) DO UPDATE SET
         scanned_buys = excluded.scanned_buys,
         source       = excluded.source,
         incomplete   = excluded.incomplete,
         window_secs  = excluded.window_secs`,
    ).run(
      follower,
      e.mint,
      e.symbol,
      e.time,
      e.tx,
      windowSecs,
      e.scannedBuys,
      e.source,
      e.windowIncomplete ? 1 : 0,
      Date.now(),
    );

    const row = db
      .prepare('SELECT id FROM ct_events WHERE follower = ? AND mint = ? AND buy_ts = ?')
      .get(follower, e.mint, e.time) as { id: number };
    return row.id;
  },

  saveObservations(eventId: number, observations: Observation[]) {
    const stmt = db.prepare(
      `INSERT INTO ct_observations (event_id, candidate, lead_ms, buys_in_window)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (event_id, candidate) DO UPDATE SET
         lead_ms        = MIN(lead_ms, excluded.lead_ms),
         buys_in_window = excluded.buys_in_window`,
    );
    db.transaction((rows: Observation[]) => {
      for (const o of rows) stmt.run(eventId, o.candidate, o.leadMs, o.buysInWindow);
    })(observations);
  },

  /** Has this exact buy already been analysed? Lets a re-run skip paying for it again. */
  findEvent(
    follower: string,
    mint: string,
    buyTs: number,
  ): { id: number; scannedBuys: number; source: string; incomplete: boolean } | null {
    const row = db
      .prepare('SELECT id, scanned_buys, source, incomplete FROM ct_events WHERE follower = ? AND mint = ? AND buy_ts = ?')
      .get(follower, mint, buyTs) as
      | { id: number; scanned_buys: number; source: string; incomplete: number }
      | undefined;
    return row
      ? { id: row.id, scannedBuys: row.scanned_buys, source: row.source, incomplete: row.incomplete === 1 }
      : null;
  },

  /** Everything ever recorded for a follower — the basis for the confidence score. */
  history(follower: string) {
    const events = db
      .prepare('SELECT id, mint, symbol, buy_ts, scanned_buys FROM ct_events WHERE follower = ? ORDER BY buy_ts')
      .all(follower) as Array<{ id: number; mint: string; symbol: string | null; buy_ts: number; scanned_buys: number }>;

    if (events.length === 0) return { events, observations: [] as ObservationRow[] };

    const ids = events.map((e) => e.id);
    const observations = db
      .prepare(
        `SELECT o.event_id, o.candidate, o.lead_ms, o.buys_in_window, e.mint, e.symbol, e.buy_ts
           FROM ct_observations o JOIN ct_events e ON e.id = o.event_id
          WHERE o.event_id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as ObservationRow[];

    return { events, observations };
  },

  /** Wallets this follower has been traced against before, for the recent-traces list. */
  recentFollowers(limit = 10) {
    return db
      .prepare(
        `SELECT follower, COUNT(*) AS events, MAX(created_at) AS last_run
           FROM ct_events GROUP BY follower ORDER BY last_run DESC LIMIT ?`,
      )
      .all(limit) as Array<{ follower: string; events: number; last_run: number }>;
  },

  forgetFollower(follower: string) {
    const ids = (db.prepare('SELECT id FROM ct_events WHERE follower = ?').all(follower) as Array<{ id: number }>).map(
      (r) => r.id,
    );
    if (ids.length === 0) return 0;
    const list = ids.map(() => '?').join(',');
    db.transaction(() => {
      db.prepare(`DELETE FROM ct_observations WHERE event_id IN (${list})`).run(...ids);
      db.prepare('DELETE FROM ct_events WHERE follower = ?').run(follower);
    })();
    return ids.length;
  },

  /** Cached buy list, or undefined when absent or stale enough to have missed new trades. */
  getFollowerBuys(follower: string): Array<{ mint: string; symbol: string; time: number; tx: string }> | undefined {
    const row = db
      .prepare('SELECT json, fetched_at FROM ct_follower_buys WHERE follower = ?')
      .get(follower) as { json: string; fetched_at: number } | undefined;
    if (!row || Date.now() - row.fetched_at > BUYS_TTL_MS) return undefined;
    return JSON.parse(row.json);
  },

  putFollowerBuys(follower: string, buys: Array<{ mint: string; symbol: string; time: number; tx: string }>) {
    db.prepare(
      'INSERT OR REPLACE INTO ct_follower_buys (follower, json, fetched_at) VALUES (?, ?, ?)',
    ).run(follower, JSON.stringify(buys), Date.now());
  },

  // --- free trade log ---------------------------------------------------------------

  appendTrades(mint: string, trades: PoolTrade[]) {
    if (trades.length === 0) return;
    const stmt = db.prepare(
      `INSERT OR IGNORE INTO ct_trade_log (mint, tx, wallet, side, time, volume_usd) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    db.transaction((rows: PoolTrade[]) => {
      for (const t of rows) stmt.run(mint, t.tx, t.wallet, t.side, t.time, t.volumeUsd);
    })(trades);

    const from = Math.min(...trades.map((t) => t.time));
    const to = Math.max(...trades.map((t) => t.time));
    this.addCoverage(mint, from, to);
  },

  /** Records a watched stretch, merging into any range it touches so gaps stay real gaps. */
  addCoverage(mint: string, from: number, to: number) {
    // A poll every 90s against a window that reaches back further than that will overlap the
    // previous one; allowing a small joining tolerance keeps the table from fragmenting.
    const JOIN_TOLERANCE_MS = 5 * 60_000;
    const overlapping = db
      .prepare('SELECT rowid, from_ts, to_ts FROM ct_log_coverage WHERE mint = ? AND to_ts >= ? AND from_ts <= ?')
      .all(mint, from - JOIN_TOLERANCE_MS, to + JOIN_TOLERANCE_MS) as Array<{
      rowid: number;
      from_ts: number;
      to_ts: number;
    }>;

    let lo = from;
    let hi = to;
    for (const r of overlapping) {
      lo = Math.min(lo, r.from_ts);
      hi = Math.max(hi, r.to_ts);
    }
    db.transaction(() => {
      for (const r of overlapping) db.prepare('DELETE FROM ct_log_coverage WHERE rowid = ?').run(r.rowid);
      db.prepare('INSERT INTO ct_log_coverage (mint, from_ts, to_ts) VALUES (?, ?, ?)').run(mint, lo, hi);
    })();
  },

  /** True only when the log demonstrably watched the whole of [from, to] for this mint. */
  coversWindow(mint: string, from: number, to: number): boolean {
    const row = db
      .prepare('SELECT 1 AS ok FROM ct_log_coverage WHERE mint = ? AND from_ts <= ? AND to_ts >= ? LIMIT 1')
      .get(mint, from, to) as { ok: number } | undefined;
    return row !== undefined;
  },

  buysInWindow(mint: string, from: number, to: number) {
    return db
      .prepare(
        `SELECT wallet, time, tx FROM ct_trade_log
          WHERE mint = ? AND side = 'buy' AND time >= ? AND time <= ? ORDER BY time DESC`,
      )
      .all(mint, from, to) as Array<{ wallet: string; time: number; tx: string }>;
  },

  track(mint: string, pool: string | null, symbol: string | null) {
    db.prepare(
      `INSERT INTO ct_tracked (mint, pool, symbol, added_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (mint) DO UPDATE SET pool = COALESCE(excluded.pool, pool), symbol = COALESCE(excluded.symbol, symbol)`,
    ).run(mint, pool, symbol, Date.now());
  },

  untrack(mint: string) {
    db.prepare('DELETE FROM ct_tracked WHERE mint = ?').run(mint);
  },

  tracked() {
    // The logged-trade count and watched span come from the log itself rather than a
    // counter on the row, so they stay correct even if trades arrive from a trace rather
    // than from a poll.
    return db
      .prepare(
        `SELECT t.mint, t.pool, t.symbol, t.added_at, t.last_poll,
                (SELECT COUNT(*) FROM ct_trade_log l WHERE l.mint = t.mint) AS trades,
                (SELECT MIN(from_ts) FROM ct_log_coverage c WHERE c.mint = t.mint) AS covered_from,
                (SELECT MAX(to_ts)   FROM ct_log_coverage c WHERE c.mint = t.mint) AS covered_to
           FROM ct_tracked t ORDER BY t.added_at`,
      )
      .all() as Array<{
      mint: string;
      pool: string | null;
      symbol: string | null;
      added_at: number;
      last_poll: number | null;
      trades: number;
      covered_from: number | null;
      covered_to: number | null;
    }>;
  },

  markPolled(mint: string) {
    db.prepare('UPDATE ct_tracked SET last_poll = ? WHERE mint = ?').run(Date.now(), mint);
  },

  logStats() {
    const one = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
    return {
      trades: one('SELECT COUNT(*) AS n FROM ct_trade_log'),
      mints: one('SELECT COUNT(DISTINCT mint) AS n FROM ct_trade_log'),
      tracked: one('SELECT COUNT(*) AS n FROM ct_tracked'),
      events: one('SELECT COUNT(*) AS n FROM ct_events'),
      observations: one('SELECT COUNT(*) AS n FROM ct_observations'),
      followers: one('SELECT COUNT(DISTINCT follower) AS n FROM ct_events'),
    };
  },
};

export interface ObservationRow {
  event_id: number;
  candidate: string;
  lead_ms: number;
  buys_in_window: number;
  mint: string;
  symbol: string | null;
  buy_ts: number;
}
