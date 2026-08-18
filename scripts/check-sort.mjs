/**
 * Self-check for lib/sort.ts.
 *
 * The three state cycle is the part worth pinning: the third click has to
 * restore the server's order, and a refactor to a plain toggle would drop that
 * state silently while every other behaviour still looked correct.
 *
 *   node scripts/check-sort.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(mkdtempSync(join(tmpdir(), "tradecker-sort-")), "build");

execFileSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "lib", "sort.ts"),
    "--outDir", build,
    "--module", "commonjs",
    "--target", "es2022",
    "--strict",
    "--skipLibCheck",
    "--noCheck",
  ],
  { stdio: "inherit" },
);

const { nextSort, sortRows, sortGlyph, ariaSort, NO_SORT } =
  createRequire(import.meta.url)(join(build, "sort.js"));

/* ------------------------------------------------------------- the cycle */

{
  const a = nextSort(NO_SORT, "equity");
  assert.deepEqual(a, { key: "equity", dir: "desc" }, "first click is highest first");

  const b = nextSort(a, "equity");
  assert.deepEqual(b, { key: "equity", dir: "asc" }, "second click flips it");

  const c = nextSort(b, "equity");
  assert.equal(c.key, null, "third click resets to the default order");

  const d = nextSort(c, "equity");
  assert.deepEqual(d, { key: "equity", dir: "desc" }, "and the cycle starts over");

  // A different column starts fresh rather than inheriting the direction.
  const other = nextSort({ key: "equity", dir: "asc" }, "roi");
  assert.deepEqual(other, { key: "roi", dir: "desc" }, "a new column begins at highest first");
}

/* -------------------------------------------------------------- ordering */

const rows = [
  { name: "beta", equity: 10 },
  { name: "Alpha", equity: 300 },
  { name: "gamma", equity: 50 },
];
const value = (r, k) => r[k];

{
  const untouched = sortRows(rows, NO_SORT, value);
  assert.equal(untouched, rows, "no sort returns the original array, not a copy");

  const desc = sortRows(rows, { key: "equity", dir: "desc" }, value);
  assert.deepEqual(desc.map((r) => r.equity), [300, 50, 10]);
  assert.deepEqual(rows.map((r) => r.equity), [10, 300, 50], "the input is never mutated");

  const asc = sortRows(rows, { key: "equity", dir: "asc" }, value);
  assert.deepEqual(asc.map((r) => r.equity), [10, 50, 300]);

  // Case must not decide the order, or "Alpha" sorts before "beta" for the
  // wrong reason and a lowercase display name lands in a strange place.
  const byName = sortRows(rows, { key: "name", dir: "asc" }, value);
  assert.deepEqual(byName.map((r) => r.name), ["Alpha", "beta", "gamma"]);
}

{
  // A missing value is not a small value. It sinks in both directions, so an
  // ascending sort never opens with a wall of blanks.
  const holes = [
    { v: 5 },
    { v: null },
    { v: 20 },
    { v: NaN },
    { v: undefined },
  ];
  const val = (r) => r.v;
  const desc = sortRows(holes, { key: "v", dir: "desc" }, val);
  assert.deepEqual(desc.slice(0, 2).map((r) => r.v), [20, 5]);
  const asc = sortRows(holes, { key: "v", dir: "asc" }, val);
  assert.deepEqual(asc.slice(0, 2).map((r) => r.v), [5, 20], "real values lead in both directions");
}

/* ------------------------------------------------------------ affordance */

{
  assert.equal(sortGlyph({ key: "equity", dir: "desc" }, "equity"), "↓");
  assert.equal(sortGlyph({ key: "equity", dir: "asc" }, "equity"), "↑");
  assert.equal(sortGlyph({ key: "equity", dir: "asc" }, "roi"), "", "inactive columns show nothing");
  assert.equal(sortGlyph(NO_SORT, "equity"), "");

  assert.equal(ariaSort({ key: "equity", dir: "desc" }, "equity"), "descending");
  assert.equal(ariaSort({ key: "equity", dir: "asc" }, "equity"), "ascending");
  assert.equal(ariaSort(NO_SORT, "equity"), "none");
}

console.log("sort self-check passed");
