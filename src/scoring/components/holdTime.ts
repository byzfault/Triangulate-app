import type { ComponentFn } from '../types.js';
import { clamp01, formatDuration, logRamp, median } from '../util.js';

/**
 * Median hold per position. Full marks inside the ideal band, tapering toward scalping on
 * one side and bagholding on the other. Both tapers are logarithmic: the gap between one
 * hour and one day says far more about intent than the gap between 100 and 101 days.
 */
export const holdTime: ComponentFn = (row, _ctx, cfg) => {
  const holds = Object.values(row.perToken)
    .map((p) => p.holdTimeSecs)
    .filter((h): h is number => typeof h === 'number' && Number.isFinite(h) && h >= 0);

  const med = median(holds);
  if (med === null) {
    return { raw: 'unknown', score: null, measured: false, note: 'No hold durations reported for these positions.' };
  }

  const c = cfg.holdTime;
  let score: number;

  if (med >= c.idealMinSecs && med <= c.idealMaxSecs) {
    score = 1;
  } else if (med < c.idealMinSecs) {
    // Scalper side: 0 at the floor, 1 by the start of the ideal band.
    score = logRamp(med, c.scalperFloorSecs, c.idealMinSecs);
  } else {
    // Bagholder side: 1 at the top of the band, decaying to the floor score, not to zero —
    // holding too long is a weaker signal than flipping in minutes.
    const decay = logRamp(med, c.idealMaxSecs, c.bagholderCeilingSecs);
    score = 1 - decay * (1 - c.bagholderFloorScore);
  }

  return {
    raw: `median ${formatDuration(med)} across ${holds.length} position${holds.length === 1 ? '' : 's'}`,
    score: clamp01(score),
    measured: true,
  };
};
