"use client";

import { useEffect, useState } from "react";
import type { Analysis as A } from "@/app/api/analyze/route";
import type { Consensus } from "@/lib/consensus";
import { pct, px, tone, usd } from "@/lib/fmt";

/**
 * The AI read on one instrument.
 *
 * Dense on purpose. The layout is built so the whole note is scannable without
 * scrolling: numbers live in tight labelled grids, prose is capped at a line or
 * two per section, and nothing repeats itself between sections.
 *
 * Two things it deliberately does not do. It does not present the levels as the
 * model's unaided work: where a proposal failed validation the panel says so by
 * name. And it does not hide the volatility scaffold, because "the model agreed
 * with the scaffold" and "the model had an opinion" look identical otherwise.
 */
export default function Analysis({ row }: { row: Consensus }) {
  const [data, setData] = useState<A | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setData(null);
    setError(null);
    fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    })
      .then((r) => r.json())
      .then((j) => {
        if (!live) return;
        if (j.error && !j.plan) setError(j.error);
        else setData(j);
      })
      .catch(() => live && setError("Could not reach the analysis endpoint."))
      .finally(() => live && setLoading(false));
    // Refetch when the instrument changes, not on every price tick: the whole
    // sheet would otherwise re-run a model call every 60 seconds.
    return () => {
      live = false;
    };
  }, [row.coin, row.side]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="material mt-1 mb-4 p-4">
        <p className="t-label">Desk read</p>
        <div className="mt-3 space-y-2">
          <div className="h-3 w-3/4 animate-pulse rounded bg-black/10" />
          <div className="h-3 w-full animate-pulse rounded bg-black/10" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-black/10" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="material mt-1 mb-4 p-4">
        <p className="t-label">Desk read</p>
        <p className="t-caption mt-2">{error ?? "No analysis available."}</p>
      </div>
    );
  }

  const p = data.plan;
  const m = data.market;
  const dir = p.side === "long" ? 1 : -1;
  const away = (v: number) => ((v - p.entry) / p.entry) * 100;
  const stopPct = (p.risk / p.entry) * 100;

  return (
    <div className="material mt-1 mb-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="t-label">Desk read</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="chip">{data.sector}</span>
          <span className="chip">conviction: {data.conviction}</span>
          <span className="chip">horizon: {data.horizon}</span>
          <span className="chip">ATR {m.atrPct.toFixed(2)}%</span>
        </div>
      </div>

      {/* The whole thesis in one line, so the rest is optional reading. */}
      <p className="t-title mt-2">{data.headline}</p>

      {data.disagreesWithConsensus && (
        <p
          className="t-caption mt-2 rounded-xl px-3 py-2"
          style={{ background: "var(--warn-soft)", color: "var(--text-2)" }}
        >
          The model reads this <strong>{p.side}</strong> while the cohort is positioned{" "}
          <strong>{row.side}</strong>. Two different signals, not one.
        </p>
      )}

      {data.read && (
        <p className="t-body mt-2" style={{ color: "var(--text-2)" }}>
          {data.read}
        </p>
      )}

      {/* ------------------------------------------------------------ levels */}
      <p className="t-label mt-4 mb-1.5">The trade</p>
      <div className="overflow-hidden rounded-xl" style={{ border: "1px solid var(--hairline)" }}>
        <Level k="Entry" v={px(p.entry)} note={p.side === "long" ? "buy" : "sell"} accent="var(--text)" />
        <Level
          k="Stop"
          v={px(p.stop)}
          note={`${stopPct.toFixed(2)}% away, 1R`}
          accent="var(--down)"
        />
        {p.targets.map((t, i) => (
          <Level
            key={i}
            k={`TP${i + 1}`}
            v={px(t)}
            note={`${Math.abs(away(t)).toFixed(2)}% away, ${(Math.abs(t - p.entry) / p.risk).toFixed(1)}R`}
            accent="var(--up)"
          />
        ))}
      </div>

      <div className="mt-2 grid grid-cols-3 gap-3 sm:grid-cols-6">
        <Mini k="Risk / unit" v={px(p.risk)} />
        <Mini k="R:R at TP3" v={`${p.rr.toFixed(1)}:1`} tone={p.rr >= 2 ? "var(--up)" : undefined} />
        {/* Leverage is not a dial you pick, it falls out of the stop you chose. */}
        {data.sizing.map((s) => (
          <Mini
            key={s.riskPct}
            k={`${s.riskPct}% risk`}
            v={`${s.leverage.toFixed(1)}x`}
            tone={s.leverage > m.maxLeverage && m.maxLeverage > 0 ? "var(--down)" : undefined}
          />
        ))}
        <Mini k="Venue cap" v={m.maxLeverage ? `${m.maxLeverage}x` : "—"} />
      </div>
      <p className="t-caption mt-1.5">{data.why}</p>

      {/* --------------------------------------------------------- structure */}
      <p className="t-label mt-4 mb-1.5">Where price sits</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini k="24h" v={pct(m.change24hPct)} tone={tone(m.change24hPct * dir)} />
        <Mini k="7d" v={pct(m.drift7d)} tone={tone(m.drift7d * dir)} />
        <Mini k="30d" v={pct(m.drift30d)} tone={tone(m.drift30d * dir)} />
        <Mini k="In 7d range" v={`${Math.round(m.rangePosition)}%`} />
        <Mini
          k="Support"
          v={m.support == null ? "none found" : px(m.support)}
          hint={m.supportPct == null ? "in this window" : `${m.supportPct.toFixed(1)}% below`}
        />
        <Mini
          k="Resistance"
          v={m.resistance == null ? "none found" : px(m.resistance)}
          hint={m.resistancePct == null ? "in this window" : `${m.resistancePct.toFixed(1)}% above`}
        />
        <Mini k="7d low" v={px(m.rangeLow)} />
        <Mini k="7d high" v={px(m.rangeHigh)} />
      </div>
      {data.structure && <p className="t-caption mt-1.5">{data.structure}</p>}

      {/* -------------------------------------------------------- positioning */}
      <p className="t-label mt-4 mb-1.5">The book</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini
          k="Funding"
          v={`${m.fundingPct >= 0 ? "+" : ""}${m.fundingPct.toFixed(4)}%/h`}
          hint={`${m.fundingAnnualPct >= 0 ? "+" : ""}${m.fundingAnnualPct.toFixed(0)}% a year`}
          tone={
            m.fundingForYou === "collect"
              ? "var(--up)"
              : m.fundingForYou === "pay"
                ? "var(--down)"
                : undefined
          }
        />
        <Mini
          k="You"
          v={m.fundingForYou === "flat" ? "neither" : m.fundingForYou}
          hint="holding this side"
          tone={m.fundingForYou === "collect" ? "var(--up)" : m.fundingForYou === "pay" ? "var(--down)" : undefined}
        />
        <Mini k="Open interest" v={usd(m.openInterestUsd)} hint="whole venue" />
        <Mini
          k="24h volume"
          v={usd(m.dayVolumeUsd)}
          hint={m.turnover ? `${m.turnover.toFixed(1)}x the OI` : "vs open interest"}
        />
      </div>
      {data.positioning && <p className="t-caption mt-1.5">{data.positioning}</p>}

      {/* --------------------------------------------------------- both sides */}
      {(data.bullCase || data.bearCase) && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {data.bullCase && <Case k="If it works" v={data.bullCase} accent="var(--up)" />}
          {data.bearCase && <Case k="If it does not" v={data.bearCase} accent="var(--down)" />}
        </div>
      )}

      <div className="mt-3 space-y-1">
        {data.confirmation && <Line k="Confirmed by" v={data.confirmation} />}
        <Line k="Invalidated if" v={data.invalidation} />
      </div>

      {(data.watch.length > 0 || data.risks.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.watch.map((w) => (
            <span key={w} className="chip" style={{ color: "var(--accent)" }}>
              watch: {w}
            </span>
          ))}
          {data.risks.map((r) => (
            <span key={r} className="chip" style={{ color: "var(--warn)" }}>
              risk: {r}
            </span>
          ))}
        </div>
      )}

      <p className="t-caption mt-3" style={{ opacity: 0.85 }}>
        Levels start from a volatility scaffold: stop at 1.5x the 1h ATR, targets at 1R, 2R and 3R.{" "}
        {data.rejected.length > 0 ? (
          <>
            The model proposed a different {data.rejected.join(" and ")} that failed validation, so
            the scaffold value stands there.
          </>
        ) : data.degraded ? (
          <>The model returned nothing usable, so these are the scaffold values unchanged.</>
        ) : (
          <>The model reviewed them and its adjustments passed validation.</>
        )}{" "}
        Prose generated by {data.model} from the {m.bars} hourly bars and the figures above, and
        nothing else: it has no news, no macro and no knowledge of anything off this page. Not
        advice.
      </p>
    </div>
  );
}

