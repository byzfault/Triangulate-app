import type { ComponentFn, PriceSeries } from '../types.js';
import { clamp01, formatUsd, logRamp, median } from '../util.js';

/** Price at or just before a timestamp, from an ascending series. Binary search. */
function priceAt(series: PriceSeries, time: number): number | null {
  const pts = series.points;
  if (pts.length === 0) return null;
  if (time < pts[0]!.time) return pts[0]!.price;

  let lo = 0;
  let hi = pts.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (pts[mid]!.time <= time) lo = mid;
    else hi = mid - 1;
  }
  return pts[lo]!.price;
}

/**
 * Median market cap at the moment the wallet first bought each token. Buying at a lower
 * market cap means finding it earlier — the point being conviction ahead of the crowd,
 * which is why the sniper window is excluded separately as a hard gate rather than being
 * rewarded here.
 */
export const entryEarliness: ComponentFn = (row, ctx, cfg) => {
  const caps: number[] = [];
  let missing = 0;

  for (const token of ctx.tokens) {
    const pos = row.perToken[token.mint];
    const series = ctx.prices.get(token.mint);
    if (!pos || !series || series.supply === null) {
      missing += 1;
      continue;
    }

    // hoursAfterLaunch is relative to the derived launch, so recover the absolute instant.
    if (token.launchAt === null || pos.hoursAfterLaunch === null) {
      missing += 1;
      continue;
    }
    const firstBuy = token.launchAt + pos.hoursAfterLaunch * 3600_000;
    const price = priceAt(series, Math.floor(firstBuy / 1000));
    if (price === null || !Number.isFinite(price)) {
      missing += 1;
      continue;
    }
    caps.push(price * series.supply);
  }

  const med = median(caps);
  if (med === null) {
    return {
      raw: 'unknown',
      score: null,
      measured: false,
      note: 'No price history available to value the entries.',
    };
  }

  // Lower market cap is better, so the ramp runs downward.
  const score = 1 - logRamp(med, cfg.entryEarliness.idealMcUsd, cfg.entryEarliness.lateMcUsd);

  return {
    raw: `median entry at ${formatUsd(med)} market cap`,
    score: clamp01(score),
    measured: true,
    note: missing > 0 ? `${missing} of ${ctx.tokens.length} tokens had no usable price data.` : undefined,
  };
};
