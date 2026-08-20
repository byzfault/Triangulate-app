import type { ComponentFn } from '../types.js';
import { clamp01, ramp } from '../util.js';

/**
 * Does the trading pattern look like a person or a program?
 *
 * Two signals, both needing per-trade timestamps and therefore only available after a
 * Tier-2 deep check:
 *
 *  - Sleep gaps. People stop trading for hours at a time. A bot rarely does.
 *  - Irregularity. Machine schedules cluster around an interval, giving a low coefficient
 *    of variation on the gaps between trades; human activity is bursty and erratic.
 */
export const cadence: ComponentFn = (_row, ctx, cfg) => {
  const times = ctx.deep?.tradeTimes;

  if (!times || times.length < cfg.cadence.minTradesForCadence) {
    return {
      raw: 'not measured',
      score: null,
      measured: false,
      note: times
        ? `Only ${times.length} trades available; at least ${cfg.cadence.minTradesForCadence} are needed before timing means anything.`
        : 'Needs per-trade timestamps. Run a deep check on this wallet.',
    };
  }

  const sorted = [...times].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push((sorted[i]! - sorted[i - 1]!) / 1000);

  const spanSecs = (sorted[sorted.length - 1]! - sorted[0]!) / 1000;
  const spanDays = Math.max(spanSecs / 86400, 1 / 24);

  // --- Sleep gaps ---
  const sleepGaps = gaps.filter((g) => g >= cfg.cadence.sleepGapSecs).length;
  const sleepPerDay = sleepGaps / spanDays;
  const sleepScore = clamp01(ramp(sleepPerDay, 0, cfg.cadence.idealSleepGapsPerDay));

  // --- Irregularity ---
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;
  const irregularityScore = clamp01(ramp(cv, 0, cfg.cadence.humanCvThreshold));

  const score = (sleepScore + irregularityScore) / 2;

  return {
    raw: `${sleepPerDay.toFixed(2)} sleep gaps/day, timing variability ${cv.toFixed(2)} over ${gaps.length + 1} trades`,
    score,
    measured: true,
  };
};
