import 'dotenv/config';
import { resolve } from 'node:path';

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const config = {
  port: num('PORT', 3000),
  apiKey: (process.env.SOLANA_TRACKER_API_KEY ?? '').trim(),
  baseUrl: (process.env.SOLANA_TRACKER_BASE_URL ?? 'https://data.solanatracker.io').replace(/\/+$/, ''),
  rateLimitPerSec: num('RATE_LIMIT_PER_SEC', 3),
  maxRequestsPerQuery: num('MAX_REQUESTS_PER_QUERY', 1500),
  /**
   * The anchor's trader list is fetched sorted by realized profit descending, so capping it
   * keeps the most profitable wallets and simply ignores the long tail. Enumeration and the
   * intersection probe both scale with this, so it is the single biggest lever on cost:
   * a freshly trending token can have 19,000 traders, which is ~190 requests uncapped.
   */
  anchorWalletCap: num('ANCHOR_WALLET_CAP', 2000),
  cacheTtlHours: num('CACHE_TTL_HOURS', 24),
  dbPath: resolve(process.cwd(), process.env.DB_PATH ?? './data/cache.sqlite'),

  // --- Cost control -------------------------------------------------------------------
  /**
   * Solana Tracker's monthly free allowance. Requests beyond it either stop or spend paid
   * credit, depending on the two settings below — never silently.
   */
  freeMonthlyLimit: num('SOLANA_TRACKER_FREE_MONTHLY', 10_000),
  /** Day of the month the allowance resets. Clamped to 1–28 so every month has one. */
  quotaResetDay: num('QUOTA_RESET_DAY', 1),
  /** Paid credit is opt-in: without this, work stops when the free allowance runs out. */
  paidEnabled: bool('PAID_CREDITS_ENABLED', false),
  /** Ceiling on paid requests per period, so an unattended job can't run up a bill. */
  paidCreditLimit: num('PAID_CREDIT_LIMIT', 0),
  /**
   * How long the free background logger sleeps between polls of each tracked pool.
   * GeckoTerminal is unmetered but rate limited, so this is politeness, not economy.
   */
  loggerIntervalSecs: num('LOGGER_INTERVAL_SECS', 90),
};

/**
 * Filters aimed at one archetype: buys early and rarely, holds, takes profit, and turns a
 * small stake into a large multiple.
 *
 * Snipers, bots, deployers and arbitrage wallets aren't options — they're removed
 * unconditionally, because no setting of them is ever wanted here.
 */
export const filterDefaults = {
  /**
   * The headline filter. Absolute profit finds whales: a wallet risking $500k to make $100k
   * outranks one that turned $100 into $150k. ROI finds the multiplier instead.
   * 300% = a 4x.
   */
  minRoiPercent: 300,
  /** Floor on stake, so dust positions with meaningless four-figure ROI don't dominate. */
  minInvestedUsd: 100,
  /**
   * Buys per token. Someone with conviction takes a position; a bot averages in dozens of
   * times. This is what "buys infrequently" means at the position level.
   */
  maxBuysPerToken: 10,
  /** Realised, not paper: the wallet must have actually sold into profit. */
  requireRealisedProfit: true,
  requireProfitOnAll: true,
  /** Only consulted when requireProfitOnAll is false. */
  minProfitableTokens: 2,

  /**
   * Wallet-wide ROI across everything it trades. One request per wallet, survivors only.
   *
   * This single threshold is the quality bar. Tested against seven wallets that looked
   * profitable on individual tokens, ROI >= 20% kept the two genuinely good traders and
   * rejected all five others — three that were net losers across their portfolios
   * (one down $77,885), a 17,690-trade KOL, and a 10,872-trade account.
   */
  checkWalletProfitability: true,
  minWalletRoi: 20,
  /**
   * Win-rate floor, off by default and deliberately so. A high win rate selects scalpers
   * taking many small wins; the asymmetric traders worth copying lose often and win huge.
   * One of the best wallets tested had 64% ROI on a 33% win rate, and any floor above ~30
   * would have discarded it.
   */
  minWinRate: 0,

  /**
   * Trade-frequency window. Off by default: frequency turned out not to separate skill.
   * A 3,589-trade wallet returned 38% with a 57% win rate, while a 403-trade wallet lost
   * money. Capping frequency threw away the profitable traders and kept quiet losers — and
   * it conflicts with the premise anyway, since a wallet taking a handful of positions a
   * week rarely takes two *particular* ones.
   */
  checkRecentActivity: false,
  activityWindowDays: 3,
  minTradesInWindow: 0,
  maxTradesInWindow: 50,

  /** Ceiling on how many wallets receive the paid per-wallet checks. */
  maxWalletChecks: 40,

  /** Solana Tracker's handling of positions its heuristics flag as suspect. */
  pnlMode: 'adjusted' as 'strict' | 'adjusted' | 'raw',

  // --- Not configurable on purpose ---
  /** Sniper window in seconds; wallets inside it are always dropped. */
  sniperWindowSecs: 30,
  /** Wallets exceeding this many swaps across the queried tokens are always dropped. */
  maxTotalSwaps: 500,
};

export type Filters = typeof filterDefaults;
