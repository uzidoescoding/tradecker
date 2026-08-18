/**
 * Turning a pile of open positions into a consensus.
 *
 * The premise: one profitable trader in a coin is an anecdote. Twelve
 * independently profitable traders on the same side of the same coin is a
 * signal. So a coin only scores when both halves are true, agreement and
 * breadth, and either one alone is deliberately worth very little.
 *
 * Everything here is pure. It takes traders + books + prices and returns
 * numbers, which is what makes scripts/check-consensus.mjs possible.
 */

import { assetClass, sector, type AssetClass, type Sector } from "./categories";
import { assess, type RiskReading } from "./risk";
import type { Book, Position, Trader } from "./hyperliquid";

/** How a trader has to have performed before their opinion counts at all. */
export type Filter = {
  minAllTimePnl: number;
  minAllTimeRoi: number;
  minAccountValue: number;
  cohort: number; // how many of the qualifying traders to actually poll
};

export const FILTERS: Record<string, { label: string; note: string; filter: Filter }> = {
  strict: {
    label: "Proven",
    note: "$1M+ lifetime profit, 100%+ lifetime return, $250k+ on the book today",
    filter: { minAllTimePnl: 1_000_000, minAllTimeRoi: 1.0, minAccountValue: 250_000, cohort: 150 },
  },
  balanced: {
    label: "Balanced",
    note: "$250k+ lifetime profit, 40%+ lifetime return, $100k+ on the book today",
    filter: { minAllTimePnl: 250_000, minAllTimeRoi: 0.4, minAccountValue: 100_000, cohort: 250 },
  },
  wide: {
    label: "Wide",
    note: "$50k+ lifetime profit, 20%+ lifetime return, $25k+ on the book today",
    filter: { minAllTimePnl: 50_000, minAllTimeRoi: 0.2, minAccountValue: 25_000, cohort: 350 },
  },
};

export const DEFAULT_FILTER = "balanced";

/** Breadth needed before a coin can reach its full score. */
const FULL_BREADTH = 8;
/** A group already this far into the move is late to copy. */
const LATE_PNL_PCT = 5;
/** ...and this far in, whatever is left of the move is not worth chasing. */
const STALE_PNL_PCT = 20;
/** Even a stale trade keeps a floor, because agreement is still information. */
const MIN_FRESHNESS = 0.1;
/** Everyone on one side, with enough bodies to mean it. */
const CROWDED_AGREEMENT = 0.9;

export type Ranked = Trader & { weight: number; consistency: number };

/**
 * How much one trader's opinion is worth.
 *
 * Lifetime profit is logged because the gap between $100k and $1M of skill is
 * real, while the gap between $10M and $100M mostly measures starting capital.
 * ROI is capped for the same reason in reverse: a 40x return is nearly always
 * a tiny bankroll that got lucky once. Consistency, meaning how many of the
 * week / month / lifetime windows are green, is what separates a trader who
 * keeps doing it from one who did it once and stopped.
 */
export function weigh(t: Trader): Ranked {
  const green = [t.perf.week, t.perf.month, t.perf.allTime].filter((p) => p.pnl > 0).length;
  const consistency = green / 3;
  const scale = Math.log10(1 + Math.max(0, t.perf.allTime.pnl) / 1_000);
  const skill = Math.min(t.perf.allTime.roi, 3) / 3;
  return { ...t, consistency, weight: scale * (0.4 + 0.6 * consistency) * (1 + skill) };
}

export function qualify(traders: Trader[], f: Filter): Ranked[] {
  return traders
    .filter(
      (t) =>
        t.perf.allTime.pnl >= f.minAllTimePnl &&
        t.perf.allTime.roi >= f.minAllTimeRoi &&
        t.accountValue >= f.minAccountValue,
    )
    .map(weigh)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, f.cohort);
}

/* ---------------------------------------------------------------- consensus */

export type Leg = {
  address: string;
  name: string | null;
  weight: number;
  notional: number;
  entry: number;
  roe: number;
  leverage: number;
  /** Null when the account is cross margined with room to spare. */
  liquidation: number | null;
  /** Position notional as a share of that trader's whole account. */
  commitment: number;
};

export type Consensus = {
  coin: string;
  sector: Sector;
  assetClass: AssetClass;
  side: "long" | "short";
  price: number;
  /** Consensus strength on its own: breadth x conviction, 0..100. */
  score: number;
  /** How much of the move is still ahead of you, 0.1..1. */
  freshness: number;
  /** score x freshness. Answers "is this worth entering now", not "do they agree". */
  entryScore: number;
  agreement: number; // 0.5 = evenly split, 1 = unanimous
  withCount: number;
  againstCount: number;
  withNotional: number;
  againstNotional: number;
  avgEntry: number; // notional weighted, winning side
  avgLeverage: number;
  avgCommitment: number;
  /** Positive means the current price is a better entry than the group got. */
  edgeVsGroup: number;
  /** The winning side's open profit as a share of its notional. */
  groupPnlPct: number;
  flags: string[];
  /** What it costs you if this is wrong, scored separately from how good it looks. */
  risk: RiskReading;
  legs: Leg[];
};

type Sided = {
  weight: number;
  notional: number;
  entryNotional: number;
  pnl: number;
  lev: number;
  commit: number;
  n: number;
  legs: Leg[];
};

const empty = (): Sided => ({
  weight: 0,
  notional: 0,
  entryNotional: 0,
  pnl: 0,
  lev: 0,
  commit: 0,
  n: 0,
  legs: [],
});

