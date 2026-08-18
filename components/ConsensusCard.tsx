"use client";

import type { Consensus } from "@/lib/consensus";
import { pct, px, riskColor, tone, usd } from "@/lib/fmt";

/** A flag is either a warning about the trade or a note in its favour. */
const FLAG_TONE: Record<string, string> = {
  Crowded: "var(--warn)",
  Late: "var(--warn)",
  "Worse entry": "var(--down)",
  "Better entry": "var(--up)",
  Fresh: "var(--up)",
};

function scoreColor(score: number) {
  if (score >= 70) return "var(--up)";
  if (score >= 40) return "var(--accent)";
  return "var(--text-3)";
}

export default function ConsensusCard({
  row,
  featured = false,
  onOpen,
}: {
  row: Consensus;
  featured?: boolean;
  onOpen: () => void;
}) {
  const side = row.side === "long" ? "var(--up)" : "var(--down)";
  const sideSoft = row.side === "long" ? "var(--up-soft)" : "var(--down-soft)";

  return (
    <button
      onClick={onOpen}
      className={`material pressable w-full overflow-hidden p-5 text-left ${featured ? "sm:p-7" : ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={featured ? "t-display" : "t-title"}>{row.coin}</span>
            <span className="side-pill" style={{ background: sideSoft, color: side }}>
              {row.side}
            </span>
            {/* What kind of thing this is. Four coins agreeing is only four
                signals if they are not all the same sector. */}
            <span className="chip">{row.sector}</span>
            {/* Asset class is only worth the space when it is the surprise. */}
            {row.assetClass !== "Crypto" && <span className="chip">{row.assetClass}</span>}
          </div>

          {/* The live price gets real size. It is the number you check against
              your own screen before doing anything, and as a caption it was
              losing to the score it sits next to. */}
          <p
            className={`tnum mt-2 leading-none font-semibold tracking-tight ${featured ? "text-3xl" : "text-2xl"}`}
          >
            {px(row.price)}
          </p>
          <p className="t-caption tnum mt-1">now · group in at {px(row.avgEntry)}</p>
        </div>

        {/* The big number is the one that answers "should I put money in this
            now". Raw agreement sits underneath it, because a group that agrees
            hard on a trade already 300% in profit is not the same opportunity
            as a group that agrees hard on one they entered this morning. */}
        <div className="flex-none text-right">
          <p
            className="tnum text-3xl leading-none font-bold tracking-tight"
            style={{ color: scoreColor(row.entryScore) }}
          >
            {row.entryScore}
          </p>
          <p className="t-label mt-1">entry score</p>
          <p className="t-caption tnum mt-0.5">{row.score} agreement</p>
        </div>
      </div>

      <div className="meter mt-4">
        <i style={{ width: `${row.entryScore}%`, background: scoreColor(row.entryScore) }} />
      </div>

      {/* The two halves of the score, spelled out, because a bare 0..100 tells
          you nothing about whether it came from breadth or from conviction. */}
      <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Cell
          k="Traders in"
          v={`${row.withCount}`}
          hint={row.againstCount ? `${row.againstCount} on the other side` : "nobody opposing"}
        />
        <Cell k="Money in" v={usd(row.withNotional)} hint={`avg ${row.avgLeverage.toFixed(1)}x`} />
        <Cell
          k="Your entry"
          v={pct(row.edgeVsGroup)}
          hint="vs the group's average"
          tone={tone(row.edgeVsGroup)}
        />
        <Cell
          k="Group open P&L"
          v={pct(row.groupPnlPct)}
          hint={row.groupPnlPct > 0 ? "already running" : "still near entry"}
          tone={tone(row.groupPnlPct)}
        />
      </div>

      {/* Risk sits on its own line, not among the flags. It answers a different
          question from the entry score: not "is this a good idea" but "what
          does it cost you if it is wrong", and the two can point opposite ways. */}
      <div className="mt-4 flex items-center gap-2.5">
        <span className="t-label flex-none">Risk</span>
        <span className="meter min-w-0 flex-1">
          <i
            style={{ width: `${row.risk.score}%`, background: riskColor(row.risk.score) }}
          />
        </span>
        <span
          className="tnum flex-none text-xs font-semibold"
          style={{ color: riskColor(row.risk.score) }}
        >
          {row.risk.band} {row.risk.score}
        </span>
      </div>
      {row.risk.drivers[0] && <p className="t-caption mt-1">{row.risk.drivers[0].note}</p>}

      <div className="mt-4 flex flex-wrap gap-1.5">
        {row.flags.map((f) => (
          <span key={f} className="chip" style={FLAG_TONE[f] ? { color: FLAG_TONE[f] } : undefined}>
            {f}
          </span>
        ))}
        <span className="chip">{(row.agreement * 100).toFixed(0)}% of the weight</span>
        <span className="chip">{(row.freshness * 100).toFixed(0)}% of the move left</span>
      </div>
    </button>
  );
}

function Cell({ k, v, hint, tone }: { k: string; v: string; hint: string; tone?: string }) {
  return (
    <div>
      <p className="t-label">{k}</p>
      <p className="tnum text-lg font-semibold tracking-tight" style={tone ? { color: tone } : undefined}>
        {v}
      </p>
      <p className="t-caption">{hint}</p>
    </div>
  );
}
