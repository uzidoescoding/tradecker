"use client";

import { useEffect, useState } from "react";
import type { Analysis as A } from "@/app/api/analyze/route";
import type { Consensus } from "@/lib/consensus";
import { pct, px, tone } from "@/lib/fmt";

/**
 * The AI read on one instrument.
 *
 * Two things this deliberately does not do. It does not present the levels as
 * the model's unaided work: where a proposal failed validation the panel says
 * so by name. And it does not hide the volatility scaffold, because "the model
 * agreed with the scaffold" and "the model had an opinion" look identical
 * otherwise, and only one of them is worth reading.
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
  const dir = p.side === "long" ? 1 : -1;
  const away = (v: number) => ((v - p.entry) / p.entry) * 100;

  return (
    <div className="material mt-1 mb-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="t-label">Desk read</p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="chip">{data.sector}</span>
          <span className="chip">{data.assetClass}</span>
          <span className="chip">conviction: {data.conviction}</span>
          <span className="chip">ATR {data.atrPct.toFixed(2)}%</span>
        </div>
      </div>

      {data.disagreesWithConsensus && (
        <p
          className="t-caption mt-3 rounded-xl px-3 py-2"
          style={{ background: "var(--warn-soft)", color: "var(--text-2)" }}
        >
          The model reads this <strong>{p.side}</strong> while the cohort is positioned{" "}
          <strong>{row.side}</strong>. Two different signals, not one.
        </p>
      )}

      {data.read && (
        <p className="t-body mt-3" style={{ color: "var(--text-2)" }}>
          {data.read}
        </p>
      )}

      {/* Levels. Entry, stop and each target with its distance, because a bare
          price tells you nothing about whether the stop is 0.4% or 14% away. */}
      <div className="mt-4 overflow-hidden rounded-xl" style={{ border: "1px solid var(--hairline)" }}>
        <Level k="Entry" v={px(p.entry)} note={p.side === "long" ? "buy" : "sell"} accent="var(--text)" />
        <Level
          k="Stop"
          v={px(p.stop)}
          note={`${Math.abs(away(p.stop)).toFixed(2)}% away, 1R`}
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

      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Mini k="Risk / unit" v={px(p.risk)} />
        <Mini k="R:R at TP3" v={`${p.rr.toFixed(1)} : 1`} tone={p.rr >= 2 ? "var(--up)" : undefined} />
        <Mini k="24h drift" v={pct(data.drift24h)} tone={tone(data.drift24h * dir)} />
        <Mini k="Group entry" v={px(row.avgEntry)} />
      </div>

      <p className="t-caption mt-3">{data.why}</p>
      <p className="t-caption mt-1">
        <strong style={{ color: "var(--text-2)" }}>Invalidated if:</strong> {data.invalidation}
      </p>

      {data.risks.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {data.risks.map((r) => (
            <span key={r} className="chip" style={{ color: "var(--warn)" }}>
              {r}
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
        Generated by {data.model} from the numbers above and nothing else: it has no news, no
        macro and no knowledge of anything off this page. Not advice.
      </p>
    </div>
  );
}

function Level({ k, v, note, accent }: { k: string; v: string; note: string; accent: string }) {
  return (
    <div
      className="flex items-baseline justify-between gap-3 px-3 py-2"
      style={{ borderBottom: "1px solid var(--hairline)" }}
    >
      <span className="t-label" style={{ color: accent }}>
        {k}
      </span>
      <span className="tnum flex-1 text-right text-sm font-semibold">{v}</span>
      <span className="t-caption w-32 text-right">{note}</span>
    </div>
  );
}

function Mini({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div>
      <p className="t-label">{k}</p>
      <p className="tnum text-sm font-semibold" style={tone ? { color: tone } : undefined}>
        {v}
      </p>
    </div>
  );
}
