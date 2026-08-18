import { NextRequest, NextResponse } from "next/server";
import { assetClass, sector } from "@/lib/categories";
import { chat, parseJson } from "@/lib/groq";
import {
  atr,
  atrPct,
  drift,
  impliedLeverage,
  nearestLevels,
  rangePosition,
  reconcile,
  scaffold,
  type Plan,
  type Proposed,
} from "@/lib/levels";
import { assetContexts, candles } from "@/lib/hyperliquid";
import { cleanProse } from "@/lib/text";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM = `You are a trading desk analyst writing the note that goes out before the open.

You are given a consensus reading built from the live open positions of accounts that are
profitable over the long run, the current price, realised volatility, market structure levels,
funding, open interest, and a volatility derived scaffold of trade levels.

Rules:
- Work ONLY from the numbers supplied. You have no knowledge of news, macro, fundamentals, token
  unlocks or anything outside this payload. Never invent any of it.
- The scaffold levels are anchored to real volatility. Adjust them only when the supplied numbers
  give you a concrete reason, and say what the reason was. Keeping the scaffold is a fine answer.
- Reference the actual structure you were given. If support sits 2% below and your stop is 3%
  below, say that the stop sits under support. That is the kind of detail this note exists for.
- Funding matters: say whether this side collects it or pays it, and whether the rate is enough to
  care about over the horizon you are proposing.
- Your bias should normally match the consensus side. If you disagree, say so and name the number
  that changed your mind.
- A risk reading is supplied. Let it shape the tone, and if it is High or Severe, say what
  specifically makes it so.
- Never tell the reader what they must do with their money.
- Every field is dense and specific. No filler, no restating the label, no hedging phrases like
  "it depends" or "traders should monitor". If you have nothing to say in a field, be concrete
  about why rather than padding it.
- Never use em-dashes or double hyphens; use commas or colons instead.

Reply with JSON only, using exactly these keys, all flat, no nested objects and no arrays:
{
  "headline": "one line, under 90 characters, the whole thesis",
  "bias": "long" | "short",
  "conviction": "low" | "medium" | "high",
  "horizon": "hours" | "days" | "weeks",
  "entry": number,
  "stop": number,
  "tp1": number,
  "tp2": number,
  "tp3": number,
  "read": "4 to 6 sentences, the full picture",
  "why": "1 to 2 sentences on why these levels sit where they do",
  "structure": "1 to 2 sentences on where price sits against support, resistance and its range",
  "positioning": "1 to 2 sentences on the cohort, funding and open interest together",
  "bullCase": "1 to 2 sentences, what happens if this works",
  "bearCase": "1 to 2 sentences, what happens if it does not",
  "confirmation": "1 sentence: the specific thing that would confirm this idea",
  "invalidation": "1 sentence: the specific condition that kills it",
  "watch1": "short trigger phrase",
  "watch2": "short trigger phrase",
  "watch3": "short trigger phrase",
  "risk1": "short phrase",
  "risk2": "short phrase",
  "risk3": "short phrase"
}

Every price must be a separate bare JSON number rounded to at most 6 significant digits. tp1 is
the nearest target, tp3 the furthest. Do not quote prices and never run two numbers together.`;

/** What the client sends: the consensus row it already has on screen. */
type Body = {
  coin?: string;
  side?: string;
  price?: number;
  score?: number;
  entryScore?: number;
  agreement?: number;
  withCount?: number;
  againstCount?: number;
  withNotional?: number;
  againstNotional?: number;
  avgEntry?: number;
  avgLeverage?: number;
  avgCommitment?: number;
  groupPnlPct?: number;
  edgeVsGroup?: number;
  flags?: string[];
  risk?: { score?: number; band?: string; drivers?: { note?: string }[] };
};

export type Market = {
  price: number;
  change24hPct: number;
  atr: number;
  atrPct: number;
  drift24h: number;
  drift7d: number;
  drift30d: number;
  rangeLow: number;
  rangeHigh: number;
  rangePosition: number;
  support: number | null;
  supportPct: number | null;
  resistance: number | null;
  resistancePct: number | null;
  /** Hourly rate as a percent. */
  fundingPct: number;
  fundingAnnualPct: number;
  /** What the funding does to THIS side of the trade. */
  fundingForYou: "collect" | "pay" | "flat";
  openInterestUsd: number;
  dayVolumeUsd: number;
  /** Day volume over open interest. High means the book turns over fast. */
  turnover: number;
  premiumBps: number;
  maxLeverage: number;
  bars: number;
};

