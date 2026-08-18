/**
 * Three state column sorting.
 *
 * Click once for highest first, again for lowest first, a third time to go back
 * to the order the server sent. That third state is the one worth being careful
 * about: without it there is no way back to the default ranking short of a page
 * reload, and it is also the state a two state toggle silently swallows.
 *
 * Pure and separate from the table so scripts/check-sort.mjs can pin the cycle.
 */

export type Dir = "desc" | "asc";
/** `null` key means "no column is sorting": the incoming order stands. */
export type Sort<K extends string> = { key: K | null; dir: Dir };

export const NO_SORT = { key: null, dir: "desc" } as const;

/**
 * Where a click on `key` takes the current sort.
 *
 * Clicking a different column always starts that column fresh at descending
 * rather than inheriting the previous column's direction, because "highest
 * first" is what someone means by the first click on a new column.
 */
export function nextSort<K extends string>(current: Sort<K>, key: K): Sort<K> {
  if (current.key !== key) return { key, dir: "desc" };
  if (current.dir === "desc") return { key, dir: "asc" };
  return { key: null, dir: "desc" };
}

/**
 * Sort a copy of `rows` by the selected column.
 *
 * Strings compare with localeCompare so casing and accents behave; everything
 * else compares numerically. Non finite numbers and nullish values always sink
 * to the bottom regardless of direction, because a missing value is not a small
 * value and floating it to the top of an ascending sort would be a lie.
 */
export function sortRows<T, K extends string>(
  rows: T[],
  sort: Sort<K>,
  value: (row: T, key: K) => number | string | null | undefined,
): T[] {
  if (!sort.key) return rows;
  const key = sort.key;
  const sign = sort.dir === "desc" ? -1 : 1;

  return [...rows].sort((a, b) => {
    const av = value(a, key);
    const bv = value(b, key);

    const aMissing = av == null || (typeof av === "number" && !Number.isFinite(av));
    const bMissing = bv == null || (typeof bv === "number" && !Number.isFinite(bv));
    if (aMissing || bMissing) return aMissing && bMissing ? 0 : aMissing ? 1 : -1;

    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * sign;
    }
    return (av - bv) * sign;
  });
}

/** Arrow for the header. Nothing at all when the column is not the active one. */
export function sortGlyph<K extends string>(sort: Sort<K>, key: K): string {
  if (sort.key !== key) return "";
  return sort.dir === "desc" ? "↓" : "↑";
}

/** The `aria-sort` value a header cell should carry. */
export function ariaSort<K extends string>(sort: Sort<K>, key: K): "none" | "ascending" | "descending" {
  if (sort.key !== key) return "none";
  return sort.dir === "desc" ? "descending" : "ascending";
}
