/**
 * Self-check for lib/text.ts. The substitutions are order dependent, so a
 * reordering that looks harmless can quietly reintroduce em-dashes.
 *
 *   node scripts/check-text.mjs
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const build = join(mkdtempSync(join(tmpdir(), "text-")), "build");

execFileSync(
  process.execPath,
  [join(ROOT, "node_modules", "typescript", "bin", "tsc"), join(ROOT, "lib", "text.ts"),
   "--outDir", build, "--module", "commonjs", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { cleanProse } = createRequire(import.meta.url)(join(build, "text.js"));

const cases = [
  // the bug this was written for: an em-dash with no surrounding spaces
  ["different technical basis—EMA crossovers work", "different technical basis, EMA crossovers work"],
  ["a spaced — dash here", "a spaced, dash here"],
  ["an en – dash here", "an en, dash here"],
  ["ascii -- double hyphen", "ascii, double hyphen"],
  ["spaced - hyphen", "spaced, hyphen"],
  // real hyphens inside words must survive
  ["mean-reversion and back-test", "mean-reversion and back-test"],
  ["RSI‑14 uses a non-breaking hyphen", "RSI-14 uses a non-breaking hyphen"],
  // cosmetic tidy-ups
  ["drawdown of 3.2 %", "drawdown of 3.2%"],
  ["too    many spaces", "too many spaces"],
  ["  trims edges  ", "trims edges"],
  // seams left behind by the substitutions
  ["clause —, already comma", "clause, already comma"],

  // NEGATIVE NUMBERS. Models write minus signs as en dashes. Converting those
  // to commas turned "-20.7%" into "20.7%", printing a loss as a gain.
  ["net returns range from –0.4% to –20.7%", "net returns range from -0.4% to -20.7%"],
  ["drawdown —6.35% on the year", "drawdown -6.35% on the year"],
  ["expectancy of –1.15 R", "expectancy of -1.15 R"],
  ["Sharpe –2.21 and Sortino –1.00", "Sharpe -2.21 and Sortino -1.00"],
  // a spaced dash before a number is still a clause break, not a minus
  ["the edge is thin — 5 trades only", "the edge is thin, 5 trades only"],
];

let failed = 0;
for (const [input, expected] of cases) {
  const got = cleanProse(input);
  try {
    assert.equal(got, expected);
    console.log(`ok    ${JSON.stringify(input)}`);
  } catch {
    failed++;
    console.error(`FAIL  ${JSON.stringify(input)}\n      got      ${JSON.stringify(got)}\n      expected ${JSON.stringify(expected)}`);
  }
}

// the property that actually matters: no dash lookalike ever survives as a separator
const dashy = "Trend—strong, momentum – weak, edge -- thin";
assert.ok(!/[—–―]|--/.test(cleanProse(dashy)), "no em/en dash or double hyphen may survive");

// and the sign of every number is preserved exactly
const signed = "net –6.3%, PF 0.13, DD –7.6%, Sharpe –2.21, win 20%";
const out = cleanProse(signed);
assert.deepEqual(
  out.match(/-?\d+(?:\.\d+)?/g),
  ["-6.3", "0.13", "-7.6", "-2.21", "20"],
  `signs must survive cleaning, got: ${out}`,
);

if (failed) {
  console.error(`\n${failed} case(s) failed`);
  process.exit(1);
}
console.log("\ncleanProse self-check passed");
