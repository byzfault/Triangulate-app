import type { ComponentFn } from '../types.js';
import { clamp01, ramp } from '../util.js';

/**
 * Is this wallet still trading? A perfect historical record is not worth copying if the
 * wallet went quiet a year ago.
 *
 * Preference order: the wallet-wide activity window if that filter already ran (free and
 * accurate), otherwise the latest trade seen across the queried tokens, which is a floor —
 * the wallet may well be active elsewhere.
 */
export const recency: ComponentFn = (row, ctx, cfg) => {
  const c = cfg.recency;

  if (row.tradesInWindow !== null && row.tradesInWindow > 0) {
    return {
      raw: `${row.tradesInWindow} trades in the activity window`,
      score: 1,
      measured: true,
    };
  }

  const lastTrades = Object.values(row.perToken)
    .map((p) => p.lastTradeAt)
    .filter((t): t is number => typeof t === 'number' && Number.isFinite(t));

  if (lastTrades.length === 0) {
    return { raw: 'unknown', score: null, measured: false, note: 'No trade timestamps available.' };
  }

  const latest = Math.max(...lastTrades);
  const days = (ctx.now - latest) / 86400_000;
  // Fresh at or under freshDays, decaying to zero by staleDays.
  const score = 1 - ramp(days, c.freshDays, c.staleDays);

  return {
    raw: `last seen ${days < 1 ? 'today' : `${Math.round(days)} days ago`}`,
    score: clamp01(score),
    measured: true,
    note: row.tradesInWindow === null ? 'Based only on the queried tokens; the wallet may be active elsewhere.' : undefined,
  };
};
