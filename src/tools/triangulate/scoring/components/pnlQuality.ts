import type { ComponentFn } from '../types.js';
import { clamp01, ramp } from '../util.js';

/**
 * Two questions in one: does the wallet win more than it loses (profit factor), and is the
 * profit spread across positions rather than resting on a single lucky one?
 *
 * Profit factor degenerates when "require realized profit on all tokens" is on, because
 * every surviving wallet then has zero gross losses by construction. In that case the
 * profit-factor half is reported as unmeasured and the concentration half carries the
 * component on its own.
 */
export const pnlQuality: ComponentFn = (row, ctx, cfg) => {
  const realized = Object.values(row.perToken).map((p) => p.realized);
  if (realized.length === 0) {
    return { raw: 'no positions', score: null, measured: false };
  }

  const grossWins = realized.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const grossLosses = Math.abs(realized.filter((r) => r < 0).reduce((a, b) => a + b, 0));

  const c = cfg.pnlQuality;

  // --- Concentration: is one position carrying everything? ---
  const totalRealized = realized.reduce((a, b) => a + b, 0);
  let concentrationScore: number | null = null;
  let concentrationRaw = 'n/a';

  if (totalRealized > 0) {
    const largest = Math.max(...realized);
    const share = largest / totalRealized;
    concentrationRaw = `largest position is ${(share * 100).toFixed(0)}% of realized`;
    // Full marks at or below the limit, zero by the time one position is nearly everything.
    concentrationScore = 1 - ramp(share, c.concentrationLimit, c.concentrationZero);
  }

  // --- Profit factor ---
  let pfScore: number | null = null;
  let pfRaw: string;
  let note: string | undefined;

  if (grossLosses === 0) {
    pfRaw = 'no losing positions in the queried set';
    note = ctx.requireProfitOnAll
      ? 'Profit factor can’t discriminate while “require profit on all tokens” is on — every surviving wallet has zero losses. Turn that filter off to make this meaningful.'
      : 'No losing positions among the queried tokens, so there is nothing to divide by.';
  } else {
    const pf = grossWins / grossLosses;
    pfRaw = `profit factor ${pf.toFixed(2)}`;
    pfScore = clamp01(ramp(pf, 1, c.fullProfitFactor));
  }

  // Combine whichever halves are available, reweighting if only one is.
  const parts: Array<{ score: number; weight: number }> = [];
  if (pfScore !== null) parts.push({ score: pfScore, weight: c.profitFactorWeight });
  if (concentrationScore !== null) parts.push({ score: concentrationScore, weight: c.concentrationWeight });

  if (parts.length === 0) {
    return { raw: `${pfRaw}; ${concentrationRaw}`, score: null, measured: false, note };
  }

  const totalWeight = parts.reduce((a, p) => a + p.weight, 0);
  const score = parts.reduce((a, p) => a + p.score * p.weight, 0) / totalWeight;

  return {
    raw: `${pfRaw}; ${concentrationRaw}`,
    score: clamp01(score),
    measured: true,
    note,
  };
};
