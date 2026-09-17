# Signal Desk

Market regime, breadth and sector rotation, built on the CoinMarketCap API.

Most crypto dashboards answer "what is the price". This one answers three questions
a price cannot:

1. **Is the market taking risk or reducing it**, read from total cap direction against
   BTC dominance rather than from a single sentiment index.
2. **How much of the market is actually participating**, because a tape can rise on a
   handful of names while the median asset bleeds.
3. **Where did money rotate**, by sector.

It then says the thing those three produce together, which no single panel shows:
**when sentiment and participation disagree.** On the first live run it read
*"Sentiment reads Greed at 68, but only 10% of the top 200 is advancing and the median
name is -5.12%."* That is the product.

## Run it

```bash
npm install
echo "CMC_API_KEY=your-key" > .env
npm start                 # http://localhost:3131
npm run capability        # what your key can actually reach
npm test                  # probe rules and spread maths, no key and no network needed
```

## All four tracks, one product

| Track | In this build |
|---|---|
| **Markets and Trading Tools** | Screener with local filtering, watchlist, portfolio with live PnL, price alerts evaluated client side |
| **AI Agents and Automation** | `mcp/server.js`, an MCP server exposing six tools over stdio to any LLM client |
| **Data and Visualisation** | Regime read, sentiment gauge, breadth bar, interactive 3D sector rotation, chain explorer |
| **Real World Assets** | The v5 RWA family: tokenised asset universe, per-asset registrant metadata including SEC CIK, the tokens representing each asset with their issuers, a dislocation leaderboard ranking the whole universe by how far apart its wrappers trade, and an issuer explorer |

Submitted under one track, but the product covers all four.

### The MCP server

Nine tools, and they expose the ANALYSIS rather than thin endpoint wrappers. A model
asking "what is the market doing" wants a regime read and a breadth number, not 200
rows of JSON it has to reduce itself, badly.

```
market_regime     risk on or risk off, with the sentiment versus breadth divergence
market_breadth    participation across the top N by market cap
sector_rotation   where money moved, by sector
quote             live price for one or many symbols, batched into one credit
chain_coverage    which networks CMC indexes, and their platform ids
api_capability    what the key can actually reach, so a model never invents an answer
rwa_assets        tokenised equities, commodities and funds, by tokenised market cap
rwa_asset         one asset: its registrant, its SEC CIK, and every token representing it
rwa_issuers       who mints tokenised assets, and everything one issuer has minted
```

`rwa_asset` is the one worth calling out. Asked "who issues tokenised NVDA", a model
with raw endpoint access would have to fetch, join and rank three payloads. Here it
gets Nvidia Corp, CIK 0001045810, and eight tokens ranked by market cap with the
issuer named on each. Asked instead where an asset is cheapest, it gets the same
wrappers ranked by price with the gap between them already in basis points, the
liquid pair separated from the merely quoted, and the caveat to repeat while
saying so.

Install:

```bash
claude mcp add signal-desk -- node /path/to/cmc-signal/mcp/server.js
```

`api_capability` matters more than it looks. Without it a model told "no data" cannot
tell a subscription limit from a real absence, and will confidently make something up.

## Endpoints used, explicitly

Every panel names its source in the UI as well as here.

