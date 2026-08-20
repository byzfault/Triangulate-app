import { api, type RequestBudget } from './client.js';
import { db } from './db.js';

/**
 * Is this wallet a human or a machine?
 *
 * Copy Tracker needs this because its whole premise breaks on bots. A sniper bot buys once
 * on each of hundreds of tokens, so within any single 60-second window it looks exactly like
 * a quiet, selective trader: one buy, negligible share of volume. Every in-window signal
 * misses it. Only the wallet's own history gives it away, and it gives it away instantly —
 * a real one measured here ran 5,053 trades a day, 8 seconds apart, with no gap longer than
 * six hours anywhere in its record.
 *
 * One page of history is enough to decide, so this costs a single request per wallet and is
 * cached permanently: what a wallet did last month does not change.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_profile (
    wallet     TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

export interface WalletProfile {
  wallet: string;
  /** Extrapolated from the sampled page. */
  tradesPerDay: number;
  medianGapSecs: number;
  /** Distinct tokens touched within the sample. */
  distinctTokens: number;
  /** Gaps over six hours, per day of the sample. Humans sleep; schedulers do not. */
  sleepGapsPerDay: number | null;
  sampleTrades: number;
  sampleHours: number;
  isBot: boolean;
  /** Plain-language reason, shown in the UI. Null when the wallet looks human. */
  reason: string | null;
}

/**
 * Thresholds are deliberately generous — a false "bot" hides a real source, which is worse
 * than letting a borderline wallet through to be judged on its timing instead.
 */
export const botThresholds = {
  /** An active human day-trader lands in the low hundreds at most. */
  tradesPerDay: 500,
  /** Touching this many distinct tokens a day is indiscriminate, not selective. */
  distinctTokensPerDay: 100,
  /** Trading this fast, sustained, is a loop rather than a person. */
  medianGapSecs: 20,
  minTradesForGapTest: 500,
  /** Never resting across a meaningful span is the clearest machine tell there is. */
  minDaysForSleepTest: 2,
  minSleepGapsPerDay: 0.1,
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export async function profileWallet(wallet: string, budget: RequestBudget): Promise<WalletProfile | null> {
  const cached = db.prepare('SELECT json FROM wallet_profile WHERE wallet = ?').get(wallet) as
    | { json: string }
    | undefined;
  if (cached) {
    budget.hit();
    return JSON.parse(cached.json) as WalletProfile;
  }

  let times: number[];
  let tokens: Set<string>;
  try {
    const raw = await api.get<{
      trades?: Array<{ time?: number; from?: { address?: string }; to?: { address?: string } }>;
    }>(`/wallet/${wallet}/trades`, {}, budget);

    const trades = raw?.trades ?? [];
    if (trades.length === 0) return null;

    times = trades
      .map((t) => (typeof t.time === 'number' ? (t.time < 1e12 ? t.time * 1000 : t.time) : null))
      .filter((t): t is number => t !== null)
      .sort((a, b) => a - b);

    tokens = new Set<string>();
    for (const t of trades) {
      for (const addr of [t.from?.address, t.to?.address]) {
        if (addr && !QUOTE_MINTS.has(addr)) tokens.add(addr);
      }
    }
  } catch {
    // A wallet we can't profile is left unjudged rather than assumed guilty.
    return null;
  }

  if (times.length < 2) return null;

  const spanMs = times[times.length - 1]! - times[0]!;
  const spanDays = Math.max(spanMs / DAY_MS, 1 / 1440); // floor at a minute, avoid divide-by-zero
  const gaps = times.slice(1).map((t, i) => (t - times[i]!) / 1000);
  const sorted = [...gaps].sort((a, b) => a - b);
  const medianGapSecs = sorted[Math.floor(sorted.length / 2)] ?? 0;

  const tradesPerDay = times.length / spanDays;
  const distinctTokensPerDay = tokens.size / spanDays;
  const sleepGaps = times.slice(1).filter((t, i) => t - times[i]! > 6 * HOUR_MS).length;
  const sleepGapsPerDay = spanDays >= botThresholds.minDaysForSleepTest ? sleepGaps / spanDays : null;

  const reasons: string[] = [];
  if (tradesPerDay > botThresholds.tradesPerDay) {
    reasons.push(`${Math.round(tradesPerDay).toLocaleString()} trades a day`);
  }
  if (distinctTokensPerDay > botThresholds.distinctTokensPerDay) {
    reasons.push(`${Math.round(distinctTokensPerDay)} new tokens a day`);
  }
  if (medianGapSecs < botThresholds.medianGapSecs && times.length >= botThresholds.minTradesForGapTest) {
    reasons.push(`a trade every ${medianGapSecs.toFixed(0)}s`);
  }
  if (sleepGapsPerDay !== null && sleepGapsPerDay < botThresholds.minSleepGapsPerDay) {
    reasons.push('never stops to sleep');
  }

  const profile: WalletProfile = {
    wallet,
    tradesPerDay,
    medianGapSecs,
    distinctTokens: tokens.size,
    sleepGapsPerDay,
    sampleTrades: times.length,
    sampleHours: spanMs / HOUR_MS,
    isBot: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join(', ') : null,
  };

  db.prepare('INSERT OR REPLACE INTO wallet_profile (wallet, json, fetched_at) VALUES (?, ?, ?)').run(
    wallet,
    JSON.stringify(profile),
    Date.now(),
  );
  return profile;
}

/** A cached profile only — for showing what is already known without spending a request. */
export function cachedProfile(wallet: string): WalletProfile | null {
  const row = db.prepare('SELECT json FROM wallet_profile WHERE wallet = ?').get(wallet) as
    | { json: string }
    | undefined;
  return row ? (JSON.parse(row.json) as WalletProfile) : null;
}

const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);
