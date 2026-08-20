/** Shared numeric helpers for the scoring components. */

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Linear interpolation from 0 at `lo` to 1 at `hi`, clamped. Handles hi < lo (inverted). */
export function ramp(value: number, lo: number, hi: number): number {
  if (hi === lo) return value >= hi ? 1 : 0;
  return clamp01((value - lo) / (hi - lo));
}

/**
 * Same as ramp but in log space, for quantities that span orders of magnitude — market caps
 * and hold times, where the difference between 1h and 1d matters far more than between
 * 100d and 101d.
 */
export function logRamp(value: number, lo: number, hi: number): number {
  const v = Math.max(value, 1e-9);
  const l = Math.max(lo, 1e-9);
  const h = Math.max(hi, 1e-9);
  return ramp(Math.log(v), Math.log(l), Math.log(h));
}

export function formatDuration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return 'unknown';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${(secs / 3600).toFixed(1)}h`;
  return `${(secs / 86400).toFixed(1)}d`;
}

export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unknown';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}k`;
  return `${sign}$${abs.toFixed(0)}`;
}