| Endpoint | Method | Used for | Free tier |
|---|---|---|---|
| `/v1/global-metrics/quotes/latest` | GET | regime: total cap, dominance, 24h change | yes |
| `/v3/fear-and-greed/latest` | GET | regime: sentiment side of the divergence | yes |
| `/v1/cryptocurrency/listings/latest` | GET | breadth, median change, leaders and laggards | yes |
| `/v1/cryptocurrency/categories` | GET | sector rotation | yes |
| `/v1/dex/platform/list` | GET | chain coverage | yes |
| `/v1/cryptocurrency/trending/latest` | GET | wider trending, when the plan allows | no |
| `/v1/cryptocurrency/trending/gainers-losers` | GET | movers, when the plan allows | no |
| `/v1/cryptocurrency/listings/new` | GET | new listings, when the plan allows | no |
| `/v1/dex/gainer-loser/list` | **POST** | on-chain movers, when the plan allows | no |
| `/v1/dex/new/list` | **POST** | new on-chain tokens, when the plan allows | no |
| `/v5/real-world-assets/assets/list` | GET | the tokenised asset universe, by tokenised market cap | yes |
| `/v5/real-world-assets/map` | GET | asset id and type taxonomy | yes |
| `/v5/real-world-assets/info` | GET | the registrant behind a token: industry, founded, employees, SEC CIK | yes |
| `/v5/real-world-assets/quotes/latest` | GET | tokenised price and cap, plus the tokens representing the asset | yes |
| `/v5/real-world-assets/issuers/list` | GET | the issuer explorer | yes |
| `/v5/real-world-assets/issuers` | GET | one issuer and everything it has tokenised | yes |
| `/v5/real-world-assets/market-pairs/list` | GET | per-asset market pairs, refused on free | no |

**Everything the product needs to be useful runs on the free tier.** The paid endpoints
add breadth, not substance, which was deliberate: a dashboard that only works after
someone pays cannot be evaluated by the person deciding whether to pay.

## What the API made possible

**The chain coverage was the surprise.** `/v1/dex/platform/list` returns **244 networks**,
and it is free. Checking the five chains this project cares about:

| Chain | Platform id |
|---|---|
| Base | 199 |
| Solana | 16 |
| Fogo | 332 |
| Robinhood Chain | 300 |
| X Layer | 216 |

Fogo and Robinhood Chain are genuinely hard to get data for. Two other vendors evaluated
for the same job could not confirm either. CMC indexes both, which is the strongest
reason in this repo to build on it.

**One real world asset maps to many issuers, and the API makes that join for you.**
`quotes/latest` returns not just a tokenised price but the list of tokens that
represent the asset, each with its issuer name and its own market cap. Nvidia
resolves to eight tokenised versions across Backed Assets, Ondo, Robinhood and
bStocks. Gold resolves to seven led by Tether Holdings and Paxos. Pair that with
`info`, which carries the registrant including the SEC CIK, and a tokenised equity
traces from an on chain ticker to a filing identifier in two calls. No category
taxonomy reaches that, because a category has no concept of an issuer.

**Nobody makes those issuers agree on a price, and the gap is free to compute.**
Because `quotes/latest` returns every wrapper in one payload, the dispersion between
them is arithmetic on a response already in hand rather than a second request. Circle
trades across seven tokenised versions spanning tens of basis points, and on a $10,000
position that is real money for choosing the wrong venue. `lib/spread.js` does it in
about a hundred lines, costs no credits, and feeds both the RWA view and the MCP tool.

**And `quotes/latest` takes fifty ids at once, so the whole board is two calls.**
The Spreads tab ranks the entire tokenised universe by how far apart its versions are:
one call for the asset list, one batched quote for every wrapper of every asset, both
cached for fifteen minutes. The cost does not scale with viewers, only with time. That
one endpoint turns a per-asset curiosity into a market-wide view of where tokenisation
is actually dislocated.

**Two things had to be right before that ranking meant anything**, and both were found
by looking at what the numbers claimed rather than trusting them. They are written up
under "Where it got in the way" as feedback items 8 and 9, because both are properties
of the data rather than bugs in this code.

**Categories are underrated.** `/v1/cryptocurrency/categories` gives a sector taxonomy
with market cap and change already computed, so rotation needs one call rather than a
classification pipeline.

## Where it got in the way

Written from the actual debugging, because a feedback note is only useful if it is specific.

**1. A 403 and a 405 mean completely different things, and the difference cost time.**
The DEX discovery endpoints answer `405 Method Not Allowed` to a GET. They are POST with
a JSON body. That reads like a broken or withdrawn endpoint, and the docs page reached
first did not say so. Three wrong conclusions came out of that before the right one:
`405` was our method, `400` was our body, and only `403` was the plan. The client in
`lib/cmc.js` now classifies these separately, and the UI says "needs a paid plan" only
for a genuine 403.

