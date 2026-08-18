"use client";

import { useMemo, useState } from "react";
import type { TraderRow } from "@/app/api/consensus/route";
import { pct, short, tone, usd } from "@/lib/fmt";
import { ariaSort, nextSort, NO_SORT, sortGlyph, sortRows, type Sort } from "@/lib/sort";

type Key =
  | "account"
  | "accountValue"
  | "allTimePnl"
  | "allTimeRoi"
  | "monthRoi"
  | "weekRoi"
  | "monthPnl"
  | "openNotional"
  | "weight";

const COLUMNS: { key: Key; label: string; right?: boolean }[] = [
  { key: "account", label: "Account" },
  { key: "accountValue", label: "Equity", right: true },
  { key: "allTimePnl", label: "Lifetime P&L", right: true },
  { key: "allTimeRoi", label: "Lifetime ROI", right: true },
  { key: "monthRoi", label: "30d ROI", right: true },
  { key: "weekRoi", label: "7d ROI", right: true },
  { key: "monthPnl", label: "30d P&L", right: true },
  { key: "openNotional", label: "Open", right: true },
  { key: "weight", label: "Vote", right: true },
];

/** Sorting on the account column means the label you can actually see. */
const valueOf = (t: TraderRow, key: Key) =>
  key === "account" ? (t.name ?? t.address) : t[key];

/**
 * The cohort itself. This panel exists so the consensus is auditable: every
 * score upstream is built from these accounts, and you can click through to
 * the account on Hyperliquid and check the claim.
 *
 * Columns sort in three states: highest first, lowest first, then back to the
 * server's default ranking by open notional.
 */
export default function TraderTable({ traders }: { traders: TraderRow[] }) {
  const [sort, setSort] = useState<Sort<Key>>(NO_SORT);

  const rows = useMemo(() => sortRows(traders, sort, valueOf), [traders, sort]);

  const active = COLUMNS.find((c) => c.key === sort.key);

  return (
    <div className="material flex min-h-0 flex-col p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="t-title">Who is voting</h3>
        <p className="t-caption">
          {traders.length} accounts,{" "}
          {active
            ? `${active.label.toLowerCase()} ${sort.dir === "desc" ? "high to low" : "low to high"}`
            : "heaviest book first"}
        </p>
      </div>

      <div className="scroll-panel mt-3 max-h-[26rem] min-h-0">
        <table className="dtable w-full text-left">
          <thead className="sticky">
            <tr className="t-label">
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  aria-sort={ariaSort(sort, c.key)}
                  className={`py-2 font-semibold ${c.key === "weight" ? "pr-1" : "pr-3"}`}
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => nextSort(s, c.key))}
                    className={`sort-th ${c.right ? "sort-th-right" : ""}`}
                    title={
                      sort.key !== c.key
                        ? `Sort by ${c.label}, highest first`
                        : sort.dir === "desc"
                          ? `Sort by ${c.label}, lowest first`
                          : "Back to the default order"
                    }
                  >
                    <span>{c.label}</span>
                    <span className="sort-glyph" aria-hidden>
                      {sortGlyph(sort, c.key)}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.address} className="t-caption">
                <td className="py-2 pr-3">
                  <a
                    href={`https://app.hyperliquid.xyz/explorer/address/${t.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="tnum hover:underline"
                    style={{ color: "var(--accent)" }}
                  >
                    {t.name ?? short(t.address)}
                  </a>
                </td>
                <td className="tnum py-2 pr-3 text-right">{usd(t.accountValue)}</td>
                <td className="tnum py-2 pr-3 text-right font-semibold" style={{ color: tone(t.allTimePnl) }}>
                  {usd(t.allTimePnl)}
                </td>
                <td className="tnum py-2 pr-3 text-right">{pct(t.allTimeRoi * 100, 0)}</td>
                <td className="tnum py-2 pr-3 text-right" style={{ color: tone(t.monthRoi) }}>
                  {pct(t.monthRoi * 100)}
                </td>
                <td className="tnum py-2 pr-3 text-right" style={{ color: tone(t.weekRoi) }}>
                  {pct(t.weekRoi * 100)}
                </td>
                <td className="tnum py-2 pr-3 text-right" style={{ color: tone(t.monthPnl) }}>
                  {usd(t.monthPnl)}
                </td>
                <td className="tnum py-2 pr-3 text-right">
                  {t.openCount === 0 ? (
                    <span style={{ color: "var(--text-3)" }}>flat</span>
                  ) : (
                    `${t.openCount} · ${usd(t.openNotional)}`
                  )}
                </td>
                <td className="tnum py-2 pr-1 text-right">{t.weight.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="t-caption mt-3">
        Click a column to sort it high to low, again for low to high, a third time to go back to
        the default. Vote weight is lifetime profit on a log scale, scaled by how many of the week,
        month and lifetime windows are green, and by lifetime ROI capped at 3x. Log, because the
        difference between $100k and $1M of profit is skill and the difference between $10M and
        $100M is mostly starting capital. Hyperliquid publishes day, week, month and lifetime
        windows only, so there is no yearly column to show: lifetime is the long run number and the
        30d is whether they are still good right now.
      </p>
    </div>
  );
}