function Level({ k, v, note, accent }: { k: string; v: string; note: string; accent: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 px-3 py-1.5"
      style={{ borderBottom: "1px solid var(--hairline)" }}
    >
      <span className="t-label" style={{ color: accent }}>
        {k}
      </span>
      <span className="tnum flex-1 text-right text-sm font-semibold">{v}</span>
      <span className="t-caption w-28 text-right">{note}</span>
    </div>
  );
}

function Mini({ k, v, hint, tone }: { k: string; v: string; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="t-label truncate">{k}</p>
      <p className="tnum truncate text-sm font-semibold" style={tone ? { color: tone } : undefined}>
        {v}
      </p>
      {hint && <p className="t-caption truncate">{hint}</p>}
    </div>
  );
}

function Case({ k, v, accent }: { k: string; v: string; accent: string }) {
  return (
    <div className="rounded-xl px-3 py-2" style={{ border: "1px solid var(--hairline)" }}>
      <p className="t-label" style={{ color: accent }}>
        {k}
      </p>
      <p className="t-caption mt-0.5">{v}</p>
    </div>
  );
}

function Line({ k, v }: { k: string; v: string }) {
  return (
    <p className="t-caption">
      <strong style={{ color: "var(--text-2)" }}>{k}:</strong> {v}
    </p>
  );
}