**2. Free-tier refusals are invisible until you call.** There is no endpoint that reports
what a key may reach, so the only way to know is to try all of them. `scripts/cmc-capability.mjs`
does exactly that and prints a table. Something like a `GET /v1/key/capabilities` would
have removed a whole afternoon.

**3. `/v1/dex/platform/list` returns abbreviated field names** (`n`, `dn`, `id`, `uf`)
while most of the API returns readable ones. Matching on `name` returned zero results
for chains that were all present. Nearly reported that CMC does not cover Base.

**4. The RWA endpoints live under /v5, and guessing the version cost the most time
in this build.** Every other family this project touches is v1, v2 or v3, so
`/v1/rwa/*` and `/v1/real-world-assets/*` were the natural first guesses. Both 404,
as does everything else under v1. The real prefix is `/v5/real-world-assets/`. A 404
on a guessed path is evidence about the guess and nothing else, and for a while this
README said the endpoints were unreachable, which was simply wrong. Six of the seven
are on the free Basic tier:

| Endpoint | Free tier |
|---|---|
| `/v5/real-world-assets/map` | yes, 0 credits |
| `/v5/real-world-assets/assets/list` | yes |
| `/v5/real-world-assets/info` | yes |
| `/v5/real-world-assets/quotes/latest` | yes |
| `/v5/real-world-assets/issuers/list` | yes |
| `/v5/real-world-assets/issuers` | yes |
| `/v5/real-world-assets/market-pairs/list` | no, 403 |

The lesson generalises past this API: a version prefix is not guessable from a
sibling family, and the endpoint reference is the only source for it.

**4b. The v5 family does not shape its responses like the rest of the API.** Three
differences, each of which failed silently rather than loudly:

- `quotes` is an **array** of per-currency objects carrying a `symbol` field, where
  v1 and v2 return an object keyed by currency. Reading it as `quote.USD` yields
  undefined for every number with no error anywhere.
- `about` is an **object** holding a markdown description, not a string. Calling
  `.slice` on it threw inside an async route handler, and because nothing caught it
  the response was never sent: the request hung for fifty seconds rather than
  failing. Every async handler is wrapped now, so a bad upstream shape becomes a
  logged 500 instead of silence.
- the issuer token list carries identity only, `name`, `symbol`, `crypto_id` and
  `rwa_id`. No price and no network. Columns were built for data that was never
  there, and the fix was to show what exists and use `rwa_id` to link each row back
  to its asset.

All three were found by dumping the raw payload. None would have been caught by
reading the documented field list.

**5. A cache key that ignores its own parameter truncates data silently.** Ours did:
`categories(200)` and `categories(5000)` shared one entry, so whichever ran first won
and the RWA view lost three of its nine sectors with no error anywhere. Found only by
noticing the count changed between two runs. The limit is part of the key now.

**6. The 3D view has to survive a missing WebGL context.** Not a CMC issue, but worth
recording: `THREE.WebGLRenderer` throws rather than returning null, so an old device or a
blocked context takes the whole script down unless it is wrapped. It degrades to the
table now. A canvas that has been `display:none` can also come back blank, and a
software context can be lost without throwing, so re-entering the view resizes and
redraws rather than trusting what is on the canvas. That one only showed up when a test
navigated away and back: a direct visit always looked fine.

**7. A base rule written after its own media query wins on source order.** The phone
drag handle on the asset sheet stayed visible on the 1440px centred dialog, where it
means nothing. `.modal .grab{display:block}` and `@media (min-width:760px){.modal
.grab{display:none}}` carry identical specificity, so the later one wins and mine was
later. Caught by asserting the computed style in Chrome rather than reading the CSS.
Declaration order is the fix, not `!important`.

**8. One asset's wrappers do not all quote the same unit, and nothing in the payload
says so.** Gold returns seven tokens. Five are one troy ounce at about $4,320 and two
are one gram at about $138. Ranked naively that is a spread of 305,274 basis points,
and the product stated it as a fact until the number was checked against reality. There
is no field distinguishing them: `price` is just a number, and the unit lives in the
token's name if anywhere. The fix is to anchor on the asset level `average_tokenized_price`,
which is reliably in the majority denomination, and set aside any wrapper more than 25%
away rather than ranking it. A per-token `unit` or `denomination` field would remove the
guesswork entirely, and gold, silver and oil all need it.

