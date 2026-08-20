import { config } from './config.js';
import { db } from './db.js';

/**
 * Where a request's cost lands.
 *
 *  - `free`   GeckoTerminal. Keyless, unmetered, and billed to nobody. Preferred always.
 *  - `quota`  Solana Tracker inside the monthly free allowance.
 *  - `paid`   Solana Tracker beyond that allowance, against credit that costs real money.
 *
 * The tier is decided per request rather than per provider, because the same Solana Tracker
 * call is free on the 4,000th request of the month and paid on the 10,001st.
 */
export type Tier = 'free' | 'quota' | 'paid';
export type Provider = 'geckoterminal' | 'solanatracker';

db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT    NOT NULL,
    tier     TEXT    NOT NULL,
    endpoint TEXT    NOT NULL,
    ok       INTEGER NOT NULL,
    ts       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS api_usage_ts ON api_usage (ts);
  CREATE INDEX IF NOT EXISTS api_usage_provider_ts ON api_usage (provider, ts);
`);

const insert = db.prepare(
  'INSERT INTO api_usage (provider, tier, endpoint, ok, ts) VALUES (?, ?, ?, ?, ?)',
);

/**
 * Start of the current quota period, in unix ms.
 *
 * Solana Tracker resets on a calendar month. If the reset day hasn't arrived yet this month,
 * the period started on that day last month.
 */
export function periodStart(now = Date.now()): number {
  const d = new Date(now);
  const day = Math.min(Math.max(config.quotaResetDay, 1), 28);
  const start = new Date(d.getFullYear(), d.getMonth(), day, 0, 0, 0, 0);
  if (start.getTime() > now) start.setMonth(start.getMonth() - 1);
  return start.getTime();
}

export function periodEnd(now = Date.now()): number {
  const start = new Date(periodStart(now));
  start.setMonth(start.getMonth() + 1);
  return start.getTime();
}

/** Requests billed to a provider in the current period. Only metered tiers are counted. */
export function usedThisPeriod(provider: Provider = 'solanatracker'): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM api_usage WHERE provider = ? AND tier != 'free' AND ts >= ?")
    .get(provider, periodStart()) as { n: number };
  return row.n;
}

export function paidThisPeriod(provider: Provider = 'solanatracker'): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM api_usage WHERE provider = ? AND tier = 'paid' AND ts >= ?")
    .get(provider, periodStart()) as { n: number };
  return row.n;
}

/**
 * Which tier the next Solana Tracker request would land in, without recording anything.
 *
 * Returns null when the request must not be made at all: the free allowance is gone and
 * either paid credit is switched off or it too is spent. Callers treat null as "stop", which
 * is what keeps an unattended background job from quietly running up a bill.
 */
export function nextTier(): Tier | null {
  const used = usedThisPeriod('solanatracker');
  if (used < config.freeMonthlyLimit) return 'quota';
  if (!config.paidEnabled) return null;
  if (paidThisPeriod('solanatracker') >= config.paidCreditLimit) return null;
  return 'paid';
}

export function record(provider: Provider, tier: Tier, endpoint: string, ok: boolean) {
  // Endpoints carry wallet and mint addresses; strip them so the usage log stays a log of
  // shapes rather than a second copy of what was searched.
  insert.run(provider, tier, generalise(endpoint), ok ? 1 : 0, Date.now());
}

function generalise(endpoint: string): string {
  return endpoint
    .replace(/\/[1-9A-HJ-NP-Za-km-z]{32,44}/g, '/{address}')
    .replace(/\?.*$/, '')
    .slice(0, 120);
}

export interface UsageSummary {
  period: { start: number; end: number; resetDay: number };
  quota: { used: number; limit: number; remaining: number; percent: number };
  paid: { used: number; limit: number; remaining: number; enabled: boolean };
  free: { thisPeriod: number; allTime: number };
  totals: { today: number; thisPeriod: number; allTime: number };
  byEndpoint: Array<{ provider: string; tier: string; endpoint: string; calls: number }>;
  daily: Array<{ day: string; free: number; quota: number; paid: number }>;
}

export function summary(): UsageSummary {
  const start = periodStart();
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);

  const count = (sql: string, ...params: unknown[]) =>
    (db.prepare(sql).get(...params) as { n: number }).n;

  const quotaUsed = usedThisPeriod('solanatracker');
  const paidUsed = paidThisPeriod('solanatracker');

  return {
    period: { start, end: periodEnd(), resetDay: config.quotaResetDay },
    quota: {
      used: Math.min(quotaUsed, config.freeMonthlyLimit),
      limit: config.freeMonthlyLimit,
      remaining: Math.max(0, config.freeMonthlyLimit - quotaUsed),
      percent: config.freeMonthlyLimit > 0 ? Math.min(100, (quotaUsed / config.freeMonthlyLimit) * 100) : 0,
    },
    paid: {
      used: paidUsed,
      limit: config.paidCreditLimit,
      remaining: Math.max(0, config.paidCreditLimit - paidUsed),
      enabled: config.paidEnabled,
    },
    free: {
      thisPeriod: count("SELECT COUNT(*) AS n FROM api_usage WHERE tier = 'free' AND ts >= ?", start),
      allTime: count("SELECT COUNT(*) AS n FROM api_usage WHERE tier = 'free'"),
    },
    totals: {
      today: count('SELECT COUNT(*) AS n FROM api_usage WHERE ts >= ?', dayStart.getTime()),
      thisPeriod: count('SELECT COUNT(*) AS n FROM api_usage WHERE ts >= ?', start),
      allTime: count('SELECT COUNT(*) AS n FROM api_usage'),
    },
    byEndpoint: db
      .prepare(
        `SELECT provider, tier, endpoint, COUNT(*) AS calls
           FROM api_usage WHERE ts >= ?
           GROUP BY provider, tier, endpoint
           ORDER BY calls DESC LIMIT 25`,
      )
      .all(start) as UsageSummary['byEndpoint'],
    daily: db
      .prepare(
        `SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day,
                SUM(tier = 'free')  AS free,
                SUM(tier = 'quota') AS quota,
                SUM(tier = 'paid')  AS paid
           FROM api_usage
           WHERE ts >= ?
           GROUP BY day ORDER BY day DESC LIMIT 30`,
      )
      .all(start) as UsageSummary['daily'],
  };
}
