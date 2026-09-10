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
```

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

**4. The RWA endpoints are documented but not reachable.** The endpoint overview lists a
Real World Assets category, and CMC's own published agent skills contain no RWA
references. Every path tried returned 404. Either it is not live yet or it is not
discoverable, and the docs imply otherwise.

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
