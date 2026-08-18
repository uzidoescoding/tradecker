/**
 * Normalise model prose.
 *
 * Models reach for typographic dashes no matter what the system prompt says.
 * Order matters here: em/en dashes are clause separators and become commas,
 * while the hyphen variants are real hyphens inside words and become "-".
 * An earlier version only handled dashes with spaces around them, which left
 * "different technical basis—EMA crossovers" reading as "basis-EMA crossovers".
 */
export function cleanProse(s: string): string {
  return (
    s
      // true hyphen lookalikes inside words: keep them as hyphens
      .replace(/[‐‑]/g, "-")
      // A dash sitting flush against a number is a MINUS SIGN, not a clause
      // break. Models routinely write "-20.7%" with an en dash. Turning that
      // into a comma printed a 20.7% loss as a 20.7% gain, which is the worst
      // possible failure in a trading readout. Must run before the rule below.
      .replace(/[—–―‒](?=[\d.])/g, "-")
      // remaining em/en dashes really are clause separators, spaced or not
      .replace(/\s*[—–―‒]\s*/g, ", ")
      // a spaced ASCII hyphen used as a dash (the space after keeps "-0.4" safe)
      .replace(/\s+-\s+/g, ", ")
      .replace(/\s*--+\s*/g, ", ")
      // tidy up the seams the substitutions leave behind
      .replace(/,\s*,+/g, ",")
      .replace(/\s+,/g, ",")
      .replace(/,\s*\./g, ".")
      .replace(/(\d)\s+%/g, "$1%")
      .replace(/[ \t]+/g, " ")
      .trim()
  );
}