export function consensus(
  cohort: Ranked[],
  books: Book[],
  prices: Record<string, number>,
): Consensus[] {
  const byAddress = new Map(cohort.map((t) => [t.address, t]));
  const coins = new Map<string, { long: Sided; short: Sided }>();

  for (const book of books) {
    const trader = byAddress.get(book.address);
    if (!trader) continue;
    for (const p of book.positions) {
      let sides = coins.get(p.coin);
      if (!sides) {
        sides = { long: empty(), short: empty() };
        coins.set(p.coin, sides);
      }
      const bucket = sides[p.side];
      const commitment = book.accountValue > 0 ? p.notional / book.accountValue : 0;
      bucket.n += 1;
      bucket.weight += trader.weight;
      bucket.notional += p.notional;
      bucket.entryNotional += p.entry * p.notional;
      bucket.pnl += p.unrealizedPnl;
      bucket.lev += p.leverage * p.notional;
      bucket.commit += commitment;
      bucket.legs.push({
        address: book.address,
        name: trader.name,
        weight: trader.weight,
        notional: p.notional,
        entry: p.entry,
        roe: p.roe,
        leverage: p.leverage,
        liquidation: p.liquidation,
        commitment,
      });
    }
  }

  const rows: Consensus[] = [];
  for (const [coin, sides] of coins) {
    const total = sides.long.weight + sides.short.weight;
    if (total <= 0) continue;
    const side = sides.long.weight >= sides.short.weight ? "long" : "short";
    const win = sides[side];
    const lose = sides[side === "long" ? "short" : "long"];
    if (win.notional <= 0) continue;

    const agreement = win.weight / total;
    // Both halves are required. Unanimous but thin scores near zero, and so
    // does broad but evenly split. Only broad and one-sided scores high.
    const conviction = (agreement - 0.5) * 2;
    const breadth = Math.min(1, win.n / FULL_BREADTH);
    const score = Math.round(100 * conviction * breadth);

    const price = prices[coin] ?? 0;
    const avgEntry = win.entryNotional / win.notional;
    const edgeVsGroup =
      price > 0 && avgEntry > 0
        ? ((side === "long" ? avgEntry - price : price - avgEntry) / avgEntry) * 100
        : 0;
    const groupPnlPct = (win.pnl / win.notional) * 100;

    // A group that is already 300% up on a short agrees just as hard as one
    // that entered this morning, and the raw consensus score cannot tell them
    // apart. It should not: agreement is agreement. But "should I put money in
    // this" is a different question, so ranking uses agreement discounted by
    // how much of the move has already happened. A group still underwater is
    // treated as fresh, because you would be entering better than they did.
    const freshness = Math.max(
      MIN_FRESHNESS,
      1 - Math.max(0, groupPnlPct) / STALE_PNL_PCT,
    );
    const entryScore = Math.round(score * freshness);

    const flags: string[] = [];
    if (agreement >= CROWDED_AGREEMENT && win.n >= 10) flags.push("Crowded");
    if (groupPnlPct >= LATE_PNL_PCT) flags.push("Late");
    else if (Math.abs(groupPnlPct) < 1) flags.push("Fresh");
    if (edgeVsGroup <= -2) flags.push("Worse entry");
    else if (edgeVsGroup >= 2) flags.push("Better entry");

    const coinSector = sector(coin);
    rows.push({
      coin,
      sector: coinSector,
      assetClass: assetClass(coin),
      side,
      price,
      score,
      freshness,
      entryScore,
      agreement,
      withCount: win.n,
      againstCount: lose.n,
      withNotional: win.notional,
      againstNotional: lose.notional,
      avgEntry,
      avgLeverage: win.lev / win.notional,
      avgCommitment: win.commit / win.n,
      edgeVsGroup,
      groupPnlPct,
      flags,
      risk: assess({
        side,
        price,
        agreement,
        groupPnlPct,
        sector: coinSector,
        legs: win.legs,
      }),
      legs: win.legs.sort((a, b) => b.notional - a.notional),
    });
  }

  return rows.sort((a, b) => b.entryScore - a.entryScore || b.withNotional - a.withNotional);
}

/** Middle value of a list. Median, not mean: one 3000% outlier would own a mean. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * What the cohort as a whole looks like, so the vote has a visible pedigree.
 *
 * Hyperliquid publishes day, week, month and lifetime windows only: there is no
 * yearly bucket, so lifetime is the long run number and the month is the "are
 * they still good right now" number. Both are reported rather than blended,
 * because a cohort that is up 300% lifetime and down 8% this month is a very
 * different thing from one that is up on both.
 */
export function cohortStats(cohort: Ranked[], activeAddresses: Set<string>) {
  const active = cohort.filter((t) => activeAddresses.has(t.address));
  const pool = active.length > 0 ? active : cohort;
  return {
    count: cohort.length,
    active: active.length,
    medianMonthRoi: median(pool.map((t) => t.perf.month.roi)),
    medianAllTimeRoi: median(pool.map((t) => t.perf.allTime.roi)),
    medianMonthPnl: median(pool.map((t) => t.perf.month.pnl)),
    medianAllTimePnl: median(pool.map((t) => t.perf.allTime.pnl)),
    greenThisMonth: pool.filter((t) => t.perf.month.pnl > 0).length,
    totalEquity: pool.reduce((s, t) => s + t.accountValue, 0),
  };
}

/** Flatten every position the cohort holds, for the raw feed. */
export function allLegs(cohort: Ranked[], books: Book[]) {
  const byAddress = new Map(cohort.map((t) => [t.address, t]));
  const out: (Position & { address: string; name: string | null; weight: number })[] = [];
  for (const b of books) {
    const t = byAddress.get(b.address);
    if (!t) continue;
    for (const p of b.positions) out.push({ ...p, address: b.address, name: t.name, weight: t.weight });
  }
  return out.sort((a, b) => b.notional - a.notional);
}
