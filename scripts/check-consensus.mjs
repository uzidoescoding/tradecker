/**
 * Self-check for lib/consensus.ts and the two parsers in lib/hyperliquid.ts.
 *
 * The property that matters most is the breadth gate: a single enormous whale
 * must NOT outscore a broad group, because the whole point of the product is
 * correlation across independent traders rather than one loud position. That is
 * exactly the behaviour a well meaning "just weight by notional" refactor would
 * quietly destroy, so it is pinned here.
 *
 *   node scripts/check-consensus.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(mkdtempSync(join(tmpdir(), "tradecker-")), "build");

execFileSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "lib", "consensus.ts"),
    join(ROOT, "lib", "hyperliquid.ts"),
    "--outDir", build,
    "--module", "commonjs",
    "--target", "es2022",
    "--moduleResolution", "node",
    "--strict",
    "--skipLibCheck",
    // next build is what typechecks these files against the framework types;
    // this script only needs the emitted JS, and a standalone tsc has no idea
    // what `next: { revalidate }` on a fetch init means.
    "--noCheck",
  ],
  { stdio: "inherit" },
);

const require = createRequire(import.meta.url);
const { weigh, qualify, consensus, FILTERS } = require(join(build, "consensus.js"));
const { parseLeaderboard, parseBook } = require(join(build, "hyperliquid.js"));

/* ------------------------------------------------------------------ helpers */

const trader = (address, pnl, roi, accountValue, { week = pnl, month = pnl } = {}) => ({
  address,
  name: null,
  accountValue,
  perf: {
    day: { pnl: 0, roi: 0, vlm: 0 },
    week: { pnl: week, roi: 0, vlm: 0 },
    month: { pnl: month, roi: 0, vlm: 0 },
    allTime: { pnl, roi, vlm: 0 },
  },
});

const pos = (coin, side, notional, entry, { pnl = 0, leverage = 5 } = {}) => ({
  coin,
  side,
  size: notional / entry,
  notional,
  entry,
  leverage,
  unrealizedPnl: pnl,
  roe: 0,
  liquidation: null,
});

const book = (address, accountValue, positions) => ({ address, accountValue, positions });

/* -------------------------------------------------------------------- parse */

{
  const parsed = parseLeaderboard({
    leaderboardRows: [
      {
        ethAddress: "0xABCDEF0000000000000000000000000000000001",
        accountValue: "1234.5",
        displayName: null,
        windowPerformances: [
          ["day", { pnl: "1", roi: "0.1", vlm: "10" }],
          ["week", { pnl: "2", roi: "0.2", vlm: "20" }],
          ["month", { pnl: "3", roi: "0.3", vlm: "30" }],
          ["allTime", { pnl: "4", roi: "0.4", vlm: "40" }],
        ],
      },
    ],
  });
  assert.equal(parsed[0].address, "0xabcdef0000000000000000000000000000000001", "address is lowercased for map lookups");
  assert.equal(parsed[0].accountValue, 1234.5);
  assert.equal(parsed[0].perf.allTime.roi, 0.4);

  // A row missing a window must not produce NaN downstream.
  const sparse = parseLeaderboard({
    leaderboardRows: [
      { ethAddress: "0x02", accountValue: "0", displayName: null, windowPerformances: [] },
    ],
  });
  assert.equal(sparse[0].perf.month.pnl, 0);
  assert.ok(Number.isFinite(weigh(sparse[0]).weight));
}

{
  const parsed = parseBook("0x03", {
    marginSummary: { accountValue: "1000" },
    assetPositions: [
      { position: { coin: "BTC", szi: "1.5", entryPx: "60000", leverage: { value: 3 }, positionValue: "90000", unrealizedPnl: "500", returnOnEquity: "0.1", liquidationPx: "40000" } },
      { position: { coin: "ETH", szi: "-10", entryPx: "2000", leverage: { value: 5 }, positionValue: "20000", unrealizedPnl: "-100", returnOnEquity: "-0.02", liquidationPx: null } },
      // A closed leg still shows up in the payload; it must be dropped or it
      // inflates every breadth count with positions nobody actually holds.
      { position: { coin: "SOL", szi: "0", entryPx: "100", leverage: { value: 2 }, positionValue: "0", unrealizedPnl: "0", returnOnEquity: "0", liquidationPx: null } },
    ],
  });
  assert.equal(parsed.positions.length, 2, "zero size positions are dropped");
  assert.equal(parsed.positions[0].side, "long");
  assert.equal(parsed.positions[1].side, "short", "negative szi is a short");
  assert.equal(parsed.positions[1].size, 10, "size is absolute");
  assert.equal(parsed.positions[1].liquidation, null, "no liquidation price stays null, not 0");
}

