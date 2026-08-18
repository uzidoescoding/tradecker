/**
 * What kind of thing is this instrument.
 *
 * Two separate questions, because they answer different needs:
 *
 *   assetClass  Crypto / Commodity / Equity / FX. Today Hyperliquid lists 177
 *               perps and exactly one of them is not crypto (PAXG, tokenised
 *               gold), so this looks almost useless. It is here because the
 *               venue keeps adding non crypto perps, and the day an equity
 *               perp lists, a consensus that silently mixes it in with
 *               memecoins is worse than useless.
 *
 *   sector      The cut that actually matters right now. Twelve traders short
 *               across four unrelated memecoins is one bet on one thing, not
 *               four independent signals, and you cannot see that without
 *               knowing which coins are memecoins.
 *
 * Explicit lists, not pattern matching. Ticker text carries no information
 * about what a token does, and a heuristic that guesses would be wrong quietly.
 * Anything unlisted lands in "Other", which is the honest answer.
 */

export const SECTORS = [
  "Major",
  "L1/L2",
  "DeFi",
  "Meme",
  "AI",
  "Gaming/NFT",
  "Privacy",
  "Exchange",
  "Infra",
  "RWA",
  "Other",
] as const;
export type Sector = (typeof SECTORS)[number];

export const ASSET_CLASSES = ["Crypto", "Commodity", "Equity", "FX", "Other"] as const;
export type AssetClass = (typeof ASSET_CLASSES)[number];

/** Hyperliquid prefixes a ticker with `k` when the contract is on 1000 units. */
export function baseTicker(coin: string): string {
  return /^k[A-Z]/.test(coin) ? coin.slice(1) : coin;
}

const BY_SECTOR: Record<Exclude<Sector, "Other">, string[]> = {
  Major: "BTC ETH SOL BNB XRP ADA AVAX LINK TRX DOT LTC BCH XLM HBAR ICP ETC ATOM NEAR BSV".split(" "),
  "L1/L2":
    "SUI APT SEI TIA ARB OP STRK ZK MANTA MNT LINEA MEGA 0G MON MOVE BERA S CELO ALGO IOTA MINA KAS NEO ZETA ALT DYM SAGA MERL W AR FIL STX CFX POLYX POL FOGO INIT SOPH HEMI 2Z INJ RUNE TAO XPL ASTER SKY".split(
      " ",
    ),
  DeFi: "AAVE CRV UNI LDO SNX COMP PENDLE MORPHO SUSHI ENA SYRUP RESOLV USUAL JUP CAKE ETHFI EIGEN AERO VVV MET".split(
    " ",
  ),
  Meme: "DOGE PEPE SHIB WIF BONK FLOKI POPCAT BRETT GOAT MOODENG PNUT FARTCOIN TRUMP MELANIA ANIME PUMP CASHCAT MEME BANANA VINE GRIFFAIN HMSTR NEIRO PEOPLE TURBO SPX BOME LUNC BABY MEW NOT ZORA".split(
    " ",
  ),
  AI: "RENDER FET IO AIXBT VIRTUAL GRASS WLD NIL PROVE BIO KAITO".split(" "),
  "Gaming/NFT": "AXS GALA YGG SAND IMX APE BLUR PENGU ME XAI BIGTIME ACE GMT SUPER".split(" "),
  Privacy: "XMR ZEC ZEN DASH AZTEC".split(" "),
  Exchange: "HYPE DYDX GMX AVNT APEX JTO PURR CC WLFI".split(" "),
  Infra: "PYTH TRB ZRO LAYER HYPER GRAM ENS UMA GAS RSR NXPC CHIP SKR LIT ORDI JTO WCT SKR".split(
    " ",
  ),
  RWA: "PAXG ONDO STBL STABLE".split(" "),
};

const SECTOR_OF = new Map<string, Sector>();
for (const [sector, coins] of Object.entries(BY_SECTOR)) {
  // First list wins, so a coin that appears twice keeps its earliest, broadest
  // classification rather than silently depending on object key order.
  for (const c of coins) if (!SECTOR_OF.has(c)) SECTOR_OF.set(c, sector as Sector);
}

const CLASS_OF = new Map<string, AssetClass>([["PAXG", "Commodity"]]);

export function sector(coin: string): Sector {
  return SECTOR_OF.get(baseTicker(coin)) ?? "Other";
}

export function assetClass(coin: string): AssetClass {
  return CLASS_OF.get(baseTicker(coin)) ?? "Crypto";
}

/**
 * Sector concentration across a set of rows.
 *
 * The number that matters when you are about to size up on "four independent
 * signals" that turn out to be four memecoins.
 */
export function sectorMix(coins: string[]): { sector: Sector; count: number; share: number }[] {
  const counts = new Map<Sector, number>();
  for (const c of coins) counts.set(sector(c), (counts.get(sector(c)) ?? 0) + 1);
  const total = coins.length || 1;
  return [...counts.entries()]
    .map(([s, count]) => ({ sector: s, count, share: count / total }))
    .sort((a, b) => b.count - a.count);
}
