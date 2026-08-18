/**
 * Hyperliquid public data.
 *
 * Two endpoints carry the whole product and neither needs a key or an account:
 *
 *   stats-data.hyperliquid.xyz/Mainnet/leaderboard
 *     Every account that has ever traded, with realised PnL, ROI and volume
 *     over day / week / month / allTime. This is the "is this trader actually
 *     good over the long run" filter.
 *
 *   api.hyperliquid.xyz/info  {type: "clearinghouseState"}
 *     One account's live open perp positions: coin, signed size, entry price,
 *     leverage, unrealised PnL. This is the "what are they in right now" half.
 *
 * The leaderboard is ~35 MB and ~42k rows, so it is fetched rarely and held in
 * module memory. Positions are cheap and refresh on a short clock.
 */

const INFO = "https://api.hyperliquid.xyz/info";
const LEADERBOARD = "https://stats-data.hyperliquid.xyz/Mainnet/leaderboard";

export const WINDOWS = ["day", "week", "month", "allTime"] as const;
export type Window = (typeof WINDOWS)[number];

export type Perf = { pnl: number; roi: number; vlm: number };

export type Trader = {
  address: string;
  name: string | null;
  accountValue: number;
  perf: Record<Window, Perf>;
};

export type Position = {
  coin: string;
  side: "long" | "short";
  size: number; // absolute
  notional: number; // USD
  entry: number;
  leverage: number;
  unrealizedPnl: number;
  roe: number; // return on equity committed to this position
  liquidation: number | null;
};

export type Book = { address: string; accountValue: number; positions: Position[] };

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* --------------------------------------------------------------- transport */

