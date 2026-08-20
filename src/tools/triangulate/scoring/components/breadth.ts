import type { ComponentFn } from '../types.js';
import { clamp01, ramp } from '../util.js';

/**
 * How many distinct tokens the wallet has actually made money on.
 *
 * Within the queried set this carries almost no information: the set is at most five, and
 * "require profit on all tokens" pins it to exactly the number queried. It only becomes a
 * real signal with wallet-wide data — which is free when the track-record filter has already
 * run, and exact after a Tier-2 deep check.
 */
export const breadth: ComponentFn = (row, ctx, cfg) => {
  // Best source: an actual deep check.
  if (ctx.deep?.profitableTokens != null) {
    const n = ctx.deep.profitableTokens;
    return {
      raw: `${n} profitable tokens wallet-wide`,
      score: clamp01(ramp(n, 1, cfg.breadth.walletWideFullMarks)),
      measured: true,
    };
  }

  // Next best, and free: the track-record call already told us how many closed positions
  // were winners across everything the wallet trades.
  if (row.winRate !== null && row.closedPositions !== null && row.closedPositions > 0) {
    const winners = Math.round((row.winRate / 100) * row.closedPositions);
    return {
      raw: `${winners} profitable of ${row.closedPositions} closed positions wallet-wide`,
      score: clamp01(ramp(winners, 1, cfg.breadth.walletWideFullMarks)),
      measured: true,
    };
  }

  // Fall back to the queried set, which is only meaningful if losses were allowed through.
  if (ctx.requireProfitOnAll) {
    return {
      raw: `${row.profitableTokens} of ${ctx.tokens.length} queried tokens`,
      score: null,
      measured: false,
      note: 'Every wallet here is profitable on all queried tokens by definition, so this says nothing. Enable the track-record check, or run a deep check, for wallet-wide breadth.',
    };
  }

  return {
    raw: `${row.profitableTokens} of ${ctx.tokens.length} queried tokens`,
    score: clamp01(ramp(row.profitableTokens, 1, cfg.breadth.queriedFullMarks)),
    measured: true,
    note: 'Limited to the queried tokens. A deep check gives wallet-wide breadth.',
  };
};
