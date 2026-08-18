/**
 * Self-check for lib/levels.ts and lib/categories.ts.
 *
 * levels.ts is the file that decides where a stop goes. Everything a language
 * model proposes passes through `reconcile`, so the cases below are written
 * from the assumption that the model will eventually return a stop on the wrong
 * side of entry, unordered targets, and a NaN, because it will.
 *
 *   node scripts/check-levels.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(mkdtempSync(join(tmpdir(), "tradecker-levels-")), "build");

execFileSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "lib", "levels.ts"),
    join(ROOT, "lib", "categories.ts"),
    "--outDir", build,
    "--module", "commonjs",
    "--target", "es2022",
    "--moduleResolution", "node",
    "--strict",
    "--skipLibCheck",
    "--noCheck",
  ],
  { stdio: "inherit" },
);

const require = createRequire(import.meta.url);
const { atr, atrPct, drift, scaffold, reconcile } = require(join(build, "levels.js"));
const { sector, assetClass, baseTicker, sectorMix } = require(join(build, "categories.js"));

/* --------------------------------------------------------------------- atr */

const bar = (o, h, l, c) => ({ t: 0, o, h, l, c, v: 1 });

{
  assert.equal(atr([]), 0, "no candles cannot produce a range");
  assert.equal(atr([bar(1, 1, 1, 1)]), 0, "one candle has no previous close to compare to");

  // Ten identical 10-wide bars: true range is 10 every bar, so ATR is 10.
  const flat = Array.from({ length: 20 }, () => bar(100, 105, 95, 100));
  assert.ok(Math.abs(atr(flat) - 10) < 1e-9, `constant range gives that range, got ${atr(flat)}`);

  // A gap counts: the move from the previous close is the true range, not just
  // the bar's own high minus low. This is the whole reason for using ATR.
  const gapped = [bar(100, 100, 100, 100), bar(150, 151, 149, 150)];
  assert.ok(atr(gapped) >= 50, `a 50 point gap must register, got ${atr(gapped)}`);

  assert.equal(atrPct(flat), 10, "10 wide on a 100 price is 10%");
  assert.equal(atrPct([]), 0);

  const up = Array.from({ length: 10 }, (_, i) => bar(100 + i, 100 + i, 100 + i, 100 + i));
  assert.ok(Math.abs(drift(up, 10) - 9) < 1e-9, `100 to 109 is +9%, got ${drift(up, 10)}`);
  assert.equal(drift([]), 0);
}

/* ---------------------------------------------------------------- scaffold */

{
  const long = scaffold("long", 100, 2); // ATR 2 -> stop 3 away (1.5x)
  assert.equal(long.stop, 97, "long stops below entry");
  assert.deepEqual(long.targets, [103, 106, 109], "targets are 1R, 2R, 3R above");
  assert.equal(long.risk, 3);
  assert.equal(long.rr, 3);

  const short = scaffold("short", 100, 2);
  assert.equal(short.stop, 103, "short stops above entry");
  assert.deepEqual(short.targets, [97, 94, 91], "and targets step down");

  // A coin with no candle history must still produce a usable plan. A zero
  // width stop would make risk zero, which makes reward/risk infinite and every
  // downstream percentage NaN.
  const cold = scaffold("long", 50, 0);
  assert.ok(cold.risk > 0, "no ATR still yields a real stop distance");
  assert.ok(Number.isFinite(cold.rr));

  // Absurd volatility is clamped: a stop 400% away is not a stop.
  const wild = scaffold("long", 100, 1000);
  assert.ok(wild.stop > 0, `stop must stay above zero, got ${wild.stop}`);
  assert.ok(wild.risk <= 25, `stop distance is capped, got ${wild.risk}`);

  // ...and so is the opposite, a stop inside the spread.
  const dead = scaffold("long", 100, 0.0001);
  assert.ok(dead.risk >= 0.3, `stop distance has a floor, got ${dead.risk}`);
}

/* --------------------------------------------------------------- reconcile */

const base = scaffold("long", 100, 2); // entry 100, stop 97, targets 103/106/109

{
  const { plan, rejected } = reconcile(base, null);
  assert.deepEqual(plan, base, "no proposal means the scaffold stands");
  assert.deepEqual(rejected, []);
}

{
  // A sane adjustment is accepted as given.
  const { plan, rejected } = reconcile(base, {
    side: "long", entry: 99.5, stop: 96, targets: [104, 108],
  });
  assert.equal(plan.entry, 99.5);
  assert.equal(plan.stop, 96);
  assert.deepEqual(plan.targets, [104, 108]);
  assert.deepEqual(rejected, [], "nothing wrong with that plan");
  assert.equal(plan.risk, 3.5);
  assert.ok(Math.abs(plan.rr - 8.5 / 3.5) < 1e-9, "rr recomputed off the accepted levels");
}

{
  // The headline failure: a stop above entry on a long. It is not a difference
  // of opinion, it is a broken output, and it must never reach the screen.
  const { plan, rejected } = reconcile(base, { side: "long", stop: 105, targets: [103, 106] });
  assert.ok(plan.stop < plan.entry, `long stop must stay below entry, got ${plan.stop}`);
  assert.equal(plan.stop, base.stop, "and it falls back to the scaffold");
  assert.ok(rejected.includes("stop"), "the rejection is reported, not hidden");
  assert.deepEqual(plan.targets, [103, 106], "a good field survives a bad one");
}

{
  const shortBase = scaffold("short", 100, 2);
  const { plan, rejected } = reconcile(shortBase, { side: "short", stop: 95 });
  assert.equal(plan.stop, shortBase.stop, "a short stop below entry is equally broken");
  assert.ok(rejected.includes("stop"));
}