async function info<T>(body: object, revalidate = 60): Promise<T> {
  const res = await fetch(INFO, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    next: { revalidate },
  });
  if (!res.ok) throw new Error(`Hyperliquid info ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * Time-boxed memo. The leaderboard payload is large enough that re-fetching it
 * per request would dominate the response time, and it only moves on a daily
 * cadence anyway.
 *
 * ponytail: module memory, so a cold serverless instance pays the fetch once.
 * Move to Vercel Runtime Cache only if instance churn makes that visible.
 */
function memo<T>(ttlMs: number, load: () => Promise<T>) {
  let at = 0;
  let held: Promise<T> | null = null;
  return () => {
    const now = Date.now();
    if (!held || now - at > ttlMs) {
      at = now;
      const attempt = load();
      held = attempt;
      // A failed load must not be cached, or one bad minute poisons the hour.
      attempt.catch(() => {
        if (held === attempt) held = null;
      });
    }
    return held;
  };
}

/* -------------------------------------------------------------- leaderboard */

type RawRow = {
  ethAddress: string;
  accountValue: string;
  displayName: string | null;
  windowPerformances: [string, { pnl: string; roi: string; vlm: string }][];
};

export function parseLeaderboard(raw: { leaderboardRows: RawRow[] }): Trader[] {
  return raw.leaderboardRows.map((r) => {
    const perf = {} as Record<Window, Perf>;
    for (const w of WINDOWS) perf[w] = { pnl: 0, roi: 0, vlm: 0 };
    for (const [key, p] of r.windowPerformances) {
      if ((WINDOWS as readonly string[]).includes(key)) {
        perf[key as Window] = { pnl: num(p.pnl), roi: num(p.roi), vlm: num(p.vlm) };
      }
    }
    return {
      address: r.ethAddress.toLowerCase(),
      name: r.displayName || null,
      accountValue: num(r.accountValue),
      perf,
    };
  });
}

export const leaderboard = memo(60 * 60 * 1000, async () => {
  // Deliberately uncached at the fetch layer: the payload is ~35 MB and Next's
  // data cache refuses anything over 2 MB, so it would only log a warning and
  // throw the work away. memo() above is what actually holds it.
  const res = await fetch(LEADERBOARD, { cache: "no-store" });
  if (!res.ok) throw new Error(`Hyperliquid leaderboard ${res.status}`);
  return parseLeaderboard(await res.json());
});

/* ------------------------------------------------------------------- prices */

export const mids = memo(15_000, async () => {
  const raw = await info<Record<string, string>>({ type: "allMids" }, 15);
  const out: Record<string, number> = {};
  // Prediction-market legs come through as numeric keys ("#11130"). They are
  // not perps and would only add noise to a consensus over coins.
  for (const [k, v] of Object.entries(raw)) if (!k.startsWith("#")) out[k] = num(v);
  return out;
});

/* ---------------------------------------------------------------- positions */

type RawState = {
  marginSummary: { accountValue: string };
  assetPositions: {
    position: {
      coin: string;
      szi: string;
      entryPx: string | null;
      leverage: { value: number };
      positionValue: string;
      unrealizedPnl: string;
      returnOnEquity: string;
      liquidationPx: string | null;
    };
  }[];
};

export function parseBook(address: string, raw: RawState): Book {
  const positions: Position[] = [];
  for (const { position: p } of raw.assetPositions ?? []) {
    const szi = num(p.szi);
    if (szi === 0) continue;
    positions.push({
      coin: p.coin,
      side: szi > 0 ? "long" : "short",
      size: Math.abs(szi),
      notional: Math.abs(num(p.positionValue)),
      entry: num(p.entryPx),
      leverage: num(p.leverage?.value) || 1,
      unrealizedPnl: num(p.unrealizedPnl),
      roe: num(p.returnOnEquity),
      liquidation: p.liquidationPx == null ? null : num(p.liquidationPx),
    });
  }
  return { address, accountValue: num(raw.marginSummary?.accountValue), positions };
}

/* ----------------------------------------------------------------- contexts */

export type AssetCtx = {
  coin: string;
  /** Hourly funding rate as a decimal. Positive means longs pay shorts. */
  funding: number;
  /** Open interest in base units. */
  openInterest: number;
  /** Open interest in USD, which is the number anyone actually compares. */
  openInterestUsd: number;
  dayNotionalVolume: number;
  prevDayPx: number;
  markPx: number;
  oraclePx: number;
  /** Mark against oracle. A stretched premium is crowding you can measure. */
  premium: number;
  maxLeverage: number;
};

type RawCtx = {
  funding: string;
  openInterest: string;
  prevDayPx: string;
  dayNtlVlm: string;
  premium: string | null;
  oraclePx: string;
  markPx: string;
};

/**
 * Funding, open interest and 24h volume for every perp, in one request.
 *
 * Funding is the piece the position data cannot tell you: it is what the trade
 * costs to hold, and which way the rest of the venue is leaning. A short that
 * collects funding and a short that bleeds it are different trades.
 */
export const assetContexts = memo(30_000, async () => {
  const [meta, ctxs] = await info<[{ universe: { name: string; maxLeverage: number }[] }, RawCtx[]]>(
    { type: "metaAndAssetCtxs" },
    30,
  );
  const out: Record<string, AssetCtx> = {};
  meta.universe.forEach((asset, i) => {
    const c = ctxs[i];
    if (!c) return;
    const oi = num(c.openInterest);
    const mark = num(c.markPx);
    out[asset.name] = {
      coin: asset.name,
      funding: num(c.funding),
      openInterest: oi,
      openInterestUsd: oi * mark,
      dayNotionalVolume: num(c.dayNtlVlm),
      prevDayPx: num(c.prevDayPx),
      markPx: mark,
      oraclePx: num(c.oraclePx),
      premium: num(c.premium),
      maxLeverage: asset.maxLeverage,
    };
  });
  return out;
});

/* ------------------------------------------------------------------ candles */

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

type RawCandle = { t: number; o: string; h: string; l: string; c: string; v: string };

const INTERVAL_MS: Record<string, number> = {
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/**
 * Recent OHLC for one coin.
 *
 * This exists so the trade levels are anchored to how far the thing actually
 * moves. A stop derived from realised volatility is defensible; a stop a
 * language model picked because the number looked round is not.
 */
export async function candles(coin: string, interval = "1h", bars = 200): Promise<Candle[]> {
  const span = INTERVAL_MS[interval] ?? INTERVAL_MS["1h"];
  const endTime = Date.now();
  const raw = await info<RawCandle[]>(
    { type: "candleSnapshot", req: { coin, interval, startTime: endTime - bars * span, endTime } },
    60,
  );
  return (raw ?? []).map((c) => ({
    t: c.t,
    o: num(c.o),
    h: num(c.h),
    l: num(c.l),
    c: num(c.c),
    v: num(c.v),
  }));
}

/**
 * Fetch many books at a bounded concurrency. Hyperliquid meters by request
 * weight per IP, and a 300-wide burst is the kind of thing that gets an IP
 * throttled, so the pool stays deliberately narrow. clearinghouseState costs 2
 * weight against a 1200/min budget, so a 350 account scan on a 60s refresh sits
 * at roughly 60% of the allowance.
 */
export async function fetchBooks(addresses: string[], concurrency = 12): Promise<Book[]> {
  const out: Book[] = [];
  let cursor = 0;
  const worker = async () => {
    while (cursor < addresses.length) {
      const address = addresses[cursor++];
      try {
        out.push(parseBook(address, await info<RawState>({ type: "clearinghouseState", user: address })));
      } catch {
        // One unreachable account must not sink the whole consensus.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, addresses.length) }, worker));
  return out;
}
