/**
 * How dangerous is this trade, separately from how good it looks.
 *
 * The entry score answers "do good traders agree, and is the move still ahead".
 * It says nothing about what happens to you if it goes wrong, and those are not
 * the same question: a unanimous 100 score at 20x leverage with every stop
 * clustered a few percent away is a better idea and a worse trade than a
 * scrappy 40 at 3x.
 *
 * Six factors, all computed from data the board already has, so this costs no
 * extra requests:
 *
 *   leverage       how hard the group is pushing
 *   liquidation    how close the nearest forced exit sits to the current price
 *   concentration  whether the "consensus" is really one big position in a wig
 *   dissent        how much qualifying weight is on the other side
 *   staleness      how much of the move already happened
 *   sector         memecoins are not majors and pretending otherwise is a lie
 *
 * Any factor with no data is dropped and the remaining weights renormalise,
 * rather than scoring zero. Missing liquidation prices are common (a large cross
 * margin account often has none), and treating "unknown" as "safe" is exactly
 * the wrong default in a risk number.
 *
 * Pure, so scripts/check-risk.mjs can pin it.
 */

import type { Sector } from "./categories";

export type RiskBand = "Low" | "Moderate" | "High" | "Severe";

export type RiskDriver = {
  key: string;
  /** 0..1, how bad this particular factor is. */
  level: number;
  /** Plain sentence a person can act on. */
  note: string;
};

export type RiskReading = {
  score: number; // 0..100
  band: RiskBand;
  /** Worst first. Only factors that actually contributed. */
  drivers: RiskDriver[];
};

export type RiskLeg = {
  notional: number;
  leverage: number;
  liquidation: number | null;
};

export type RiskInput = {
  side: "long" | "short";
  price: number;
  /** Winning side's share of total weight, 0.5 to 1. */
  agreement: number;
  /** The winning side's open profit as a share of its notional. */
  groupPnlPct: number;
  sector: Sector;
  legs: RiskLeg[];
};

/**
 * Baseline danger by what the thing is.
 *
 * Not a claim about any given day, just the observation that a memecoin and a
 * major do not deserve the same starting assumption.
 */
const SECTOR_RISK: Record<Sector, number> = {
  Major: 0.15,
  RWA: 0.2,
  "L1/L2": 0.35,
  DeFi: 0.4,
  Infra: 0.4,
  Privacy: 0.4,
  Exchange: 0.45,
  AI: 0.55,
  "Gaming/NFT": 0.55,
  Other: 0.6,
  Meme: 0.85,
};

const WEIGHTS = {
  leverage: 0.25,
  liquidation: 0.2,
  concentration: 0.2,
  dissent: 0.15,
  staleness: 0.1,
  sector: 0.1,
};

/** Leverage at or above this is treated as maximum danger on that axis. */
const LEV_CEILING = 25;
/** A forced exit further than this from price stops counting as pressure. */
const LIQ_SAFE_PCT = 50;
/** A move this far along has spent most of what a copier could still capture. */
const STALE_PCT = 20;

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

export function band(score: number): RiskBand {
  if (score < 25) return "Low";
  if (score < 45) return "Moderate";
  if (score < 65) return "High";
  return "Severe";
}

export function assess(input: RiskInput): RiskReading {
  const { legs, price, agreement, groupPnlPct, sector } = input;
  const total = legs.reduce((s, l) => s + l.notional, 0);

  const factors: { key: keyof typeof WEIGHTS; level: number; note: string }[] = [];

  /* ------------------------------------------------------------- leverage */
  if (total > 0) {
    const avgLev = legs.reduce((s, l) => s + l.leverage * l.notional, 0) / total;
    const level = clamp01((avgLev - 1) / (LEV_CEILING - 1));
    factors.push({
      key: "leverage",
      level,
      note: `Group is at ${avgLev.toFixed(1)}x on average, so a ${(100 / avgLev).toFixed(1)}% move against them wipes the margin.`,
    });
  }

  /* ---------------------------------------------------------- liquidation */
  // Only legs that actually report a liquidation price. A cross margin account
  // with plenty of collateral reports none, and counting that as "safe" would
  // quietly drag the whole score down.
  const liqs = legs
    .map((l) => l.liquidation)
    .filter((v): v is number => v != null && Number.isFinite(v) && v > 0);
  if (liqs.length > 0 && price > 0) {
    const nearestPct = Math.min(...liqs.map((l) => (Math.abs(l - price) / price) * 100));
    const level = clamp01(1 - nearestPct / LIQ_SAFE_PCT);
    factors.push({
      key: "liquidation",
      level,
      note: `Nearest forced exit in the group sits ${nearestPct.toFixed(1)}% from here${
        nearestPct < 10 ? ", close enough that it can cascade into the rest" : ""
      }.`,
    });
  }

  /* --------------------------------------------------------- concentration */
  if (total > 0 && legs.length > 0) {
    const top = Math.max(...legs.map((l) => l.notional));
    const topShare = top / total;
    const even = 1 / legs.length;
    // 0 when everyone carries the same size, 1 when one account is the position.
    const level = legs.length === 1 ? 1 : clamp01((topShare - even) / (1 - even));
    factors.push({
      key: "concentration",
      level,
      note:
        legs.length === 1
          ? "One account is the entire position."
          : `Largest account carries ${Math.round(topShare * 100)}% of the notional${
              level > 0.6 ? ", so this leans on one person rather than the group" : ""
            }.`,
    });
  }

  /* -------------------------------------------------------------- dissent */
  {
    const level = clamp01((1 - agreement) * 2);
    factors.push({
      key: "dissent",
      level,
      note:
        level < 0.05
          ? "No qualifying trader is on the other side."
          : `${Math.round((1 - agreement) * 100)}% of qualifying weight is positioned the other way.`,
    });
  }

  /* ------------------------------------------------------------ staleness */
  {
    const level = clamp01(Math.max(0, groupPnlPct) / STALE_PCT);
    factors.push({
      key: "staleness",
      level,
      note:
        groupPnlPct <= 0
          ? "Group is not yet in profit, so you would be entering around where they did."
          : `Group is already ${groupPnlPct.toFixed(1)}% up on notional, so part of the move is spent.`,
    });
  }

  /* --------------------------------------------------------------- sector */
  {
    const level = SECTOR_RISK[sector] ?? SECTOR_RISK.Other;
    factors.push({
      key: "sector",
      level,
      note: `${sector} instruments carry a ${level >= 0.6 ? "high" : level >= 0.35 ? "middling" : "low"} baseline of their own.`,
    });
  }

  // Renormalise over the factors that had data, so a missing liquidation price
  // does not silently make everything look safer.
  const weightSum = factors.reduce((s, f) => s + WEIGHTS[f.key], 0);
  const score =
    weightSum > 0
      ? Math.round((factors.reduce((s, f) => s + f.level * WEIGHTS[f.key], 0) / weightSum) * 100)
      : 0;

  return {
    score,
    band: band(score),
    drivers: factors
      .map((f) => ({ key: f.key, level: f.level, note: f.note }))
      .sort((a, b) => b.level * WEIGHTS[b.key as keyof typeof WEIGHTS] - a.level * WEIGHTS[a.key as keyof typeof WEIGHTS]),
  };
}
