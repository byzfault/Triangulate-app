import { api, BudgetExceededError, type RequestBudget } from '../../shared/client.js';
import { store } from './store.js';
import { rankCandidates } from './confidence.js';
import type { BuyEvent, Observation, TraceProgress, TraceResult } from './types.js';

/**
 * Copy Tracker: given a wallet you follow, work out who it is following.
 *
 * The premise is that a copy bot cannot act before the wallet it copies. So for each token
 * the followed wallet bought, look at who bought in the seconds immediately before it, and
 * keep doing that across tokens. Wallets that keep turning up in that gap are the shortlist;
 * everything else is noise that appeared once.
 *
 * Cost is what makes this practical. The naive version — pull a token's whole trade history
 * and search it — is thousands of requests per token. Instead the token trades endpoint's
 * cursor is a plain millisecond timestamp, so seeding it with the follower's buy time returns
 * the 250 trades immediately before that instant: exactly the window, for one request. A
 * five-token trace costs roughly a dozen requests, and windows already covered by the free
 * background logger cost nothing at all.
 */
const QUOTE_MINTS = new Set([
  'So11111111111111111111111111111111111111112', // wSOL
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/** Pages of the follower's own history to walk before giving up on finding their buys. */
const WALLET_PAGE_LIMIT = 6;
/** Extra pages of token history to pull when one page doesn't reach back far enough. */
const WINDOW_PAGE_LIMIT = 3;

export interface TraceOptions {
  /** How far back from each buy to look for a leader. */
  windowSecs: number;
  /** Analyse only the wallet's first buy of each token, or every buy it made. */
  firstBuyOnly: boolean;
  /** Minimum events a candidate must lead before it is listed. */
  minHits: number;
  /** Minimum distinct tokens a candidate must lead on. */
  minTokens: number;
}

export const traceDefaults: TraceOptions = {
  /**
   * 60 seconds. Wide enough for a copier that polls rather than streams, narrow enough that
   * an active token doesn't fill the window with unrelated buyers. The scoring rewards tight,
   * repeatable lead times, so widening this mostly adds candidates that then score badly.
   */
  windowSecs: 60,
  /**
   * The entry is the decision worth copying; later adds are position management and happen
   * on the copier's own schedule, so they blur the signal.
   */
  firstBuyOnly: true,
  minHits: 2,
  minTokens: 2,
};

type Emit = (e: TraceProgress) => void;

interface WalletTrade {
  tx?: string;
  time?: number;
  from?: { address?: string; token?: { symbol?: string } };
  to?: { address?: string; token?: { symbol?: string } };
}

export async function runTrace(
  follower: string,
  mints: string[],
  opts: TraceOptions,
  emit: Emit,
  budget: RequestBudget,
): Promise<TraceResult> {
  const startedAt = Date.now();
  const warnings: TraceResult['warnings'] = [];
  const warn = (kind: TraceResult['warnings'][number]['kind'], message: string) => {
    const warning = { kind, message };
    warnings.push(warning);
    emit({ type: 'warning', warning });
  };

  let freeWindows = 0;
  let paidWindows = 0;
  let cachedWindows = 0;
  let considered = 0;

  // ---- Phase 1: the follower's own buys ------------------------------------------------
  emit({ type: 'phase', phase: 'history', detail: 'Reading the followed wallet’s trade history' });

  const wanted = new Set(mints);
  const buys = await fetchFollowerBuys(follower, wanted, budget);
  if (buys.fromCache) budget.hit();

  if (buys.list.length === 0) {
    warn(
      'notice',
      `No buys of those tokens found in ${short(follower)}’s recent history. Either it never bought them, ` +
        `or they are further back than the last ${WALLET_PAGE_LIMIT * 1000} trades.`,
    );
    return finish([], []);
  }

  const missing = mints.filter((m) => !buys.list.some((b) => b.mint === m));
  if (missing.length > 0) {
    warn('partial', `No buy found for ${missing.length} of the ${mints.length} tokens entered, so they contribute nothing.`);
  }

  // One entry per token, or every buy, depending on the option.
  const events: BuyEvent[] = [];
  const seenToken = new Set<string>();
  for (const b of [...buys.list].sort((a, z) => a.time - z.time)) {
    if (opts.firstBuyOnly && seenToken.has(b.mint)) continue;
    seenToken.add(b.mint);
    events.push({ ...b, source: 'solanatracker', scannedBuys: 0, windowIncomplete: false });
  }

  // ---- Phase 2: who bought just before, per event ---------------------------------------
  const eventIds: number[] = [];

  for (const [i, event] of events.entries()) {
    emit({
      type: 'phase',
      phase: 'window',
      detail: `Scanning the ${opts.windowSecs}s before buy ${i + 1}/${events.length} (${event.symbol})`,
    });

    const from = event.time - opts.windowSecs * 1000;

    // Already analysed in a previous run? Then it is on record and costs nothing to reuse.
    const known = store.findEvent(follower, event.mint, event.time);
    if (known) {
      event.scannedBuys = known.scannedBuys;
      event.source = 'cached';
      event.windowIncomplete = known.incomplete;
      budget.hit();
      cachedWindows += 1;
      eventIds.push(known.id);
      continue;
    }

    // The free log first. It only ever holds recent activity, but when it does hold the
    // window it answers for nothing.
    //
    // Caveat worth knowing: GeckoTerminal reports whole seconds, where Solana Tracker
    // reports milliseconds. Rounding compresses the spread of tight lead times, which
    // flatters the timing-regularity component — the heaviest one in the score. A candidate
    // established entirely from free windows can therefore look slightly more machine-like
    // than it is. Mixed-source evidence is unaffected in practice, since the millisecond
    // observations dominate the variance.
    let observations: Observation[] | null = null;
    if (store.coversWindow(event.mint, from, event.time)) {
      const rows = store.buysInWindow(event.mint, from, event.time);
      observations = collapse(
        rows.filter((r) => r.wallet !== follower && r.tx !== event.tx).map((r) => ({
          wallet: r.wallet,
          leadMs: event.time - r.time,
        })),
      );
      event.scannedBuys = rows.length;
      event.source = 'free';
      freeWindows += 1;
      budget.hit();
    }

    if (observations === null) {
      try {
        const scan = await scanWindow(event, from, follower, budget);
        observations = scan.observations;
        event.scannedBuys = scan.scannedBuys;
        event.windowIncomplete = scan.incomplete;
        event.source = 'solanatracker';
        paidWindows += 1;
        if (scan.incomplete) {
          warn(
            'partial',
            `${event.symbol}: the token was busy enough that the window couldn’t be filled completely, so some leaders may be missing.`,
          );
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        warn('partial', `${event.symbol}: couldn’t read the trades before this buy (${(err as Error).message}).`);
        continue;
      }
    }

    const id = store.saveEvent(follower, event, opts.windowSecs);
    store.saveObservations(id, observations);
    eventIds.push(id);
  }

  // ---- Phase 3: score against everything ever recorded for this wallet -------------------
  emit({ type: 'phase', phase: 'scoring', detail: 'Weighing candidates against their base rate' });

  const history = store.history(follower);
  const ranked = rankCandidates(history.observations, history.events, {
    minHits: opts.minHits,
    minTokens: opts.minTokens,
  });
  const candidates = ranked.candidates;
  considered = ranked.considered;
  const eventsAllTime = history.events.length;

  if (eventsAllTime > events.length) {
    warn(
      'notice',
      `Scored against ${eventsAllTime} buys on record for this wallet, including ${
        eventsAllTime - events.length
      } from earlier traces. Confidence strengthens as you add more tokens over time.`,
    );
  }

  if (candidates.length === 0 && considered > 0) {
    warn(
      'notice',
      `${considered} wallets appeared in the windows but none met the bar of ${opts.minHits}+ leads across ${opts.minTokens}+ tokens. ` +
        `Add more tokens this wallet has bought — the pattern only separates from noise across several coins.`,
    );
  }

  return finish(events, candidates, eventsAllTime);

  function finish(evs: BuyEvent[], cands: TraceResult['candidates'], allTime?: number): TraceResult {
    return {
      follower,
      mints,
      events: evs,
      candidates: cands,
      warnings,
      stats: {
        requests: budget.requests,
        cacheHits: budget.cacheHits,
        freeWindows,
        paidWindows,
        cachedWindows,
        eventsThisRun: evs.length,
        eventsAllTime: allTime ?? evs.length,
        candidatesConsidered: considered,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }
}

/**
 * Every buy the follower made of the tokens in question.
 *
 * One pass over the wallet's own history covers all of them at once — 1,000 trades a page,
 * so a couple of requests regardless of how many tokens were entered.
 */
async function fetchFollowerBuys(
  follower: string,
  wanted: Set<string>,
  budget: RequestBudget,
): Promise<{ list: Array<{ mint: string; symbol: string; time: number; tx: string }>; fromCache: boolean }> {
  // The whole buy list is cached, not just the tokens asked for this time, so tracing the
  // same wallet against a different set of coins tomorrow costs nothing to look up.
  const cached = store.getFollowerBuys(follower);
  if (cached) {
    return { list: cached.filter((b) => wanted.has(b.mint)), fromCache: true };
  }

  const found: Array<{ mint: string; symbol: string; time: number; tx: string }> = [];
  let cursor: string | number | undefined;

  for (let page = 0; page < WALLET_PAGE_LIMIT; page++) {
    const raw = await api.get<{ trades?: WalletTrade[]; nextCursor?: string | number; hasNextPage?: boolean }>(
      `/wallet/${follower}/trades`,
      { cursor, sortDirection: 'DESC' },
      budget,
    );

    const trades = raw?.trades ?? [];
    if (trades.length === 0) break;

    for (const t of trades) {
      // A buy is the side where the wallet *received* the token. Everything it bought is
      // recorded, not just what was asked for, because the cache serves later traces too.
      const to = t.to?.address;
      if (!to || QUOTE_MINTS.has(to)) continue;
      const time = normaliseTime(t.time);
      if (time === null) continue;
      found.push({
        mint: to,
        symbol: t.to?.token?.symbol ?? to.slice(0, 4),
        time,
        tx: t.tx ?? '',
      });
    }

    if (!raw.hasNextPage || raw.nextCursor === undefined || raw.nextCursor === cursor) break;
    cursor = raw.nextCursor;
  }

  store.putFollowerBuys(follower, found);
  return { list: found.filter((b) => wanted.has(b.mint)), fromCache: false };
}

/**
 * The trades immediately before one buy.
 *
 * `cursor` on the token trades endpoint is a plain millisecond timestamp and the default sort
 * is newest-first, so seeking to the buy time and reading forward through the response walks
 * backwards in time from exactly the right instant.
 */
async function scanWindow(
  event: BuyEvent,
  from: number,
  follower: string,
  budget: RequestBudget,
): Promise<{ observations: Observation[]; scannedBuys: number; incomplete: boolean }> {
  const raw: Array<{ wallet: string; leadMs: number }> = [];
  let scannedBuys = 0;
  let cursor: number = event.time;
  let reachedBack = false;

  for (let page = 0; page < WINDOW_PAGE_LIMIT; page++) {
    const res = await api.get<{
      trades?: Array<{ wallet?: string; type?: string; time?: number; tx?: string }>;
      nextCursor?: number;
      hasNextPage?: boolean;
    }>(`/trades/${event.mint}`, { cursor }, budget);

    const trades = res?.trades ?? [];
    if (trades.length === 0) {
      reachedBack = true; // nothing further back exists, so the window is as full as it gets
      break;
    }

    for (const t of trades) {
      const time = normaliseTime(t.time);
      if (time === null || time > event.time || time < from) continue;
      if (t.type !== 'buy') continue;
      scannedBuys += 1;
      // The follower's own buy, and anything sharing its transaction, are not leaders.
      if (t.wallet === follower || (t.tx && t.tx === event.tx)) continue;
      if (!t.wallet) continue;
      raw.push({ wallet: t.wallet, leadMs: event.time - time });
    }

    const oldest = trades.reduce((min, t) => {
      const time = normaliseTime(t.time);
      return time !== null && time < min ? time : min;
    }, Number.POSITIVE_INFINITY);

    if (oldest <= from) {
      reachedBack = true;
      break;
    }
    if (!res.hasNextPage || res.nextCursor === undefined || res.nextCursor === cursor) {
      reachedBack = true;
      break;
    }
    cursor = res.nextCursor;
  }

  return { observations: collapse(raw), scannedBuys, incomplete: !reachedBack };
}

/** One row per wallet: its closest lead, and how many times it bought inside the window. */
function collapse(raw: Array<{ wallet: string; leadMs: number }>): Observation[] {
  const byWallet = new Map<string, { leadMs: number; buys: number }>();
  for (const r of raw) {
    const existing = byWallet.get(r.wallet);
    if (existing) {
      existing.buys += 1;
      existing.leadMs = Math.min(existing.leadMs, r.leadMs);
    } else {
      byWallet.set(r.wallet, { leadMs: r.leadMs, buys: 1 });
    }
  }
  return [...byWallet.entries()].map(([candidate, v]) => ({
    candidate,
    leadMs: v.leadMs,
    buysInWindow: v.buys,
  }));
}

/** The provider mixes seconds and milliseconds depending on endpoint. */
function normaliseTime(t: unknown): number | null {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  return t < 1e12 ? t * 1000 : t;
}

const short = (addr: string) => `${addr.slice(0, 4)}…${addr.slice(-4)}`;
