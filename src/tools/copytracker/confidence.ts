import type { Candidate, ComponentScore } from './types.js';
import type { ObservationRow } from './store.js';

/**
 * Every tunable number for copy-trade confidence. As with Triangulate's scoring config, this
 * file is the entire tuning surface — the maths below reads thresholds from here and nothing
 * reaches for a constant of its own.
 */
export const confidenceConfig = {
  bands: {
    strong: 7, // >= strong   → green
    possible: 4, // >= possible → amber, below → red
  },

  /** A wallet seen leading fewer times than this is a coincidence, not a candidate. */
  minHits: 2,
  /** Leading on one token proves nothing; the pattern has to repeat across coins. */
  minTokens: 2,

  /**
   * Timing regularity carries the most weight, and deliberately so. Lead frequency and token
   * coverage both saturate for any wallet that trades constantly, so on their own they rank
   * the busiest bot top. What a copier cannot fake is a *repeatable* delay: the same few
   * seconds behind, every time. A CV near zero across several tokens is a machine following
   * a machine, and nothing else in this data looks like it.
   */
  weights: {
    hitRate: 0.2,
    tokenCoverage: 0.2,
    lift: 0.15,
    latencyConsistency: 0.35,
    latencyPlausibility: 0.1,
  },

  /**
   * Base-rate gate, applied to the finished score rather than mixed into it.
   *
   * A weighted average cannot express "this evidence is void": a wallet in 45% of all windows
   * maxes both frequency components, and one weak component cannot drag that back. So lift
   * also multiplies the total — at or below chance the score collapses to a fifth of itself,
   * however impressive the raw hit count looked.
   */
  baseRateGate: {
    /** Below this lift the wallet is doing no better than its own trading frequency. */
    floor: 0.8,
    /** At or above this, activity no longer explains the leads and the gate is fully open. */
    open: 1.3,
    /** What remains of the score when the gate is fully shut. */
    minFactor: 0.2,
  },

  tokenCoverage: {
    /** Leading on this many distinct tokens is as convincing as it needs to be. */
    fullMarks: 4,
  },

  lift: {
    /** At or below this, the wallet leads no more often than its raw activity predicts. */
    none: 1,
    /** Leading this many times more often than chance is full marks. */
    full: 5,
  },

  latency: {
    /**
     * Under this, the "lead" is probably not a lead at all — same block, or the two trades
     * were bundled together. Scored low rather than zero, since a very fast copier is real.
     */
    suspiciouslyFastMs: 1_000,
    suspiciouslyFastScore: 0.35,
    /** The band an automated copier actually operates in. */
    idealMinMs: 1_000,
    idealMaxMs: 90_000,
    /** Beyond this the two buys are unrelated decisions that happened to be near each other. */
    unrelatedMs: 600_000,
    unrelatedScore: 0.1,
    /** Coefficient of variation at or below this is machine-like regularity. */
    tightCv: 0.35,
    /** At or above this the timing is scattered enough to be two independent traders. */
    looseCv: 1.5,
    /** Below this many observations, timing spread says nothing. */
    minForCv: 3,
  },
} as const;

