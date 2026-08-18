import { NextRequest, NextResponse } from "next/server";
import { assetClass, sector } from "@/lib/categories";
import { chat, parseJson } from "@/lib/groq";
import { atr, atrPct, drift, reconcile, scaffold, type Plan, type Proposed } from "@/lib/levels";
import { candles } from "@/lib/hyperliquid";
import { cleanProse } from "@/lib/text";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SYSTEM = `You are a trading desk analyst writing a plan for one instrument.

You are given: a consensus reading built from the live open positions of accounts that are
profitable over the long run, the current price, realised volatility (ATR), recent drift, and a
volatility derived scaffold of levels.

Rules:
- Work ONLY from the numbers supplied. You have no knowledge of news, macro, fundamentals, token
  unlocks or anything outside this payload. Never invent any of it.
- The scaffold levels are anchored to real volatility. Adjust them only when the supplied numbers
  give you a concrete reason, and say what the reason was. Keeping the scaffold is a fine answer.
- A risk reading is supplied. Do not restate it as a number, but let it shape the tone: if the
  risk is High or Severe, say what specifically makes it so in your read.
- Your bias should normally match the consensus side. If you disagree with it, say so explicitly
  and explain which number changed your mind.
- The stop must sit on the losing side of entry. Targets must be in profit and in increasing
  distance from entry.
- Describe what the data says and what the risk is. Never tell the reader what they must do with
  their money.
- Never use em-dashes or double hyphens; use commas or colons instead.

Reply with JSON only, in exactly this shape:
{
  "bias": "long" | "short",
  "conviction": "low" | "medium" | "high",
  "entry": number,
  "stop": number,
  "tp1": number,
  "tp2": number,
  "tp3": number,
  "read": "3 to 5 sentences on what is going on in this instrument",
  "why": "1 to 2 sentences on why these levels, referencing ATR or the group's entry",
  "invalidation": "1 sentence: the specific condition that kills this idea",
  "risks": ["short phrase", "short phrase"]
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
  avgEntry?: number;
  avgLeverage?: number;
  avgCommitment?: number;
  groupPnlPct?: number;
  edgeVsGroup?: number;
  flags?: string[];
  risk?: { score?: number; band?: string; drivers?: { note?: string }[] };
};

export type Analysis = {
  coin: string;
  sector: string;
  assetClass: string;
  plan: Plan;
  scaffold: Plan;
  /** Fields the model proposed that failed validation and were replaced. */
  rejected: string[];
  disagreesWithConsensus: boolean;
  conviction: string;
  read: string;
  why: string;
  invalidation: string;
  risks: string[];
  atr: number;
  atrPct: number;
  drift24h: number;
  model: string;
  degraded: boolean;
  error?: string;
};

const num = (v: unknown, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

/**
 * Round to six significant digits before handing a number to the model.
 *
 * Not cosmetic. Feeding gpt-oss a scaffold of full precision floats like
 * 44.112884413253326 made it echo all three targets glued into a single string,
 * "44.35644220662667 44.11288441325333 43.86932661988", which failed validation
 * every time and silently threw away the model's opinion. Clean inputs come
 * back as clean outputs. Six digits is far finer than any tick size here.
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

  let bars: Awaited<ReturnType<typeof candles>> = [];
  try {
    bars = await candles(coin, "1h", 200);
  } catch {
    // A coin too new to have history still gets a plan, just a wider one.
  }

  const price = num(body.price) || bars[bars.length - 1]?.c || 0;
  if (price <= 0) {
    return NextResponse.json({ error: "No price available for this instrument" }, { status: 502 });
  }

  const atrValue = atr(bars);
  const base = scaffold(side, price, atrValue);

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
    // The board already shows a risk reading. Give the model the same one so
    // its written read cannot quietly contradict the number next to it.
    risk: {
      score: num(body.risk?.score),
      band: body.risk?.band ?? "unrated",
      drivers: (body.risk?.drivers ?? []).slice(0, 6).map((d) => d?.note).filter(Boolean),
    },
    volatility: {
      atr1h: sig(atrValue),
      atrPctOfPrice: Number(atrPct(bars).toFixed(2)),
      drift24hPct: Number(drift(bars, 24).toFixed(2)),
      drift7dPct: Number(drift(bars, 168).toFixed(2)),
      barsAvailable: bars.length,
    },
    scaffold: {
      entry: sig(base.entry),
      stop: sig(base.stop),
      targets: base.targets.map(sig),
      riskPerUnit: sig(base.risk),
      note: "stop is 1.5x ATR from entry, targets are 1R / 2R / 3R off that risk",
    },
  };

  const reply = await chat(
    [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(facts) },
    ],
    { json: true, maxTokens: 1400 },
  );

  type Raw = Record<string, unknown> & { tp1?: unknown; tp2?: unknown; tp3?: unknown };
  const parsed = reply.error ? null : parseJson<Raw>(reply.text);

  // Targets arrive as three flat fields, not as an array.
  //
  // Asked for `"targets": [number, number, number]`, gpt-oss-120b reliably
  // returned a one element array with all three numbers concatenated into a
  // single string: ["44.355744.111443.8671"]. Flat scalar fields in the same
  // response came back clean every time, so the schema was flattened to match
  // what the model can actually produce. reconcile still validates the result,
  // and still rejects the glued form if a future model reintroduces it.
  const proposed: Proposed | null = parsed
    ? {
        side: typeof parsed.bias === "string" ? parsed.bias : undefined,
        entry: parsed.entry,
        stop: parsed.stop,
        targets: [parsed.tp1, parsed.tp2, parsed.tp3].filter((t) => t !== undefined && t !== null),
      }
    : null;

  const { plan, rejected } = reconcile(base, proposed);

  const str = (v: unknown, fallback = "") =>
    typeof v === "string" && v.trim() ? cleanProse(v.trim()) : fallback;

  const out: Analysis = {
    coin,
    sector: sector(coin),
    assetClass: assetClass(coin),
    plan,
    scaffold: base,
    rejected,
    disagreesWithConsensus: plan.side !== side,
    conviction: str(parsed?.conviction, "unrated"),
    read: str(
      parsed?.read,
      reply.error
        ? ""
        : "The model returned nothing usable, so the levels below are the volatility scaffold on its own.",
    ),
    why: str(
      parsed?.why,
      `Stop is 1.5x the 1h ATR from entry, targets are 1R, 2R and 3R off that same risk unit.`,
    ),
    invalidation: str(parsed?.invalidation, "Price closing beyond the stop on the 1h chart."),
    risks: Array.isArray(parsed?.risks)
      ? (parsed.risks as unknown[]).filter((r) => typeof r === "string").slice(0, 4).map((r) => cleanProse(r as string))
      : [],
    atr: atrValue,
    atrPct: atrPct(bars),
    drift24h: drift(bars, 24),
    model: reply.model,
    degraded: Boolean(reply.error) || !parsed,
    error: reply.error,
  };

  return NextResponse.json(out);
}
