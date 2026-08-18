/**
 * Self-check for lib/risk.ts.
 *
 * The property that matters most: a factor with no data must be dropped and the
 * remaining weights renormalised, never scored as zero. Missing liquidation
 * prices are common, and "unknown" quietly becoming "safe" is the single most
 * dangerous way for a risk number to be wrong.
 *
 *   node scripts/check-risk.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(mkdtempSync(join(tmpdir(), "tradecker-risk-")), "build");

execFileSync(
  process.execPath,
  [
    join(ROOT, "node_modules", "typescript", "bin", "tsc"),
    join(ROOT, "lib", "risk.ts"),
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

const { assess, band } = createRequire(import.meta.url)(join(build, "risk.js"));

const leg = (notional, leverage, liquidation = null) => ({ notional, leverage, liquidation });

/** A deliberately mild baseline every case below varies one axis away from. */
const calm = {
  side: "long",
  price: 100,
  agreement: 1,
  groupPnlPct: 0,
  sector: "Major",
  legs: [leg(1000, 2), leg(1000, 2), leg(1000, 2), leg(1000, 2)],
};

const level = (r, key) => r.drivers.find((d) => d.key === key)?.level;

/* ---------------------------------------------------------------- bands */

{
  assert.equal(band(0), "Low");
  assert.equal(band(24), "Low");
  assert.equal(band(25), "Moderate");
  assert.equal(band(44), "Moderate");
  assert.equal(band(45), "High");
  assert.equal(band(64), "High");
  assert.equal(band(65), "Severe");
  assert.equal(band(100), "Severe");
}

/* -------------------------------------------------- each factor moves it */

{
  const base = assess(calm);
  assert.ok(base.score < 25, `an even, unlevered, unanimous major should be low, got ${base.score}`);
  assert.ok(base.score > 0, "but never zero, nothing is risk free");

  const levered = assess({ ...calm, legs: calm.legs.map(() => leg(1000, 25)) });
  assert.ok(levered.score > base.score, "more leverage is more risk");
  assert.equal(level(levered, "leverage"), 1, "25x is the ceiling on that axis");

  const split = assess({ ...calm, agreement: 0.5 });
  assert.ok(split.score > base.score, "a dead heat is riskier than unanimity");
  assert.equal(level(split, "dissent"), 1);

  const stale = assess({ ...calm, groupPnlPct: 40 });
  assert.ok(stale.score > base.score, "a move already spent is riskier to copy");
  assert.equal(level(stale, "staleness"), 1);

  const meme = assess({ ...calm, sector: "Meme" });
  assert.ok(meme.score > base.score, "a memecoin does not start where a major starts");
  assert.ok(level(meme, "sector") > level(base, "sector"));

  const whale = assess({ ...calm, legs: [leg(97_000, 2), leg(1000, 2), leg(1000, 2), leg(1000, 2)] });
  assert.ok(whale.score > base.score, "one account carrying the position is a risk");
  assert.ok(level(whale, "concentration") > 0.9);

  const solo = assess({ ...calm, legs: [leg(1000, 2)] });
  assert.equal(level(solo, "concentration"), 1, "a single leg is total concentration");
  assert.match(solo.drivers.find((d) => d.key === "concentration").note, /entire position/);
}

/* --------------------------------------------------- the renormalisation */

{
  // The headline property. Two identical inputs, one with liquidation prices
  // reported and one without, must not differ just because data was missing.
  const noLiq = assess(calm);
  assert.equal(level(noLiq, "liquidation"), undefined, "absent data contributes no factor at all");
  assert.ok(
    !noLiq.drivers.some((d) => d.key === "liquidation"),
    "and is not reported as a driver either",
  );

  // A far away liquidation is genuinely safe, so it should barely move the score.
  const farLiq = assess({ ...calm, legs: calm.legs.map(() => leg(1000, 2, 40)) });
  assert.equal(level(farLiq, "liquidation"), 0, "60% away is outside the pressure window");
  assert.ok(
    Math.abs(farLiq.score - noLiq.score) <= 3,
    `a safe liquidation should not swing the score, got ${noLiq.score} vs ${farLiq.score}`,
  );

  // A close one must.
  const nearLiq = assess({ ...calm, legs: calm.legs.map(() => leg(1000, 2, 97)) });
  assert.ok(level(nearLiq, "liquidation") > 0.9, "3% away is near maximum pressure");
  assert.ok(nearLiq.score > noLiq.score + 10, "and it has to actually move the number");
  assert.match(nearLiq.drivers[0].note, /cascade/, "the worst driver leads and explains itself");

  // Only the nearest leg matters: one account on the edge is the cascade risk,
  // even if everyone else is comfortable.
  const oneEdge = assess({
    ...calm,
    legs: [leg(1000, 2, 20), leg(1000, 2, 20), leg(1000, 2, 20), leg(1000, 2, 98)],
  });
  assert.ok(level(oneEdge, "liquidation") > 0.9, "the closest forced exit sets the level");

  // Junk liquidation values are ignored rather than believed.
  const junk = assess({ ...calm, legs: [leg(1000, 2, 0), leg(1000, 2, NaN), leg(1000, 2, -5)] });
  assert.equal(level(junk, "liquidation"), undefined, "zero, NaN and negative are not prices");
}

/* --------------------------------------------------------- shape and edges */

{
  const worst = assess({
    side: "long",
    price: 100,
    agreement: 0.5,
    groupPnlPct: 100,
    sector: "Meme",
    legs: [leg(1000, 40, 99)],
  });
  assert.equal(worst.band, "Severe");
  assert.ok(worst.score > 85, `everything wrong at once should be near the top, got ${worst.score}`);

  // Empty and degenerate inputs must not produce NaN or throw. A coin with no
  // legs should never reach here, but a risk number that crashes the card is
  // worse than one that is merely uninformative.
  for (const bad of [
    { ...calm, legs: [] },
    { ...calm, price: 0 },
    { ...calm, legs: [leg(0, 0)] },
    { ...calm, agreement: NaN, groupPnlPct: NaN },
    { ...calm, sector: "NotASector" },
  ]) {
    const r = assess(bad);
    assert.ok(Number.isFinite(r.score), `score went non-finite on ${JSON.stringify(bad.legs)}`);
    assert.ok(r.score >= 0 && r.score <= 100, `score out of range: ${r.score}`);
    assert.ok(["Low", "Moderate", "High", "Severe"].includes(r.band));
    for (const d of r.drivers) {
      assert.ok(Number.isFinite(d.level), `${d.key} level went non-finite`);
      assert.ok(d.note.length > 0, `${d.key} has no explanation`);
    }
  }

  // Drivers are ranked by contribution, not by raw level: a bad score on a
  // lightly weighted axis must not outrank a moderate one on a heavy axis.
  const r = assess({ ...calm, sector: "Meme", legs: calm.legs.map(() => leg(1000, 25)) });
  assert.equal(r.drivers[0].key, "leverage", "leverage outweighs sector at equal badness");
}

console.log("risk self-check passed");