/** How many below-the-bar wallets to show, so the shortlist stays short. */
const NEAR_MISS_LIMIT = 12;

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Linear interpolation between two points, clamped at both ends. */
function ramp(value: number, zeroAt: number, oneAt: number): number {
  if (oneAt === zeroAt) return value >= oneAt ? 1 : 0;
  return clamp01((value - zeroAt) / (oneAt - zeroAt));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

function formatLead(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}min`;
}

/**
 * Turns the observation log for one follower into ranked candidates.
 *
 * The hard problem here is the base rate. On an active token, a handful of wallets buy
 * constantly — snipers, market makers, MEV bots. They appear in the seconds before *every*
 * buy by anyone, which makes a naive "how often did they go first" count rank them top and
 * bury the actual source. The `lift` component exists to cancel that: it compares the hits a
 * wallet actually scored against the hits its own trading frequency would produce by chance,
 * so a wallet that buys in 40% of all windows has to lead far more often than that to score.
 */
export function rankCandidates(
  observations: ObservationRow[],
  events: Array<{ id: number; mint: string; symbol: string | null; buy_ts: number; scanned_buys: number }>,
  opts: { minHits?: number; minTokens?: number } = {},
): { candidates: Candidate[]; considered: number } {
  const cfg = confidenceConfig;
  const minHits = opts.minHits ?? cfg.minHits;
  const minTokens = opts.minTokens ?? cfg.minTokens;

  const totalEvents = events.length;
  if (totalEvents === 0) return { candidates: [], considered: 0 };

  const totalScannedBuys = events.reduce((a, e) => a + e.scanned_buys, 0);
  const avgWindowBuys = totalScannedBuys / totalEvents;

  const grouped = new Map<string, ObservationRow[]>();
  for (const o of observations) {
    const list = grouped.get(o.candidate);
    if (list) list.push(o);
    else grouped.set(o.candidate, [o]);
  }

  const candidates: Candidate[] = [];

  for (const [wallet, rows] of grouped) {
    const hits = new Set(rows.map((r) => r.event_id)).size;
    const tokenMap = new Map<string, { symbol: string; leadMs: number }>();
    for (const r of rows) {
      const existing = tokenMap.get(r.mint);
      if (!existing || r.lead_ms < existing.leadMs) {
        tokenMap.set(r.mint, { symbol: r.symbol ?? r.mint.slice(0, 4), leadMs: r.lead_ms });
      }
    }
    const tokens = tokenMap.size;

    // Candidates below the bar are kept and flagged rather than dropped. Showing nothing at
    // all reads as "the tool found nothing", when what actually happened is that plenty of
    // wallets bought just before — none of them twice. That distinction is the whole result,
    // so the near-misses are shown greyed out beneath the ones that qualify.
    const meetsBar = hits >= minHits && tokens >= minTokens;

    const leads = rows.map((r) => r.lead_ms);
    const med = median(leads);
    const mean = leads.reduce((a, b) => a + b, 0) / leads.length;
    const sd =
      leads.length > 1
        ? Math.sqrt(leads.reduce((a, b) => a + (b - mean) ** 2, 0) / (leads.length - 1))
        : 0;
    const cv = leads.length >= cfg.latency.minForCv && mean > 0 ? sd / mean : null;

    // Base rate: how much of all the buying in these windows was this wallet, and therefore
    // how many windows it would have turned up in purely by being busy.
    const candidateBuys = rows.reduce((a, r) => a + r.buys_in_window, 0);
    const activityShare = totalScannedBuys > 0 ? candidateBuys / totalScannedBuys : 0;
    const chancePerWindow = 1 - Math.pow(1 - Math.min(activityShare, 0.999), Math.max(avgWindowBuys, 1));
    const expected = totalEvents * chancePerWindow;
    const lift = expected > 0.0001 ? hits / expected : null;

    const components: ComponentScore[] = [
      {
        key: 'hitRate',
        label: 'Lead frequency',
        weight: cfg.weights.hitRate,
        raw: `${hits} of ${totalEvents} buys`,
        score: hits / totalEvents,
        measured: true,
      },
      {
        key: 'tokenCoverage',
        label: 'Repeats across tokens',
        weight: cfg.weights.tokenCoverage,
        raw: `${tokens} token${tokens === 1 ? '' : 's'}`,
        score: ramp(tokens, 1, cfg.tokenCoverage.fullMarks),
        measured: true,
      },
      {
        key: 'lift',
        label: 'Beats chance by',
        weight: cfg.weights.lift,
        raw: lift === null ? 'not measurable' : `${lift.toFixed(1)}×`,
        score: lift === null ? null : ramp(lift, cfg.lift.none, cfg.lift.full),
        measured: lift !== null,
        note:
          lift !== null && lift <= cfg.lift.none
            ? 'Leads no more often than its own trading frequency would produce by chance.'
            : undefined,
      },
      {
        key: 'latencyConsistency',
        label: 'Timing regularity',
        weight: cfg.weights.latencyConsistency,
        raw: cv === null ? `only ${leads.length} observation${leads.length === 1 ? '' : 's'}` : `CV ${cv.toFixed(2)}`,
        score: cv === null ? null : 1 - ramp(cv, cfg.latency.tightCv, cfg.latency.looseCv),
        measured: cv !== null,
        note: cv === null ? `Needs ${cfg.latency.minForCv} observations to measure spread.` : undefined,
      },
      {
        key: 'latencyPlausibility',
        label: 'Lead time',
        weight: cfg.weights.latencyPlausibility,
        raw: formatLead(med),
        score: plausibility(med, cfg),
        measured: true,
        note:
          med < cfg.latency.suspiciouslyFastMs
            ? 'Under a second — may be the same block or a bundled trade rather than a copy.'
            : undefined,
      },
    ];

    // Unmeasurable components are dropped and their weight redistributed, rather than being
    // scored as a neutral half — the same rule Triangulate uses, for the same reason: a
    // guessed component drags every candidate toward the middle and hides the real ones.
    const measured = components.filter((c) => c.measured && c.score !== null);
    const measuredWeight = measured.reduce((a, c) => a + c.weight, 0);
    const weighted =
      measuredWeight > 0
        ? (measured.reduce((a, c) => a + c.weight * (c.score ?? 0), 0) / measuredWeight) * 10
        : 0;

    // The gate: chance-level lift voids the evidence rather than merely discounting it.
    const gate =
      lift === null
        ? 1
        : cfg.baseRateGate.minFactor +
          (1 - cfg.baseRateGate.minFactor) * ramp(lift, cfg.baseRateGate.floor, cfg.baseRateGate.open);
    const score10 = weighted * gate;

    candidates.push({
      wallet,
      score: Math.round(score10 * 10) / 10,
      band: score10 >= cfg.bands.strong ? 'strong' : score10 >= cfg.bands.possible ? 'possible' : 'weak',
      hits,
      events: totalEvents,
      tokens,
      medianLeadMs: med,
      minLeadMs: Math.min(...leads),
      leadCv: cv,
      lift,
      activityShare,
      components,
      coverage: Math.round(measuredWeight * 100),
      gate: Math.round(gate * 100) / 100,
      meetsBar,
      perToken: [...tokenMap.entries()].map(([mint, v]) => ({ mint, symbol: v.symbol, leadMs: v.leadMs })),
      firstSeen: Math.min(...rows.map((r) => r.buy_ts)),
      lastSeen: Math.max(...rows.map((r) => r.buy_ts)),
    });
  }

  // Qualifying candidates first, then the near-misses by strength of what evidence exists.
  candidates.sort(
    (a, b) =>
      Number(b.meetsBar) - Number(a.meetsBar) ||
      b.score - a.score ||
      b.hits - a.hits ||
      a.medianLeadMs - b.medianLeadMs,
  );

  // A trace on a busy token can put hundreds of wallets in the windows. Everything that met
  // the bar is kept; below it, only enough to show what was considered.
  const qualifying = candidates.filter((c) => c.meetsBar);
  const nearMisses = candidates.filter((c) => !c.meetsBar).slice(0, NEAR_MISS_LIMIT);

  return { candidates: [...qualifying, ...nearMisses], considered: grouped.size };
}

function plausibility(medianMs: number, cfg: typeof confidenceConfig): number {
  const l = cfg.latency;
  if (medianMs < l.suspiciouslyFastMs) return l.suspiciouslyFastScore;
  if (medianMs <= l.idealMaxMs) return 1;
  if (medianMs >= l.unrelatedMs) return l.unrelatedScore;
  // Between the ideal ceiling and the unrelated floor, taper linearly.
  return l.unrelatedScore + (1 - l.unrelatedScore) * (1 - ramp(medianMs, l.idealMaxMs, l.unrelatedMs));
}
