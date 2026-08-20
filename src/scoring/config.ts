/**
 * Every tunable number for wallet scoring lives here. The component functions receive this
 * object and never reach for globals, so this file is the whole tuning surface — change a
 * threshold here and no logic elsewhere needs touching.
 */

const HOUR = 3600;
const DAY = 86400;

export const scoringConfig = {
  /** Score bands for the badge colour. */
  bands: {
    green: 8, // >= green  → green
    amber: 5, // >= amber  → amber, below → red
  },

  /** Hard gates. A wallet failing any of these is excluded outright, never scored. */
  exclusions: {
    /** Median first buy this close to launch means sniper, not conviction. */
    sniperSecs: 60,
    /**
     * Tokens sold beyond what was bought via swaps implies the position came from a
     * transfer or airdrop, which makes realized PnL meaningless — there's no real cost
     * basis. Small tolerance for rounding in the provider's token amounts.
     */
    transferInflationTolerance: 0.02,
    excludeDeployers: true,
  },

  /** Component weights. Rescaled automatically across whichever components are measurable. */
  weights: {
    holdTime: 0.25,
    entryEarliness: 0.15,
    pnlQuality: 0.25,
    breadth: 0.15,
    cadence: 0.1,
    recency: 0.1,
  },

  holdTime: {
    /** Full marks anywhere in this band. */
    idealMinSecs: 2 * DAY,
    idealMaxSecs: 21 * DAY,
    /** Below this is pure scalping and scores zero. */
    scalperFloorSecs: 1 * HOUR,
    /** Above this is bagholding and scores the floor value. */
    bagholderCeilingSecs: 180 * DAY,
    /** Score given to an extreme bagholder, rather than zero — they did still hold. */
    bagholderFloorScore: 0.25,
  },

  entryEarliness: {
    /** Entry at or below this market cap is full marks. */
    idealMcUsd: 50_000,
    /** Entry at or above this scores zero. */
    lateMcUsd: 5_000_000,
  },

  pnlQuality: {
    /** Gross wins ÷ gross losses. At or above this is full marks. */
    fullProfitFactor: 2,
    /** Share of total realized PnL a single position may contribute before it's penalised. */
    concentrationLimit: 0.4,
    /** Concentration at or above this scores zero — a one-trade wonder. */
    concentrationZero: 0.9,
    /** How the two halves combine. */
    profitFactorWeight: 0.6,
    concentrationWeight: 0.4,
  },

  breadth: {
    /** Full marks for this many distinct profitable tokens within the queried set. */
    queriedFullMarks: 5,
    /** Full marks for this many wallet-wide profitable positions, when that data is present. */
    walletWideFullMarks: 25,
  },

  cadence: {
    /** A gap this long counts as a sleep break — evidence of a human. */
    sleepGapSecs: 6 * HOUR,
    /** Sleep gaps per day of activity needed for full marks on that half. */
    idealSleepGapsPerDay: 0.5,
    /**
     * Coefficient of variation of inter-trade gaps. Machines trade at regular intervals
     * (low CV); humans are erratic (high CV).
     */
    humanCvThreshold: 1.0,
    /** Below this many trades the timing pattern says nothing. */
    minTradesForCadence: 12,
  },

  recency: {
    /** Realized activity within this window is full marks. */
    freshDays: 30,
    /** No activity for this long scores zero. */
    staleDays: 180,
  },
} as const;

export type ScoringConfig = typeof scoringConfig;
