/** One buy by the followed wallet, and the reference point for a window of suspects. */
export interface BuyEvent {
  mint: string;
  symbol: string;
  /** Unix ms. */
  time: number;
  tx: string;
  /** Where the window came from: the free log, metered history, or an earlier run. */
  source: 'free' | 'solanatracker' | 'cached';
  /** Total buys seen in the window, the denominator for the base-rate correction. */
  scannedBuys: number;
  /** True when the window couldn't be filled — the page didn't reach far enough back. */
  windowIncomplete: boolean;
}

/** A wallet that bought shortly before the followed wallet, on one event. */
export interface Observation {
  candidate: string;
  /** Milliseconds between the candidate's closest buy and the follower's. Always >= 0. */
  leadMs: number;
  /** How many times the candidate bought inside this window — a base-rate input. */
  buysInWindow: number;
}

export interface ComponentScore {
  key: string;
  label: string;
  weight: number;
  /** Human-readable raw value, e.g. "4 of 5 buys". */
  raw: string;
  /** 0–1 before weighting. Null when the component couldn't be measured. */
  score: number | null;
  measured: boolean;
  note?: string;
}

export interface Candidate {
  wallet: string;
  /** 0–10. */
  score: number;
  band: 'strong' | 'possible' | 'weak';
  /** Events where this wallet bought inside the window. */
  hits: number;
  /** Events analysed in total for this follower, all runs combined. */
  events: number;
  /** Distinct tokens on which it led. */
  tokens: number;
  medianLeadMs: number;
  minLeadMs: number;
  /** Coefficient of variation of lead times. Low means machine-like regularity. */
  leadCv: number | null;
  /** Observed hits divided by hits expected from this wallet's raw activity level. */
  lift: number | null;
  /** Share of all buys in the scanned windows that came from this wallet. */
  activityShare: number;
  components: ComponentScore[];
  /** Percentage of the scoring weight that could actually be measured. */
  coverage: number;
  /** Base-rate multiplier applied to the score. 1 = no discount, 0.2 = fully discounted. */
  gate: number;
  /** Whether it cleared the minimum leads and token-repeat thresholds. */
  meetsBar: boolean;
  perToken: Array<{ mint: string; symbol: string; leadMs: number }>;
  firstSeen: number;
  lastSeen: number;
}

export interface TraceResult {
  follower: string;
  mints: string[];
  events: BuyEvent[];
  candidates: Candidate[];
  warnings: Array<{ kind: 'notice' | 'partial' | 'capped'; message: string }>;
  stats: {
    requests: number;
    cacheHits: number;
    freeWindows: number;
    paidWindows: number;
    cachedWindows: number;
    eventsThisRun: number;
    eventsAllTime: number;
    candidatesConsidered: number;
    elapsedMs: number;
  };
}

export type TraceProgress =
  | { type: 'phase'; phase: string; detail: string }
  | { type: 'requests'; count: number }
  | { type: 'warning'; warning: TraceResult['warnings'][number] }
  | { type: 'done'; result: TraceResult }
  | { type: 'error'; message: string };
