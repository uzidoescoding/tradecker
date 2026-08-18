"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
import type { ConsensusResponse } from "@/app/api/consensus/route";
import type { Consensus } from "@/lib/consensus";
import { DEFAULT_FILTER, FILTERS } from "@/lib/consensus";
import type { Sector } from "@/lib/categories";
import { ago, pct, px, riskColor, short, tone, usd } from "@/lib/fmt";
import Analysis from "@/components/Analysis";
import AskPanel from "@/components/AskPanel";
import ConsensusCard from "@/components/ConsensusCard";
import Sheet from "@/components/Sheet";
import TraderTable from "@/components/TraderTable";

const REFRESH_MS = 60_000;
/** One trader in a coin is a position, not a consensus. */
const MIN_BREADTH = 2;
/**
 * How many cards to draw. The tail is real data but it is all two-trader,
 * mostly-spent agreement, and every card is a translucent material: a hundred
 * of them is both a wall of noise and a compositor full of backdrop blurs.
 */
const SHOWN = 24;

export default function Page() {
  const [filter, setFilter] = useState(DEFAULT_FILTER);
  const [group, setGroup] = useState<Sector | "All">("All");
  const [data, setData] = useState<ConsensusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Consensus | null>(null);
  const [asking, setAsking] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/consensus?filter=${filter}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Scan failed");
      setData(json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scan failed");
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  const scored = useMemo(
    () => (data?.rows ?? []).filter((r) => r.withCount >= MIN_BREADTH),
    [data],
  );
  const rows = useMemo(
    () => (group === "All" ? scored : scored.filter((r) => r.sector === group)),
    [scored, group],
  );
  const [top, ...rest] = rows.slice(0, SHOWN);
  const weaker = Math.max(0, rows.length - SHOWN);
  const thin = (data?.rows.length ?? 0) - scored.length;

  /** What the desk can see. Trimmed hard: it answers about the board, not the raw feed. */
  const askContext = useMemo(() => {
    if (!data) return {};
    return {
      filter: data.filter,
      filterMeaning: data.filterNote,
      cohort: data.cohort,
      // Same shape the sector chips render from, so a question like "what is
      // L1/L2 27" is answerable from the payload rather than guessed at.
      sectorChips: data.mix,
      unfilteredCardCount: scored.length,
      qualifyingAccounts: data.qualified,
      accountsScanned: data.scanned,
      accountsHoldingSomething: data.active,
      rows: scored.slice(0, 30).map((r) => ({
        coin: r.coin,
        sector: r.sector,
        assetClass: r.assetClass,
        side: r.side,
        entryScore: r.entryScore,
        agreementScore: r.score,
        agreementPct: Math.round(r.agreement * 100),
        tradersWith: r.withCount,
        tradersAgainst: r.againstCount,
        notionalWith: Math.round(r.withNotional),
        price: r.price,
        groupAvgEntry: r.avgEntry,
        yourEntryEdgePct: Number(r.edgeVsGroup.toFixed(2)),
        groupOpenPnlPct: Number(r.groupPnlPct.toFixed(2)),
        avgLeverage: Number(r.avgLeverage.toFixed(1)),
        riskScore: r.risk.score,
        riskBand: r.risk.band,
        flags: r.flags,
      })),
    };
  }, [data, scored]);

  const sectors = useMemo(() => {
    const seen = new Map<Sector, number>();
    for (const r of scored) seen.set(r.sector, (seen.get(r.sector) ?? 0) + 1);
    return [...seen.entries()].sort((a, b) => b[1] - a[1]);
  }, [scored]);

  return (
    <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 sm:px-6">
      {/* Translucent chrome with content scrolling under it, not an opaque bar
          that eats a fixed strip of the viewport. */}
      <header className="sticky top-0 z-40 -mx-4 mb-6 px-4 py-3 sm:-mx-6 sm:px-6">
        <div className="material-thick flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <Image src="/logo.svg" alt="" width={16} height={23} priority />
            <span className="t-title">Tradecker</span>
            <span className="chip">
              <span
                className="pulse inline-block h-1.5 w-1.5 rounded-full"
                style={{ background: error ? "var(--down)" : "var(--up)" }}
              />
              {error ? "stalled" : loading ? "scanning" : data ? ago(data.asOf) : "live"}
            </span>
          </div>

          <div className="flex items-center gap-2">
            <div className="seg" role="tablist" aria-label="Trader quality bar">
              {Object.entries(FILTERS).map(([key, f]) => (
                <button
                  key={key}
                  role="tab"
                  aria-selected={filter === key}
                  data-on={filter === key}
                  className="seg-item"
                  onClick={() => setFilter(key)}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <button
              className="chip pressable"
              onClick={() => setAsking((v) => !v)}
              aria-expanded={asking}
            >
              Ask the desk
            </button>
          </div>
        </div>
      </header>

      <section className="mb-8">
        <h1 className="t-hero">
          Where the winners
          <br />
          are already in.
        </h1>
        <p className="t-body mt-4 max-w-2xl" style={{ color: "var(--text-2)" }}>
          Tradecker takes every account on Hyperliquid, keeps only the ones that are profitable
          over the long run, then reads their live open positions and looks for the trades they
          have independently arrived at together. One good trader in a coin is an anecdote. Twelve
          is a signal.
        </p>
        <p className="t-caption mt-3">
          Bar for inclusion: {FILTERS[filter]?.note}.{" "}
          {data && (
            <>
              {data.qualified.toLocaleString()} accounts clear it, the top {data.scanned} by weight
              were read, {data.active} are holding something right now.
            </>
          )}
        </p>
      </section>

      {/* How good the voters actually are: this month, and over their life. */}
      {data && data.cohort.count > 0 && (
        <div className="material mb-6 flex flex-wrap items-start gap-x-8 gap-y-4 p-4">
          <Stat
            k="Median 30d ROI"
            v={pct(data.cohort.medianMonthRoi * 100)}
            tone={tone(data.cohort.medianMonthRoi)}
            hint="of the ones holding something"
          />
          <Stat
            k="Median lifetime ROI"
            v={pct(data.cohort.medianAllTimeRoi * 100, 0)}
            tone="var(--up)"
            hint="Hyperliquid has no yearly window, so this is the long run"
          />
          <Stat
            k="Green this month"
            v={`${data.cohort.greenThisMonth} of ${data.cohort.active || data.cohort.count}`}
            hint="lifetime winners still winning now"
          />
          <Stat
            k="Equity behind the vote"
            v={usd(data.cohort.totalEquity)}
            hint="combined account value"
          />
          {data.mix[0] && (
            <Stat
              k="Most crowded sector"
              v={`${data.mix[0].sector} ${Math.round(data.mix[0].share * 100)}%`}
              tone={data.mix[0].share > 0.4 ? "var(--warn)" : undefined}
              hint={`${data.mix[0].count} of ${scored.length} rows, one bet not several`}
            />
          )}
        </div>
      )}

      {error && (
        <div className="material mb-6 p-5">
          <p className="t-title" style={{ color: "var(--down)" }}>
            Scan failed
          </p>
          <p className="t-caption mt-1">{error}</p>
          <button className="chip pressable mt-3" onClick={load}>
            Try again
          </button>
        </div>
      )}

      {loading && !data && <Skeletons />}

      {sectors.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-1.5">
          <button
            className="chip pressable"
            style={group === "All" ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
            onClick={() => setGroup("All")}
          >
            All {scored.length}
          </button>
          {sectors.map(([s, n]) => (
            <button
              key={s}
              className="chip pressable"
              style={group === s ? { color: "var(--accent)", borderColor: "var(--accent)" } : undefined}
              onClick={() => setGroup(s)}
            >
              {s} {n}
            </button>
          ))}
        </div>
      )}

      {top && (
        <>
          <p className="t-label mb-2">Best entry right now</p>
          <ConsensusCard row={top} featured onOpen={() => setOpen(top)} />

          {rest.length > 0 && (
            <>
              <p className="t-label mt-8 mb-2">Everything else they agree on</p>
              <div className="grid gap-4 lg:grid-cols-2">
                {rest.map((r) => (
                  <ConsensusCard key={r.coin} row={r} onOpen={() => setOpen(r)} />
                ))}
              </div>
            </>
          )}

          <p className="t-caption mt-4">
            {weaker > 0 && (
              <>
                {weaker} weaker {weaker === 1 ? "row is" : "rows are"} below the cut.{" "}
              </>
            )}
            {thin > 0 && (
              <>
                {thin} more {thin === 1 ? "coin is" : "coins are"} held by a single qualifying
                trader, hidden here because a lone position is not a consensus.
              </>
            )}
          </p>
        </>
      )}

      {!loading && !error && rows.length === 0 && (
        <div className="material p-5">
          <p className="t-title">Nothing to agree on</p>
          <p className="t-caption mt-1">
            {group === "All"
              ? "No coin has two or more qualifying traders on the same side at this bar. Try a wider filter."
              : `No ${group} coin has two or more qualifying traders on the same side. Try another sector.`}
          </p>
        </div>
      )}

      {data && data.traders.length > 0 && (
        <div className="mt-8">
          <TraderTable traders={data.traders} />
        </div>
      )}

      <footer className="t-caption mt-10 max-w-3xl">
        Position and performance data from the public Hyperliquid API, refreshed every minute. The
        written analysis and the trade levels are generated by a language model from those numbers
        alone: it has no news, no macro and no knowledge of anything off this page. Tradecker
        reports what other accounts are doing. It is not advice, it does not know your risk
        tolerance, and copying a profitable trader still loses money when you copy them into the
        wrong size. Past profit is not a promise about the next trade.
      </footer>

      <AskPanel open={asking} onClose={() => setAsking(false)} context={askContext} />

      {open && (
        <Sheet
          title={`${open.coin} ${open.side}`}
          subtitle={`${open.sector} · ${open.withCount} traders in, ${usd(open.withNotional)} of notional, ${open.entryScore}/100 entry score`}
          onClose={() => setOpen(null)}
        >
          <Analysis row={open} />
          <Detail row={open} />
        </Sheet>
      )}
    </main>
  );
}

/* -------------------------------------------------------------------------- */

function Detail({ row }: { row: Consensus }) {
  return (
    <>
      {/* Every factor, with its own sentence. A single risk number is only
          useful if you can see which part of it you disagree with. */}
      <p className="t-label mb-2">What it costs you if this is wrong</p>
      <div className="material mb-4 p-4">
        <div className="flex items-center gap-3">
          <span
            className="tnum text-2xl leading-none font-bold tracking-tight"
            style={{ color: riskColor(row.risk.score) }}
          >
            {row.risk.score}
          </span>
          <div className="min-w-0 flex-1">
            <p className="t-title" style={{ color: riskColor(row.risk.score) }}>
              {row.risk.band} risk
            </p>
            <span className="meter mt-1.5">
              <i style={{ width: `${row.risk.score}%`, background: riskColor(row.risk.score) }} />
            </span>
          </div>
        </div>

        <ul className="mt-3 space-y-2">
          {row.risk.drivers.map((d) => (
            <li key={d.key} className="flex items-baseline gap-2.5">
              <span
                className="mt-1 h-1.5 w-1.5 flex-none rounded-full"
                style={{ background: riskColor(d.level * 100) }}
              />
              <span className="t-caption flex-1">{d.note}</span>
            </li>
          ))}
        </ul>
      </div>

      <p className="t-label mb-2">Who is in it</p>
      <div className="grid grid-cols-2 gap-4 pb-3 sm:grid-cols-4">
        <Stat k="Price now" v={px(row.price)} />
        <Stat k="Group entry" v={px(row.avgEntry)} />
        <Stat k="Your edge" v={pct(row.edgeVsGroup)} tone={tone(row.edgeVsGroup)} />
        <Stat k="Avg leverage" v={`${row.avgLeverage.toFixed(1)}x`} />
      </div>

      <p className="t-caption mb-3">
        On average these traders put {(row.avgCommitment * 100).toFixed(0)}% of their account into
        this position.{" "}
        {row.againstCount > 0
          ? `${row.againstCount} qualifying ${row.againstCount === 1 ? "trader is" : "traders are"} on the opposite side with ${usd(row.againstNotional)}.`
          : "No qualifying trader is on the other side."}
      </p>

      <table className="dtable w-full text-left">
        <thead className="sticky">
          <tr className="t-label">
            <th className="py-2 pr-3 font-semibold">Account</th>
            <th className="py-2 pr-3 text-right font-semibold">Notional</th>
            <th className="py-2 pr-3 text-right font-semibold">Entry</th>
            <th className="py-2 pr-3 text-right font-semibold">Lev</th>
            <th className="py-2 pr-3 text-right font-semibold">Of book</th>
            <th className="py-2 pr-3 text-right font-semibold">Liq</th>
            <th className="py-2 pr-1 text-right font-semibold">ROE</th>
          </tr>
        </thead>
        <tbody>
          {row.legs.map((l) => (
            <tr key={l.address} className="t-caption">
              <td className="py-2 pr-3">
                <a
                  href={`https://app.hyperliquid.xyz/explorer/address/${l.address}`}
                  target="_blank"
                  rel="noreferrer"
                  className="tnum hover:underline"
                  style={{ color: "var(--accent)" }}
                >
                  {l.name ?? short(l.address)}
                </a>
              </td>
              <td className="tnum py-2 pr-3 text-right">{usd(l.notional)}</td>
              <td className="tnum py-2 pr-3 text-right">{px(l.entry)}</td>
              <td className="tnum py-2 pr-3 text-right">{l.leverage.toFixed(0)}x</td>
              <td className="tnum py-2 pr-3 text-right">{(l.commitment * 100).toFixed(0)}%</td>
              <td className="tnum py-2 pr-3 text-right">
                {l.liquidation == null ? (
                  <span style={{ color: "var(--text-3)" }} title="Cross margined with room to spare">
                    none
                  </span>
                ) : (
                  px(l.liquidation)
                )}
              </td>
              <td className="tnum py-2 pr-1 text-right" style={{ color: tone(l.roe) }}>
                {pct(l.roe * 100, 1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Stat({ k, v, tone, hint }: { k: string; v: string; tone?: string; hint?: string }) {
  return (
    <div>
      <p className="t-label">{k}</p>
      <p className="tnum text-lg font-semibold tracking-tight" style={tone ? { color: tone } : undefined}>
        {v}
      </p>
      {hint && <p className="t-caption max-w-44">{hint}</p>}
    </div>
  );
}

function Skeletons() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {Array.from({ length: 4 }, (_, i) => (
        <div key={i} className="material h-44 animate-pulse" />
      ))}
    </div>
  );
}
