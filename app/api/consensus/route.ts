import { NextRequest } from "next/server";
import { fetchBooks, leaderboard, mids } from "@/lib/hyperliquid";
import {
  allLegs,
  cohortStats,
  consensus,
  DEFAULT_FILTER,
  FILTERS,
  qualify,
  type Consensus,
  type Ranked,
} from "@/lib/consensus";
import { sectorMix } from "@/lib/categories";

export const dynamic = "force-dynamic";
// The cohort scan issues one request per trader, so give it room on a cold hit.
export const maxDuration = 60;

export type TraderRow = {
  address: string;
  name: string | null;
  accountValue: number;
  allTimePnl: number;
  allTimeRoi: number;
  monthPnl: number;
  monthRoi: number;
  weekRoi: number;
  weight: number;
  consistency: number;
  openCount: number;
  openNotional: number;
};

export type ConsensusResponse = {
  filter: string;
  filterNote: string;
  qualified: number; // how many accounts cleared the bar, before the cohort cap
  scanned: number; // how many of them actually answered
  active: number; // how many of those hold anything right now
  rows: Consensus[];
  traders: TraderRow[];
  legs: ReturnType<typeof allLegs>;
  cohort: ReturnType<typeof cohortStats>;
  mix: ReturnType<typeof sectorMix>;
  asOf: number;
};

function traderRows(cohort: Ranked[], books: { address: string; positions: { notional: number }[] }[]): TraderRow[] {
  const held = new Map(books.map((b) => [b.address, b.positions]));
  return cohort
    .map((t) => {
      const positions = held.get(t.address) ?? [];
      return {
        address: t.address,
        name: t.name,
        accountValue: t.accountValue,
        allTimePnl: t.perf.allTime.pnl,
        allTimeRoi: t.perf.allTime.roi,
        monthPnl: t.perf.month.pnl,
        monthRoi: t.perf.month.roi,
        weekRoi: t.perf.week.roi,
        weight: t.weight,
        consistency: t.consistency,
        openCount: positions.length,
        openNotional: positions.reduce((s, p) => s + p.notional, 0),
      };
    })
    .sort((a, b) => b.openNotional - a.openNotional);
}

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get("filter") ?? DEFAULT_FILTER;
  const preset = FILTERS[key] ?? FILTERS[DEFAULT_FILTER];

  try {
    const [traders, prices] = await Promise.all([leaderboard(), mids()]);

    const passing = traders.filter(
      (t) =>
        t.perf.allTime.pnl >= preset.filter.minAllTimePnl &&
        t.perf.allTime.roi >= preset.filter.minAllTimeRoi &&
        t.accountValue >= preset.filter.minAccountValue,
    );
    const cohort = qualify(traders, preset.filter);
    const books = await fetchBooks(cohort.map((t) => t.address));
    const rows = consensus(cohort, books, prices);

    const body: ConsensusResponse = {
      filter: key in FILTERS ? key : DEFAULT_FILTER,
      filterNote: preset.note,
      qualified: passing.length,
      scanned: books.length,
      active: books.filter((b) => b.positions.length > 0).length,
      rows,
      traders: traderRows(cohort, books),
      legs: allLegs(cohort, books),
      cohort: cohortStats(cohort, new Set(books.filter((b) => b.positions.length).map((b) => b.address))),
      // Concentration is measured over the rows a reader will actually act on,
      // not over the long tail of single trader coins that never render.
      mix: sectorMix(rows.filter((r) => r.withCount >= 2).map((r) => r.coin)),
      asOf: Date.now(),
    };
    return Response.json(body);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : "Consensus scan failed" },
      { status: 502 },
    );
  }
}
