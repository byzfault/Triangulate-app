import type { ResultRow, TokenMeta } from '../types.js';

/** A price series for one token, used to value a wallet's entry. */
export interface PriceSeries {
  /** Ascending by time. */
  points: Array<{ time: number; price: number }>;
  supply: number | null;
}

export interface ScoringContext {
  tokens: TokenMeta[];
  /** Keyed by mint. Absent when the OHLCV fetch failed or was skipped. */
  prices: Map<string, PriceSeries>;
  /** True when the wallet-level filters ran, so their data is already in hand for free. */
  hasWalletData: boolean;
  /** Whether "require profit on all tokens" was on — it makes profit factor degenerate. */
  requireProfitOnAll: boolean;
  now: number;
  /** Present only after a Tier-2 deep check. */
  deep?: DeepCheckData;
}

/** Per-trade history for one wallet, fetched on demand. */
export interface DeepCheckData {
  wallet: string;
  tradeTimes: number[];
  /** Distinct tokens the wallet has traded, wallet-wide. */
  tokensTraded: number;
  profitableTokens: number | null;
  fetchedAt: number;
}

export interface ComponentScore {
  key: string;
  label: string;
  /** Configured weight before renormalisation. */
  weight: number;
  /** Weight actually applied, after unmeasured components are dropped. */
  effectiveWeight: number;
  /** Human-readable value behind the score. */
  raw: string;
  /** 0–1, or null when not measurable. */
  score: number | null;
  measured: boolean;
  /** Why it couldn't be measured, or a caveat about how it was. */
  note?: string;
}

export interface ScoreBreakdown {
  /** 1–10, or null when the wallet is excluded. */
  score: number | null;
  band: 'green' | 'amber' | 'red' | 'excluded';
  tier: 1 | 2;
  /** Set when a hard gate rejected the wallet. */
  excluded: string | null;
  components: ComponentScore[];
  /** Share of the configured weight that was actually measurable. */
  coverage: number;
}

export type ComponentResult = {
  raw: string;
  score: number | null;
  measured: boolean;
  note?: string;
};

export type ComponentFn = (
  row: ResultRow,
  ctx: ScoringContext,
  cfg: import('./config.js').ScoringConfig,
) => ComponentResult;