**9. Nonzero volume is not the same as tradable, and the difference inverts conclusions.**
Google's cheapest wrapper carried $43 of 24h volume and another carried $9, both quoting
hundreds of basis points away from the six venues doing millions. Treating any volume at
all as a tradable price put those two at opposite ends of the dislocation ranking and
called it a finding, when the real cluster spans 45 basis points. A price nobody trades
drifts and then stays drifted, so it is evidence of neglect rather than of a dislocation.
The floor here is $10,000 of 24h volume, stated in `lib/spread.js` and exported so callers
can cite it. This is the single most important thing to get right when comparing venues,
and it is entirely invisible if you sort on price alone.

## Mobile first

The base stylesheet is the phone. Wider screens are the enhancement, added with
`min-width` queries, not the other way round.

- **App style bottom navigation** below 900px, with four primary tabs and a native
  feeling overflow sheet for the rest. The top menu is hidden there.
- **Installable.** A web manifest, theme colour, maskable icon and iOS standalone
  meta, so it adds to a home screen and opens without browser chrome.
- **Safe areas respected.** The tab bar and sheet pad by `env(safe-area-inset-bottom)`
  so nothing sits under the home indicator.
- **44px touch targets** everywhere, shrinking only above 900px where a pointer exists.
- **16px form inputs on phones**, because anything smaller makes iOS Safari zoom the
  viewport on focus and the layout never recovers.
- **One finger orbits the 3D view, two fingers pinch to zoom**, since a phone has no
  scroll wheel and page zoom would fight the layout.
- Tapping a tab returns to the top of the section, the way a native app does.

## Motion and the interaction layer

Motion here is load bearing, not decoration. Each piece answers "did something change"
or "where am I", which a static table cannot.

- **Asset sheet.** Tapping any row opens a detail sheet: live quote, a scaled bar chart
  across 1h, 24h, 7d and 30d, eight metric cells, and two actions. It rises from the
  bottom on a phone, where a sheet is the native idiom, and becomes a centred dialog
  above 760px, where one is not. Drag it down to dismiss, or press Escape. Focus returns
  to the row that opened it.
- **Ticker tape.** The top strip scrolls the current top movers. The content is
  duplicated and translated by exactly half its width, so the loop has no seam and needs
  no JavaScript frame loop. It pauses on hover.
- **Values flash on change.** When a refresh moves a number, that cell pulses once, up
  in green and down in red. Reading a dashboard should not require diffing it by eye.
- **Skeletons, not spinners.** Panels shimmer in their final shape while their call is
  in flight, so the layout never jumps when data lands.
- **Toasts** confirm actions that have no visible result, such as adding to a watchlist.
- **Ambient loop.** The hero video is an 8.8 second clip cross faded onto itself so the
  loop point is invisible, 112KB, muted and `playsinline`. It is a background, so it
  never competes with a number on the page.

## Design notes

**Capability aware.** `GET /api/capability` probes every endpoint at load with the correct
method, and the UI draws what is reachable. A panel whose endpoint is refused says so
rather than rendering an empty box, because an empty box reads as broken and a refusal is
not.

**Budget aware.** The free plan is 15,000 credits a month and a naive poll loop eats that
in days. Every response is cached with an explicit TTL, plan refusals are cached too, and
the credit count CMC reports is accumulated and shown in the footer. A full desk render
costs **5 credits**.

**Colour means direction.** Orange is the brand and leads. Green and red are reserved for
gain and loss, never decoration, so a colour on the page always carries information.

## Layout

```
server.js              Express, four routes
lib/cmc.js             API client: caching, credit accounting, verdict classification
lib/signal.js          the analysis: regime, breadth, rotation, movers, chains
public/                dashboard, no framework
scripts/cmc-capability.mjs   standalone key capability probe
```
