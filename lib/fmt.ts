/** Display helpers. Kept in one place so a number never formats two ways. */

export const usd = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
};

/** Prices span BTC at 60,000 and memecoins at 0.000004, so precision follows. */
export const px = (v: number) => {
  if (!Number.isFinite(v) || v === 0) return "—";
  const a = Math.abs(v);
  const d = a >= 1000 ? 2 : a >= 1 ? 3 : a >= 0.01 ? 5 : 7;
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
};

export const pct = (v: number, digits = 1) =>
  `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;

export const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

export const tone = (v: number) => (v >= 0 ? "var(--up)" : "var(--down)");

/**
 * Risk runs the opposite way to every other score on the page: here a big
 * number is bad. Own function so no caller accidentally reuses the green-is-high
 * ramp used for the entry score.
 */
export const riskColor = (score: number) => {
  if (score < 25) return "var(--up)";
  if (score < 45) return "var(--accent)";
  if (score < 65) return "var(--warn)";
  return "var(--down)";
};

export const ago = (ts: number) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};
