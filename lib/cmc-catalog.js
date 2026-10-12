'use strict';

// Complete current documented CoinMarketCap Pro REST catalog (deprecated
// compatibility paths intentionally excluded from the active catalog).
const CATALOG = [
  {
    "method": "GET",
    "path": "/v1/fiat/map",
    "family": "tools",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/key/info",
    "family": "tools",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/tools/postman",
    "family": "tools",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/tools/price-conversion",
    "family": "tools",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/tokens/trending/list",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/tokens/batch-query",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/token/price/batch",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/new/list",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/meme/list",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/gainer-loser/list",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v4/dex/spot-pairs/latest",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v4/dex/pairs/quotes/latest",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/token",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/token/price",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/token/pools",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/token-liquidity/query",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/tokens/transactions",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/security/detail",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/search",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/liquidity-change/list",
    "family": "token",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/map",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/cryptocurrency/listings/latest",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/listings/new",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/listings/historical",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/cryptocurrency/quotes/latest",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/cryptocurrency/quotes/historical",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/cryptocurrency/ohlcv/latest",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/cryptocurrency/ohlcv/historical",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/cryptocurrency/market-pairs/latest",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/cryptocurrency/price-performance-stats/latest",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/cryptocurrency/info",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/trending/latest",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/trending/gainers-losers",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/trending/most-visited",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v2/simple/price",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/categories",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/category",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/airdrops",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/cryptocurrency/airdrop",
    "family": "cryptocurrency",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/exchange/derivatives/list",
    "family": "derivatives",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/exchange/derivatives/market-pairs/list/latest",
    "family": "derivatives",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/cryptocurrency/derivatives/market-pairs/list/latest",
    "family": "derivatives",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/derivatives/liquidations/quotes/latest",
    "family": "derivatives",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/derivatives/liquidations/exchange/list/latest",
    "family": "derivatives",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/derivatives/liquidations/cryptocurrency/list/latest",
    "family": "derivatives",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/platform/list",
    "family": "platform",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/platform/detail",
    "family": "platform",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/blockchain/statistics/latest",
    "family": "crypto-others",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/map",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/listings/latest",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/quotes/latest",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/quotes/historical",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/market-pairs/latest",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/assets",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/exchange/info",
    "family": "exchange",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/cmc-ai/coins/map",
    "family": "cmc-ai",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/cmc-ai/latest",
    "family": "cmc-ai",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/cmc-ai/coins/latest",
    "family": "cmc-ai",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/index/cmc100-historical",
    "family": "cmc-index",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/index/cmc100-latest",
    "family": "cmc-index",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/index/cmc20-historical",
    "family": "cmc-index",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/index/cmc20-latest",
    "family": "cmc-index",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/map",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/info",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/assets/list",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/market-pairs/list",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/quotes/latest",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/issuers/list",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v5/real-world-assets/issuers",
    "family": "real-world-assets",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/k-line/points",
    "family": "ohlcv",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/k-line/candles",
    "family": "ohlcv",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/community/trending/token",
    "family": "community",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/community/trending/topic",
    "family": "community",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/holders/list",
    "family": "holder",
    "deprecated": false
  },
  {
    "method": "POST",
    "path": "/v1/dex/holders/detail",
    "family": "holder",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/holders/trend/list",
    "family": "holder",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/holders/tag_count",
    "family": "holder",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/dex/holders/count",
    "family": "holder",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/fear-and-greed/historical",
    "family": "global-metrics",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v3/fear-and-greed/latest",
    "family": "global-metrics",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/global-metrics/quotes/historical",
    "family": "global-metrics",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/global-metrics/quotes/latest",
    "family": "global-metrics",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/altcoin-season-index/latest",
    "family": "global-metrics",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/altcoin-season-index/historical",
    "family": "global-metrics",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/content/latest",
    "family": "content",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/content/posts/comments",
    "family": "content",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/content/posts/latest",
    "family": "content",
    "deprecated": false
  },
  {
    "method": "GET",
    "path": "/v1/content/posts/top",
    "family": "content",
    "deprecated": false
  }
];
const BY_PATH = new Map(CATALOG.map((e) => [e.path, e]));
module.exports = { CATALOG, BY_PATH };
