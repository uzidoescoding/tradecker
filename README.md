# Tradecker

Tradecker watches traders who actually make money, and shows you what they are
all buying or selling at the same time.

The idea is simple. On Hyperliquid, every account's positions are public. You
can see exactly what someone holds, what price they got in at, and how much
they have made or lost over their whole trading life. So instead of guessing
which trades are good, you can check what the people who keep winning are
actually doing with their own money right now.

One winning trader buying something is not much. That is one person's opinion.
Twelve winning traders, who do not know each other, all sitting on the same
side of the same coin, is worth a look.

That is the whole product.

## What you see

The main page is a list of coins. Each one shows:

- Which way the good traders are positioned, long or short
- How many of them are in it, and how many are against it
- The live price, and the average price they got in at, so you know if you are
  late
- An **entry score** out of 100
- A **risk score** out of 100

Click a coin and you get the full list of accounts holding it, plus a written
read from an AI on what is going on and where the stop and take profits could
sit.

There is also a chat panel on the right. You can ask it about anything on the
page, or just ask what a word means if you are new to this.

## The two scores, and why there are two

**Entry score** answers "is this a good idea right now". It goes up when a lot
of good traders agree, and comes down when they are already deep in profit
(because then the move mostly already happened and you missed it).

**Risk score** answers a completely different question: "what happens to me if
this is wrong". A coin can score well on one and badly on the other, and that
is the point. Twelve traders unanimously long at 20x leverage with their
liquidation prices sitting 3% away is a great idea and a terrible trade.

Risk is built from six things, all of which come from data already on the page,
so it costs no extra API calls:

| Factor | Why it matters |
| --- | --- |
| Leverage | How hard the group is pushing. At 20x, a 5% move against them is the whole account. |
| Liquidation distance | How close the nearest forced sale is. If one big account gets liquidated it can drag the price and take the others with it. |
| Concentration | Whether the "consensus" is really twelve people or one huge position and eleven small ones. |
| Dissent | How much money is positioned the other way. |
| Staleness | How much of the move has already happened. |
| Sector | A memecoin does not start from the same place as Bitcoin. |

If a factor has no data (liquidation prices are often missing on large
accounts) it gets dropped and the rest are reweighted. It never quietly counts
missing data as safe, because that is exactly the wrong default for a risk
number.

## How a trader qualifies to vote

Not everyone gets a vote. An account has to clear three floors: lifetime
profit, lifetime return, and how much money is actually on the table today.
There are three preset strictness levels in the header.

Once they qualify, their vote is weighted:

- Lifetime profit, on a log scale. The gap between $100k and $1M of profit says
  something about skill. The gap between $10M and $100M mostly just says they
  started with more money.
- How many of their week, month and lifetime windows are green. This separates
  someone who keeps doing it from someone who got lucky once in 2023.
- Lifetime return, capped at 3x. A 40x return is almost always a tiny starting
  balance that hit once.

The most important rule in the whole thing: **breadth is capped at 8 traders**.
That means one enormous whale cannot become a "consensus" on their own, no
matter how big the position. A coin only scores high when a lot of separate
people agree. There is a test that specifically checks a single $40M position
loses to ten traders holding $200k each, so nobody can refactor that away by
accident.

## Where the data comes from

All of it is the public Hyperliquid API. No key, no account, no signup, nothing
to pay for.

| What | Endpoint |
| --- | --- |
| Every account's lifetime, month, week and day profit and return | `GET stats-data.hyperliquid.xyz/Mainnet/leaderboard` (about 35 MB, roughly 42,000 accounts) |
| One account's open positions | `POST api.hyperliquid.xyz/info` with `clearinghouseState` |
| Live prices | `POST api.hyperliquid.xyz/info` with `allMids` |
| Recent candles, for volatility and support/resistance | `POST api.hyperliquid.xyz/info` with `candleSnapshot` |
| Funding, open interest and 24h volume | `POST api.hyperliquid.xyz/info` with `metaAndAssetCtxs` |

The leaderboard is what makes "profitable over the long run" something you can
actually check instead of assume. The positions endpoint is what makes the
holdings exact instead of guessed from wallet transfers. Those two together are
the entire foundation.

The leaderboard is big and only changes daily, so it is held in memory for an
hour. Positions refresh every minute.

## A note on Arkham

The original plan was to use Arkham, which is a good tool for a different job.
Arkham tells you *who* an address belongs to. It does not give you open perp
positions with entry prices, which is the part this actually needs. Their API
is also application-only and tied to a subscription, with no public price.

If you want real names next to the addresses later, the hook is already there:
`Trader.name` in `lib/hyperliquid.ts` is currently filled from Hyperliquid's own
display names (usually empty). Fill that same field from Arkham and everything
downstream works without changes.