export type Analysis = {
  coin: string;
  sector: string;
  assetClass: string;
  headline: string;
  plan: Plan;
  scaffold: Plan;
  /** Fields the model proposed that failed validation and were replaced. */
  rejected: string[];
  disagreesWithConsensus: boolean;
  conviction: string;
  horizon: string;
  read: string;
  why: string;
  structure: string;
  positioning: string;
  bullCase: string;
  bearCase: string;
  confirmation: string;
  invalidation: string;
  watch: string[];
  risks: string[];
  market: Market;
  /** Leverage implied by the stop at each account risk level. */
  sizing: { riskPct: number; leverage: number }[];
  model: string;
  degraded: boolean;
  error?: string;
};

const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Round to six significant digits before handing a number to the model.
 *
 * Not cosmetic. Feeding gpt-oss a scaffold of full precision floats made it echo
 * all three targets glued into a single string. Clean inputs come back as clean
 * outputs, and six digits is far finer than any tick size here.
 */
const sig = (v: number) => Number(v.toPrecision(6));

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const coin = String(body.coin ?? "").trim();
  // The coin becomes part of an upstream request, so it is a trust boundary
  // even though our own client is what normally posts here.
  if (!coin || !/^[A-Za-z0-9]{1,20}$/.test(coin)) {
    return NextResponse.json({ error: "Unknown instrument" }, { status: 400 });
  }
  const side = body.side === "short" ? "short" : "long";

  // Both are best effort. A coin too new for candles, or a venue hiccup on the
  // context call, still gets a plan; it just gets a less detailed one.
  const [bars, ctxs] = await Promise.all([
    candles(coin, "1h", 720).catch(() => []),
    assetContexts().catch(() => ({}) as Record<string, never>),
  ]);
  const ctx = ctxs[coin];

  const price = num(body.price) || ctx?.markPx || bars[bars.length - 1]?.c || 0;
  if (price <= 0) {
    return NextResponse.json({ error: "No price available for this instrument" }, { status: 502 });
  }

  const atrValue = atr(bars);
  const base = scaffold(side, price, atrValue);
  const range = rangePosition(bars, 168);
  // One ATR of separation, so a "level" is somewhere price has actually turned
  // and travelled away from, not the last wiggle.
  const levels = nearestLevels(bars, price, 6, atrValue);

  const fundingPct = (ctx?.funding ?? 0) * 100;
  const market: Market = {
    price,
    change24hPct: ctx?.prevDayPx ? ((price - ctx.prevDayPx) / ctx.prevDayPx) * 100 : 0,
    atr: atrValue,
    atrPct: atrPct(bars),
    drift24h: drift(bars, 24),
    drift7d: drift(bars, 168),
    drift30d: drift(bars, 720),
    rangeLow: range.low,
    rangeHigh: range.high,
    rangePosition: range.position,
    support: levels.support,
    supportPct: levels.supportPct,
    resistance: levels.resistance,
    resistancePct: levels.resistancePct,
    fundingPct,
    fundingAnnualPct: fundingPct * 24 * 365,
    // Positive funding means longs pay shorts, so a short collects it.
    fundingForYou:
      Math.abs(fundingPct) < 1e-6
        ? "flat"
        : fundingPct > 0 === (side === "short")
          ? "collect"
          : "pay",
    openInterestUsd: ctx?.openInterestUsd ?? 0,
    dayVolumeUsd: ctx?.dayNotionalVolume ?? 0,
    turnover: ctx?.openInterestUsd ? ctx.dayNotionalVolume / ctx.openInterestUsd : 0,
    premiumBps: (ctx?.premium ?? 0) * 10_000,
    maxLeverage: ctx?.maxLeverage ?? 0,
    bars: bars.length,
  };

  const facts = {
    instrument: coin,
    sector: sector(coin),
    assetClass: assetClass(coin),
    price: sig(price),
    consensus: {
      side,
      tradersWith: num(body.withCount),
      tradersAgainst: num(body.againstCount),
      notionalWith: Math.round(num(body.withNotional)),
      notionalAgainst: Math.round(num(body.againstNotional)),
      agreementPct: Math.round(num(body.agreement) * 100),
      agreementScore: num(body.score),
      entryScore: num(body.entryScore),
      groupAvgEntry: sig(num(body.avgEntry)),
      groupOpenPnlPctOfNotional: Number(num(body.groupPnlPct).toFixed(2)),
      yourEntryEdgeVsGroupPct: Number(num(body.edgeVsGroup).toFixed(2)),
      groupAvgLeverage: Number(num(body.avgLeverage).toFixed(1)),
      groupAvgAccountShare: Number((num(body.avgCommitment) * 100).toFixed(1)),
      flags: Array.isArray(body.flags) ? body.flags.slice(0, 6) : [],
    },
    risk: {
      score: num(body.risk?.score),
      band: body.risk?.band ?? "unrated",
      drivers: (body.risk?.drivers ?? []).slice(0, 6).map((d) => d?.note).filter(Boolean),
    },
    market: {
      change24hPct: Number(market.change24hPct.toFixed(2)),
      atrPctOfPrice: Number(market.atrPct.toFixed(2)),
      drift24hPct: Number(market.drift24h.toFixed(2)),
      drift7dPct: Number(market.drift7d.toFixed(2)),
      drift30dPct: Number(market.drift30d.toFixed(2)),
      sevenDayLow: sig(market.rangeLow),
      sevenDayHigh: sig(market.rangeHigh),
      positionInRangePct: Math.round(market.rangePosition),
      nearestSupport: market.support == null ? null : sig(market.support),
      supportDistancePct: market.supportPct == null ? null : Number(market.supportPct.toFixed(2)),
      nearestResistance: market.resistance == null ? null : sig(market.resistance),
      resistanceDistancePct:
        market.resistancePct == null ? null : Number(market.resistancePct.toFixed(2)),
      hourlyFundingPct: Number(market.fundingPct.toFixed(5)),
      annualisedFundingPct: Number(market.fundingAnnualPct.toFixed(1)),
      fundingForThisSide: market.fundingForYou,
      openInterestUsd: Math.round(market.openInterestUsd),
      dayVolumeUsd: Math.round(market.dayVolumeUsd),
      volumeOverOpenInterest: Number(market.turnover.toFixed(2)),
      markVsOracleBps: Number(market.premiumBps.toFixed(1)),
      venueMaxLeverage: market.maxLeverage,
      hourlyBarsAvailable: market.bars,
    },
    scaffold: {
      entry: sig(base.entry),
      stop: sig(base.stop),
      tp1: sig(base.targets[0]),
      tp2: sig(base.targets[1]),
      tp3: sig(base.targets[2]),
      riskPerUnit: sig(base.risk),
      stopDistancePct: Number(((base.risk / price) * 100).toFixed(3)),
      note: "stop is 1.5x the 1h ATR from entry, targets are 1R / 2R / 3R off that risk",
    },
  };

  const reply = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(facts) },
    ],
    { json: true, maxTokens: 2200 },
  );

  type Raw = Record<string, unknown>;
  const parsed = reply.error ? null : parseJson<Raw>(reply.text);

  // Targets arrive as three flat fields, not as an array. Asked for an array,
  // gpt-oss-120b returned all three numbers concatenated into a single string.
  // Flat scalars in the same response came back clean every time.
  const proposed: Proposed | null = parsed
    ? {
        side: typeof parsed.bias === "string" ? parsed.bias : undefined,
        entry: parsed.entry,
        stop: parsed.stop,
        targets: [parsed.tp1, parsed.tp2, parsed.tp3].filter((t) => t !== undefined && t !== null),
      }
    : null;

  const { plan, rejected } = reconcile(base, proposed);

  const str = (key: string, fallback = "") => {
    const v = parsed?.[key];
    return typeof v === "string" && v.trim() ? cleanProse(v.trim()) : fallback;
  };
  const list = (...keys: string[]) => keys.map((k) => str(k)).filter(Boolean);

  const stopPct = (plan.risk / plan.entry) * 100;

  const out: Analysis = {
    coin,
    sector: sector(coin),
    assetClass: assetClass(coin),
    headline: str("headline", `${coin} ${plan.side}, ${plan.rr.toFixed(1)} to 1 at the far target`),
    plan,
    scaffold: base,
    rejected,
    disagreesWithConsensus: plan.side !== side,
    conviction: str("conviction", "unrated"),
    horizon: str("horizon", "unstated"),
    read: str(
      "read",
      reply.error ? "" : "The model returned nothing usable, so everything below is computed.",
    ),
    why: str("why", "Stop is 1.5x the 1h ATR from entry, targets are 1R, 2R and 3R off that risk."),
    structure: str("structure"),
    positioning: str("positioning"),
    bullCase: str("bullCase"),
    bearCase: str("bearCase"),
    confirmation: str("confirmation"),
    invalidation: str("invalidation", "Price closing beyond the stop on the 1h chart."),
    watch: list("watch1", "watch2", "watch3"),
    risks: list("risk1", "risk2", "risk3"),
    market,
    // Leverage is not a dial you pick, it falls out of the stop you chose.
    sizing: [0.5, 1, 2].map((riskPct) => ({
      riskPct,
      leverage: impliedLeverage(riskPct, stopPct),
    })),
    model: reply.model,
    degraded: Boolean(reply.error) || !parsed,
    error: reply.error,
  };

  return NextResponse.json(out);
}