/* ------------------------------------------------------------------- weight */

{
  const steady = weigh(trader("0xa", 1_000_000, 1.0, 500_000));
  const oneShot = weigh(trader("0xb", 1_000_000, 1.0, 500_000, { week: -50, month: -50 }));
  assert.ok(steady.weight > oneShot.weight, "green in every window outweighs a single lifetime spike");
  assert.equal(steady.consistency, 1);
  assert.ok(Math.abs(oneShot.consistency - 1 / 3) < 1e-9);

  const big = weigh(trader("0xc", 100_000_000, 1.0, 1e6));
  const small = weigh(trader("0xd", 1_000_000, 1.0, 1e6));
  assert.ok(big.weight > small.weight, "more lifetime profit is worth more");
  assert.ok(big.weight < small.weight * 3, "but 100x the profit is not worth 100x the vote");

  const capped = weigh(trader("0xe", 1_000_000, 40, 1e6));
  const sane = weigh(trader("0xf", 1_000_000, 3, 1e6));
  assert.equal(capped.weight, sane.weight, "absurd ROI is capped, a 40x is a small bankroll not a genius");
}

/* ----------------------------------------------------------------- qualify */

{
  const pool = [
    trader("0x1", 5_000_000, 2.0, 1_000_000), // passes
    trader("0x2", 100_000, 2.0, 1_000_000),   // fails pnl
    trader("0x3", 5_000_000, 0.1, 1_000_000), // fails roi
    trader("0x4", 5_000_000, 2.0, 1_000),     // fails account value
    trader("0x5", 2_000_000, 1.5, 500_000),   // passes
  ];
  const out = qualify(pool, FILTERS.strict.filter);
  assert.deepEqual(out.map((t) => t.address), ["0x1", "0x5"], "only long term winners with skin in the game, ranked by weight");

  const capped = qualify(pool, { ...FILTERS.strict.filter, cohort: 1 });
  assert.equal(capped.length, 1, "cohort caps the scan");
}

/* --------------------------------------------------------------- consensus */

const spread = (n, coin, side, notional, entry, opts) =>
  Array.from({ length: n }, (_, i) => book(`0x${i + 1}`, 1_000_000, [pos(coin, side, notional, entry, opts)]));

{
  // The headline property. One whale at 100x the size must lose to a group.
  const cohort = qualify(
    [
      trader("0xwhale", 200_000_000, 2, 50_000_000),
      ...Array.from({ length: 10 }, (_, i) => trader(`0x${i + 1}`, 2_000_000, 1.5, 1_000_000)),
    ],
    FILTERS.strict.filter,
  );
  const books = [
    book("0xwhale", 50_000_000, [pos("SOLO", "long", 40_000_000, 100)]),
    ...spread(10, "GROUP", "long", 200_000, 100),
  ];
  const rows = consensus(cohort, books, { SOLO: 100, GROUP: 100 });
  const solo = rows.find((r) => r.coin === "SOLO");
  const group = rows.find((r) => r.coin === "GROUP");

  assert.ok(group.score > solo.score, "ten traders beat one whale even at 1/200th the notional");
  assert.equal(group.score, 100, "ten unanimous traders is a full score");
  assert.ok(solo.score <= 20, `one trader is capped by breadth, got ${solo.score}`);
  assert.ok(solo.withNotional > group.withNotional, "and the whale is still visibly the bigger position");
}

{
  // Broad but evenly split has to score near zero, no matter the size.
  const cohort = qualify(
    Array.from({ length: 12 }, (_, i) => trader(`0x${i + 1}`, 2_000_000, 1.5, 1_000_000)),
    FILTERS.strict.filter,
  );
  const books = [
    ...spread(6, "SPLIT", "long", 100_000, 100).map((b, i) => book(`0x${i + 1}`, 1e6, b.positions)),
    ...Array.from({ length: 6 }, (_, i) => book(`0x${i + 7}`, 1e6, [pos("SPLIT", "short", 100_000, 100)])),
  ];
  const [row] = consensus(cohort, books, { SPLIT: 100 });
  assert.ok(Math.abs(row.agreement - 0.5) < 1e-9, "identical traders on both sides is a dead heat");
  assert.equal(row.score, 0, "a coin the cohort disagrees about is not a trade");
  assert.equal(row.againstCount, 6, "the other side stays visible");
}

