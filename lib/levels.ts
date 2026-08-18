/**
 * Trade levels: entry, stop, targets.
 *
 * The design rule here is that **this file owns the arithmetic and the model
 * does not**. A language model asked for a stop loss will produce a confident,
 * plausible, round number with nothing behind it, and in a trading readout that
 * is the most expensive kind of wrong. So:
 *
 *   1. `scaffold()` derives levels from realised volatility (ATR) and the
 *      consensus side. These are always computable and always defensible.
 *   2. The model is given the scaffold and may adjust it, because a human
 *      analyst would too.
 *   3. `reconcile()` then checks whatever came back and throws out anything
 *      incoherent, falling back to the scaffold value. A stop on the wrong side
 *      of entry is not a difference of opinion, it is a broken output.
 *
 * Everything is pure, so scripts/check-levels.mjs can pin it.
 */

import type { Candle } from "./hyperliquid";

export type Side = "long" | "short";

export type Plan = {
  side: Side;
  entry: number;
  stop: number;
  targets: number[];
  /** Distance from entry to stop, in price. One R. */
  risk: number;
  /** Reward to risk at the furthest target. */
  rr: number;
};

/** Stop distance in ATR multiples. Wide enough not to be noise, tight enough to matter. */
const STOP_ATR = 1.5;
/** Targets in R multiples off the same risk unit. */
const TARGET_R = [1, 2, 3];
/** A stop closer than this to entry is inside the spread for most of these perps. */
const MIN_STOP_PCT = 0.3;
/** ...and one further than this is not a stop, it is a hope. */
const MAX_STOP_PCT = 25;

/**
 * Average True Range.
 *
 * Wilder's smoothing, not a simple mean: a simple mean of true ranges drops the
 * oldest bar off a cliff and makes the stop jump for no market reason.
 */
export function atr(candles: Candle[], period = 14): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1].c;
    trs.push(Math.max(c.h - c.l, Math.abs(c.h - prev), Math.abs(c.l - prev)));
  }
  if (trs.length === 0) return 0;
  const n = Math.min(period, trs.length);
  let value = trs.slice(0, n).reduce((s, t) => s + t, 0) / n;
  for (let i = n; i < trs.length; i++) value = (value * (n - 1) + trs[i]) / n;
  return value;
}

/** Realised volatility as a share of price, which is what makes coins comparable. */
export function atrPct(candles: Candle[], period = 14): number {
  const last = candles[candles.length - 1]?.c ?? 0;
  return last > 0 ? (atr(candles, period) / last) * 100 : 0;
}

/** Simple close-to-close trend read over the window, in percent. */
export function drift(candles: Candle[], bars = 24): number {
  if (candles.length < 2) return 0;
  const slice = candles.slice(-Math.min(bars, candles.length));
  const first = slice[0].c;
  const last = slice[slice.length - 1].c;
  return first > 0 ? ((last - first) / first) * 100 : 0;
}

const clampPct = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Volatility derived levels for one side at one price.
 *
 * When ATR is unavailable (a freshly listed coin with no history), it falls
 * back to a fixed percentage rather than producing a zero width stop, which
 * would make risk zero and reward infinite.
 */
export function scaffold(side: Side, price: number, atrValue: number): Plan {
  const raw = atrValue > 0 ? atrValue * STOP_ATR : price * 0.03;
  const pct = clampPct((raw / price) * 100, MIN_STOP_PCT, MAX_STOP_PCT);
  const risk = (price * pct) / 100;
  const dir = side === "long" ? 1 : -1;
  return {
    side,
    entry: price,
    stop: price - dir * risk,
    targets: TARGET_R.map((r) => price + dir * risk * r),
    risk,
    rr: TARGET_R[TARGET_R.length - 1],
  };
}

export type Proposed = {
  side?: string;
  entry?: unknown;
  stop?: unknown;
  targets?: unknown;
};

/**
 * Coerce a proposed value to a usable positive number.
 *
 * Models return `"44.35"` as often as `44.35`, and rejecting the string form
 * would throw away a perfectly good level over a quoting habit. What it must
 * NOT do is salvage nonsense: gpt-oss has been observed returning all three
 * targets concatenated into one string, `"44.3544.1143.86"`, which parses to a
 * plausible looking number that is not any of the three. Number() returns NaN
 * for that, so the strict parse below is what keeps it out.
 */
function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === "string") {
    const t = v.trim();
    // Whole-string match only. A partial parse is how the concatenated blob
    // would sneak through as its first few digits.
    if (!/^\d*\.?\d+$/.test(t)) return null;
    const n = Number(t);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/**
 * Take whatever the model proposed and return something a person can act on.
 *
 * Every field is independently validated against the scaffold: a usable entry
 * survives even if the stop was nonsense. Returns the plan plus the list of
 * fields that were rejected, because silently repairing a bad output and
 * presenting it as the model's work would be dishonest about where the numbers
 * came from.
 */
export function reconcile(
  base: Plan,
  proposed: Proposed | null | undefined,
): { plan: Plan; rejected: string[] } {
  const rejected: string[] = [];
  const p = proposed ?? {};
  const side: Side = p.side === "long" || p.side === "short" ? p.side : base.side;
  if (p.side && p.side !== base.side) rejected.push("side");

  // An entry more than 10% away from the live price is not an entry for a trade
  // being read right now, it is a different trade.
  const wantEntry = toNum(p.entry);
  let entry = base.entry;
  if (wantEntry !== null) {
    if (Math.abs(wantEntry - base.entry) / base.entry <= 0.1) entry = wantEntry;
    else rejected.push("entry");
  } else if (p.entry !== undefined) {
    // Present but not a usable number. Report it rather than quietly ignoring
    // it: "the model proposed nothing" and "the model proposed garbage" are
    // different things and the reader deserves to know which happened.
    rejected.push("entry");
  }

  const dir = side === "long" ? 1 : -1;

  const wantStop = toNum(p.stop);
  let stop = side === base.side && entry === base.entry ? base.stop : entry - dir * base.risk;
  if (wantStop !== null) {
    const distPct = ((entry - wantStop) * dir * 100) / entry;
    // Must be on the losing side of entry, and a real distance away.
    if (distPct >= MIN_STOP_PCT && distPct <= MAX_STOP_PCT) stop = wantStop;
    else rejected.push("stop");
  } else if (p.stop !== undefined) {
    rejected.push("stop");
  }

  const risk = Math.abs(entry - stop);
  const fallbackTargets = TARGET_R.map((r) => entry + dir * risk * r);

  let targets = fallbackTargets;
  if (Array.isArray(p.targets) && p.targets.length > 0) {
    const parsedTargets = p.targets.map(toNum);
    // All or nothing. A list where one entry failed to parse is a list whose
    // TP numbering no longer means what the model said it meant.
    const clean = parsedTargets.includes(null)
      ? []
      : (parsedTargets as number[]).slice(0, 4);
    // Every target must be in profit, and they must step away from entry in
    // order. An unordered target list makes "TP1, TP2" meaningless.
    const ordered = clean.every(
      (t, i) => (t - entry) * dir > 0 && (i === 0 || (t - clean[i - 1]) * dir > 0),
    );
    if (clean.length && ordered) targets = clean;
    else rejected.push("targets");
  } else if (p.targets !== undefined && !Array.isArray(p.targets)) {
    rejected.push("targets");
  }

  const rr = risk > 0 ? Math.abs(targets[targets.length - 1] - entry) / risk : 0;
  return { plan: { side, entry, stop, targets, risk, rr }, rejected };
}