{
  // Targets that are not in increasing distance make "TP1, TP2" meaningless.
  const { plan, rejected } = reconcile(base, { targets: [106, 103, 109] });
  assert.deepEqual(plan.targets, base.targets, "unordered targets are dropped wholesale");
  assert.ok(rejected.includes("targets"));

  // A target behind entry is not a target.
  const behind = reconcile(base, { targets: [99, 104] });
  assert.ok(behind.rejected.includes("targets"));
  assert.ok(behind.plan.targets.every((t) => t > behind.plan.entry));
}

{
  // Garbage of every shape must not crash or leak NaN.
  for (const junk of [
    { entry: NaN, stop: NaN, targets: [NaN] },
    { entry: 0, stop: -5, targets: [] },
    { entry: "100", stop: null, targets: "up" },
    { side: "sideways", entry: Infinity },
    {},
  ]) {
    const { plan } = reconcile(base, junk);
    for (const [k, v] of Object.entries(plan)) {
      if (typeof v === "number") assert.ok(Number.isFinite(v), `${k} went non-finite on ${JSON.stringify(junk)}`);
    }
    assert.ok(plan.targets.every(Number.isFinite), "targets stayed finite");
    assert.ok(plan.stop < plan.entry, "and the long stop stayed below entry");
    assert.ok(plan.risk > 0, "and risk stayed positive");
  }

  // Present but unusable is reported, not silently swallowed: "proposed
  // nothing" and "proposed garbage" are different things.
  assert.ok(reconcile(base, { stop: null }).rejected.includes("stop"));
  assert.deepEqual(reconcile(base, {}).rejected, [], "an empty proposal rejects nothing");

  // Models quote numbers as often as they emit them. A clean numeric string is
  // a quoting habit, not an error, so it is accepted.
  const quoted = reconcile(base, { entry: "99.5", stop: "96", targets: ["104", "108"] });
  assert.equal(quoted.plan.entry, 99.5);
  assert.equal(quoted.plan.stop, 96);
  assert.deepEqual(quoted.plan.targets, [104, 108]);
  assert.deepEqual(quoted.rejected, []);

  // The real observed failure: gpt-oss returned all three targets concatenated
  // into one string. It parses partially, it looks like a price, and it is not
  // any of the three numbers. This must never be salvaged.
  const blob = reconcile(base, { targets: ["44.3564422066267 44.1128844132533 43.8693266198"] });
  assert.deepEqual(blob.plan.targets, base.targets, "the concatenated blob falls back");
  assert.ok(blob.rejected.includes("targets"));
  const glued = reconcile(base, { targets: ["103.5106.2109.8"] });
  assert.deepEqual(glued.plan.targets, base.targets, "no decimal point salad either");
  assert.ok(glued.rejected.includes("targets"));

  // One bad element poisons the list: TP2 meaning "the second one that parsed"
  // is not what the model said it meant.
  const partial = reconcile(base, { targets: ["103", "oops", "109"] });
  assert.deepEqual(partial.plan.targets, base.targets);
  assert.ok(partial.rejected.includes("targets"));

  // A non-array targets value is reported rather than ignored.
  assert.ok(reconcile(base, { targets: "103, 106" }).rejected.includes("targets"));
}

{
  // An entry far from the live price is a different trade, not this one.
  const far = reconcile(base, { entry: 140 });
  assert.equal(far.plan.entry, base.entry);
  assert.ok(far.rejected.includes("entry"));

  // Moving the entry without giving a stop must move the stop with it, or the
  // risk silently changes.
  const moved = reconcile(base, { entry: 95 });
  assert.equal(moved.plan.entry, 95);
  assert.ok(Math.abs(moved.plan.risk - base.risk) < 1e-9, "risk travels with the entry");
  assert.equal(moved.plan.stop, 92);
}

{
  // A flipped side is allowed, the prompt invites disagreement, but the levels
  // must flip with it rather than keeping the long scaffold's geometry.
  const { plan, rejected } = reconcile(base, { side: "short" });
  assert.equal(plan.side, "short");
  assert.ok(plan.stop > plan.entry, "a short plan stops above entry");
  assert.ok(plan.targets.every((t) => t < plan.entry), "and targets sit below it");
  assert.ok(rejected.includes("side"), "the flip is surfaced so the UI can say so");
}

/* -------------------------------------------------------------- categories */

{
  assert.equal(baseTicker("kPEPE"), "PEPE", "the 1000x contract prefix is not part of the name");
  assert.equal(baseTicker("BTC"), "BTC");
  assert.equal(baseTicker("KAITO"), "KAITO", "a real ticker starting with K is left alone");

  assert.equal(sector("BTC"), "Major");
  assert.equal(sector("kPEPE"), "Meme", "the prefixed contract classifies as its underlying");
  assert.equal(sector("AAVE"), "DeFi");
  assert.equal(sector("XMR"), "Privacy");
  assert.equal(sector("PAXG"), "RWA");
  assert.equal(sector("NOTAREALCOIN"), "Other", "an unknown ticker is honestly unknown");

  assert.equal(assetClass("BTC"), "Crypto");
  assert.equal(assetClass("PAXG"), "Commodity", "tokenised gold is not a coin");

  const mix = sectorMix(["kPEPE", "WIF", "BONK", "BTC"]);
  assert.equal(mix[0].sector, "Meme", "the concentration is reported largest first");
  assert.equal(mix[0].count, 3);
  assert.ok(Math.abs(mix[0].share - 0.75) < 1e-9, "three of four coins is 75% of the board");
  assert.deepEqual(sectorMix([]), [], "an empty board has no concentration");
}

console.log("levels + categories self-check passed");