{
  // Entry edge and staleness, both directions.
  const cohort = qualify(
    Array.from({ length: 8 }, (_, i) => trader(`0x${i + 1}`, 2_000_000, 1.5, 1_000_000)),
    FILTERS.strict.filter,
  );
  const longs = Array.from({ length: 8 }, (_, i) => book(`0x${i + 1}`, 1e6, [pos("L", "long", 100_000, 100, { pnl: 10_000 })]));
  const [cheap] = consensus(cohort, longs, { L: 90 });
  assert.ok(cheap.edgeVsGroup > 9, "price below the group's long entry is a better entry");
  const [dear] = consensus(cohort, longs, { L: 110 });
  assert.ok(dear.edgeVsGroup < -9, "price above it is a worse entry");
  assert.ok(dear.flags.includes("Worse entry"));

  const shorts = Array.from({ length: 8 }, (_, i) => book(`0x${i + 1}`, 1e6, [pos("S", "short", 100_000, 100)]));
  const [shortCheap] = consensus(cohort, shorts, { S: 110 });
  assert.ok(shortCheap.edgeVsGroup > 9, "for a short, price ABOVE the group entry is the better entry");

  assert.ok(cheap.flags.includes("Late"), "a group already 10% up on notional is late to copy");
  const fresh = Array.from({ length: 8 }, (_, i) => book(`0x${i + 1}`, 1e6, [pos("F", "long", 100_000, 100, { pnl: 100 })]));
  assert.ok(consensus(cohort, fresh, { F: 100 })[0].flags.includes("Fresh"));
}

{
  // Weighted averages must be notional weighted, not a plain mean, or one tiny
  // position at a silly entry drags the group's average entry around.
  const cohort = qualify(
    Array.from({ length: 8 }, (_, i) => trader(`0x${i + 1}`, 2_000_000, 1.5, 1_000_000)),
    FILTERS.strict.filter,
  );
  const books = [
    book("0x1", 1e6, [pos("W", "long", 990_000, 100)]),
    ...Array.from({ length: 7 }, (_, i) => book(`0x${i + 2}`, 1e6, [pos("W", "long", 1_000, 500)])),
  ];
  const [row] = consensus(cohort, books, { W: 100 });
  assert.ok(row.avgEntry < 105, `avg entry should track the money, got ${row.avgEntry}`);
}

{
  // Books from accounts outside the cohort must be ignored, not silently
  // counted with a zero weight, which would inflate breadth for free.
  const cohort = qualify([trader("0x1", 2_000_000, 1.5, 1_000_000)], FILTERS.strict.filter);
  const rows = consensus(cohort, [book("0xstranger", 1e6, [pos("X", "long", 1e6, 100)])], { X: 100 });
  assert.equal(rows.length, 0, "an unranked account contributes nothing");
}

{
  // A missing price must not produce NaN anywhere in the row.
  const cohort = qualify(
    Array.from({ length: 8 }, (_, i) => trader(`0x${i + 1}`, 2_000_000, 1.5, 1_000_000)),
    FILTERS.strict.filter,
  );
  const books = Array.from({ length: 8 }, (_, i) => book(`0x${i + 1}`, 1e6, [pos("NEW", "long", 1000, 5)]));
  const [row] = consensus(cohort, books, {});
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} is NaN when the price feed has no mid`);
  }
}

{
  // Ranking is by entry score, not raw agreement. A group that agrees just as
  // hard but is already deep in profit has to rank below a fresh one, or the
  // top of the page fills up with trades that already happened.
  const cohort = qualify(
    Array.from({ length: 8 }, (_, i) => trader(`0x${i + 1}`, 2_000_000, 1.5, 1_000_000)),
    FILTERS.strict.filter,
  );
  const books = Array.from({ length: 8 }, (_, i) =>
    book(`0x${i + 1}`, 1e6, [
      pos("STALE", "long", 100_000, 100, { pnl: 60_000 }), // +60% on notional
      pos("FRESH", "long", 100_000, 100, { pnl: 200 }),    // basically at entry
    ]),
  );
  const rows = consensus(cohort, books, { STALE: 160, FRESH: 100 });
  const stale = rows.find((r) => r.coin === "STALE");
  const fresh = rows.find((r) => r.coin === "FRESH");

  assert.equal(stale.score, fresh.score, "both groups agree exactly as hard");
  assert.ok(fresh.entryScore > stale.entryScore, "but the fresh one is the better entry");
  assert.equal(rows[0].coin, "FRESH", "and it sorts first");
  assert.ok(stale.freshness >= 0.1, "a stale trade keeps a floor, agreement is still information");
  assert.ok(fresh.freshness > 0.98, "a group still at its entry has essentially the whole move ahead");

  // A group underwater counts as fresh: you would be entering better than them.
  const under = Array.from({ length: 8 }, (_, i) =>
    book(`0x${i + 1}`, 1e6, [pos("DOWN", "long", 100_000, 100, { pnl: -30_000 })]),
  );
  assert.equal(consensus(cohort, under, { DOWN: 70 })[0].freshness, 1);

}

console.log("consensus self-check passed");
