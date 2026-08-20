import type { ResultRow } from '../types.js';
import { scoringConfig, type ScoringConfig } from './config.js';
import { checkExclusions } from './exclusions.js';
import type { ComponentFn, ComponentScore, ScoreBreakdown, ScoringContext } from './types.js';
import { breadth } from './components/breadth.js';
import { cadence } from './components/cadence.js';
import { entryEarliness } from './components/entryEarliness.js';
import { holdTime } from './components/holdTime.js';
import { pnlQuality } from './components/pnlQuality.js';
import { recency } from './components/recency.js';

const COMPONENTS: Array<{ key: keyof ScoringConfig['weights']; label: string; fn: ComponentFn }> = [
  { key: 'holdTime', label: 'Hold-time match', fn: holdTime },
  { key: 'entryEarliness', label: 'Entry earliness', fn: entryEarliness },
  { key: 'pnlQuality', label: 'PnL quality', fn: pnlQuality },
  { key: 'breadth', label: 'Breadth', fn: breadth },
  { key: 'cadence', label: 'Human cadence', fn: cadence },
  { key: 'recency', label: 'Recency', fn: recency },
];

export function scoreWallet(
  row: ResultRow,
  ctx: ScoringContext,
  cfg: ScoringConfig = scoringConfig,
): ScoreBreakdown {
  const tier: 1 | 2 = ctx.deep ? 2 : 1;

  const excluded = checkExclusions(row, ctx, cfg);
  if (excluded) {
    return { score: null, band: 'excluded', tier, excluded, components: [], coverage: 0 };
  }

  const results = COMPONENTS.map(({ key, label, fn }) => {
    const weight = cfg.weights[key];
    const out = fn(row, ctx, cfg);
    return { key, label, weight, ...out };
  });

  // Only measured components carry weight. Rather than scoring an unmeasurable component
  // as a neutral 0.5 — which would quietly drag every wallet toward the middle — its weight
  // is redistributed across the components that could actually be evaluated.
  const measuredWeight = results.filter((r) => r.measured && r.score !== null).reduce((a, r) => a + r.weight, 0);

  const components: ComponentScore[] = results.map((r) => ({
    key: r.key,
    label: r.label,
    weight: r.weight,
    effectiveWeight: r.measured && r.score !== null && measuredWeight > 0 ? r.weight / measuredWeight : 0,
    raw: r.raw,
    score: r.score,
    measured: r.measured && r.score !== null,
    note: r.note,
  }));

  if (measuredWeight === 0) {
    return { score: null, band: 'red', tier, excluded: null, components, coverage: 0 };
  }

  const weighted = components.reduce((a, c) => a + (c.score ?? 0) * c.effectiveWeight, 0);
  // Map 0–1 onto 1–10, so the worst measurable wallet scores 1 rather than 0.
  const score = Math.round((1 + weighted * 9) * 10) / 10;

  const band: ScoreBreakdown['band'] =
    score >= cfg.bands.green ? 'green' : score >= cfg.bands.amber ? 'amber' : 'red';

  return { score, band, tier, excluded: null, components, coverage: measuredWeight };
}

export { scoringConfig } from './config.js';
export type { ScoreBreakdown, ScoringContext, PriceSeries, DeepCheckData } from './types.js';