## The AI parts

Two panels, both running on Groq with `openai/gpt-oss-120b`.

**Desk read** is inside each coin's detail view. It is meant to be the whole
note in one screen, so it is dense on purpose:

- A one line thesis, plus conviction and how long the idea is supposed to last
- Entry, stop and three targets, each with the distance in percent and in R
- What leverage that stop implies if you risk 0.5%, 1% or 2% of your account,
  next to the venue's own cap. Leverage is not a dial you pick, it falls out of
  the stop you chose
- Where price sits: 24h, 7d and 30d drift, position in the 7 day range, and the
  nearest real support and resistance
- The book: funding rate (and whether your side collects it or pays it), open
  interest, and 24h volume against that open interest
- The bull case and the bear case side by side, what would confirm the idea,
  what would kill it, and short things to watch

Support and resistance come from pivot highs and lows, filtered so anything
closer than one ATR is ignored. Without that filter the "nearest level" over a
month of hourly candles is always a fraction of a percent away, which is just
the current price with extra steps.

The important design decision here: **the code does the maths, not the model.**
Ask any language model for a stop loss and it will give you a confident round
number with nothing behind it. So `lib/levels.ts` works out the levels first
from real volatility (the stop sits 1.5x the hourly ATR away, targets at 1R, 2R
and 3R). The model gets those numbers and can adjust them. Then every value it
sends back is checked, and anything that does not make sense is thrown out and
replaced with the original. A stop on the wrong side of the entry is not a
difference of opinion, it is a broken answer.

If it rejects something, the panel tells you which field it rejected. It does
not quietly fix a bad answer and pass it off as the model's work.

One practical note if you swap models: when asked for `targets` as an array,
gpt-oss-120b kept returning all three numbers glued into one string
(`"44.355744.111443.8671"`). Asking for three separate `tp1` / `tp2` / `tp3`
fields fixed it completely. The validation still catches the glued version if a
future model brings it back.

**Ask the desk** is the side panel. It can do two things: answer questions about
the numbers on screen, and explain concepts in plain English if you have not met
them before. Ask it what a perpetual future is, or what the chip that says
"L1/L2 27" means, and it will just tell you.

What it will never do is make up live data. Prices, positions and account
figures have to come from the page. It has no news feed and no idea what
happened in the world today, and it says so when asked.

## Running it

```
npm install
cp .env.local.example .env.local   # put a Groq key in it
npm run dev                        # http://localhost:3000
```

The Groq key is optional and free from https://console.groq.com/keys. Without
one, every number on the page still works exactly the same. Only the two AI
panels stop, and they tell you why.

```
npm run check    # runs all the tests
npm run build
```

## Tests

There are no test frameworks here, just plain Node scripts you can run
directly. Each one compiles the file it tests and asserts against it.

| Script | Covers |
| --- | --- |
| `check-consensus.mjs` | The scoring. Mostly that one whale cannot outvote a group. |
| `check-levels.mjs` | Volatility maths, and every way a model can return a broken stop loss. |
| `check-risk.mjs` | The risk factors, especially that missing data never reads as safe. |
| `check-sort.mjs` | The three-click column sorting. |
| `check-text.mjs` | Cleaning up model punctuation. |

## Files

```
app/
  page.tsx                 the dashboard
  api/consensus/route.ts   qualify traders, read positions, score coins
  api/analyze/route.ts     the written read and trade levels
  api/ask/route.ts         the chat panel
  globals.css              colours, type, materials
lib/
  hyperliquid.ts           talking to the exchange
  consensus.ts             the scoring, pure functions only
  risk.ts                  the risk factors
  levels.ts                volatility, stops, targets, and checking the model
  categories.ts            what sector each coin belongs to
  sort.ts                  three-state column sorting
  groq.ts                  one place that talks to Groq
  text.ts                  tidying up model output
  fmt.ts                   number formatting
components/
  ConsensusCard.tsx        one coin
  Analysis.tsx             the AI read and the levels
  AskPanel.tsx             the chat panel
  TraderTable.tsx          every account in the cohort, sortable
  Sheet.tsx                the drag-to-dismiss detail panel
  SideRays.tsx             the background
```

`SideRays.tsx` is hand written WebGL. It is one triangle and one shader, so
pulling in a 3D library to draw it would have been more work, not less.

## This is not advice

Tradecker tells you what other people are doing with their money. That is all
it does.

It does not know your account size, your risk tolerance, or what you can afford
to lose. Copying a profitable trader into the wrong position size still loses
you money. The AI writes its levels from six numbers and no knowledge of the
world. And a trader being up 500% over their lifetime tells you nothing
guaranteed about their next trade.

Use it as one input. Not as a reason.
