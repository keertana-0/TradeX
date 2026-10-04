import type { Candle } from '@/types/market';
export const CRYPTO_MARKETS = [
  { symbol: 'BTC', pair: 'BTCUSDT', name: 'Bitcoin', yahooSymbol: 'BTC-USD', precision: 2, minQty: 0.0001 },
  { symbol: 'ETH', pair: 'ETHUSDT', name: 'Ethereum', yahooSymbol: 'ETH-USD', precision: 2, minQty: 0.001 },
  { symbol: 'SOL', pair: 'SOLUSDT', name: 'Solana', yahooSymbol: 'SOL-USD', precision: 2, minQty: 0.01 },
] as const;

export type CryptoSymbol = (typeof CRYPTO_MARKETS)[number]['symbol'];

export interface CryptoMarketSnapshot {
  symbol: CryptoSymbol;
  pair: string;
  name: string;
  instrumentKey: string;
  price: number;
  lastTradeAt: Date;
  candles: Candle[];
  /** Current forming kline for live analysis meters; never used to authorize fills. */
  liveCandle?: Candle | null;
  source: string;
  /** Binance quantity increment for the base asset. */
  quantityStep: number;
  /** Exchange taker flow, present only for Binance data. */
  orderFlow?: Array<{ time: number; buyerInitiatedVolume: number; sellerInitiatedVolume: number; delta: number; cvd: number }>;
  /** Higher-timeframe candle data for multi-TF analysis */
  candles15m?: Candle[];
  candles1h?: Candle[];
  candles1d?: Candle[];
  isStale?: boolean;
}

type BinanceKline = [
  number, // 0: open time (ms)
  string, // 1: open
  string, // 2: high
  string, // 3: low
  string, // 4: close
  string, // 5: volume
  number, // 6: close time (ms)
  string, // 7: quote volume
  number, // 8: count
  string, // 9: taker buy base
  string, // 10: taker buy quote
  string  // 11: ignore
];

/** Parse raw Binance klines into completed Candle[], excluding the current forming bar. */
function parseKlines(raw: BinanceKline[]): Candle[] {
  const candles: Candle[] = raw.flatMap((k) => {
    const time = Math.floor(k[0] / 1000);
    const open = parseFloat(k[1]), high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]), volume = parseFloat(k[5]);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) return [];
    return [{ time, open, high, low, close, volume }];
  });
  // Drop the last (currently forming) bar
  return candles.slice(0, -1);
}

/** Simple in-memory cache for HTF candles keyed by "PAIR:INTERVAL". */
const htfCache = new Map<string, { candles: Candle[]; fetchedAt: number }>();

/** Cache TTLs: don't re-fetch faster than the interval itself. */
const HTF_CACHE_TTL: Record<string, number> = { '15m': 15 * 60_000, '1h': 60 * 60_000, '1d': 6 * 60 * 60_000 };
/** Fetch higher-timeframe klines for one pair from Binance with caching. */
async function fetchHtfCandles(pair: string, interval: '15m' | '1h' | '1d', limit: number): Promise<Candle[]> {
  const cacheKey = `${pair}:${interval}`;
  const cached = htfCache.get(cacheKey);
  const ttl = HTF_CACHE_TTL[interval] || 60_000;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached.candles;

  const urls = [
    `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
    `https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}`,
  ];

  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'TradeX HTF Analysis' },
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000),
      });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data) && data.length >= 5) {
          const candles = parseKlines(data as BinanceKline[]);
          htfCache.set(cacheKey, { candles, fetchedAt: Date.now() });
          return candles;
        }
      }
    } catch { /* try next endpoint */ }
  }

  // Return cached even if stale, rather than nothing
  return cached?.candles || [];
}

export async function getCryptoMarketSnapshot(market: typeof CRYPTO_MARKETS[number]): Promise<CryptoMarketSnapshot> {
  const endpoints = [
    `https://api.binance.com/api/v3/klines?symbol=${market.pair}&interval=5m&limit=100`,
    `https://data-api.binance.vision/api/v3/klines?symbol=${market.pair}&interval=5m&limit=100`,
  ];

  let rawKlines: BinanceKline[] | null = null;
  let source = 'Binance 24/7 Live Feed';

  for (const url of endpoints) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'TradeX Crypto Paper Engine' },
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000),
      });
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data) && data.length >= 10) {
          rawKlines = data as BinanceKline[];
          break;
        }
      }
    } catch {
      // try next endpoint
    }
  }

  // Fallback to Yahoo Finance if Binance is unreachable
  if (!rawKlines) {
    try {
      const yUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(market.yahooSymbol)}?range=2d&interval=5m&includePrePost=false`;
      const yRes = await fetch(yUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'TradeX Crypto Engine' },
        cache: 'no-store',
        signal: AbortSignal.timeout(6_000),
      });
      if (yRes.ok) {
        const payload = await yRes.json();
        const result = payload.chart?.result?.[0];
        const quote = result?.indicators?.quote?.[0];
        const timestamps = result?.timestamp || [];
        if (timestamps.length >= 10 && quote) {
          const candles: Candle[] = timestamps.flatMap((time: number, i: number) => {
            const open = quote.open?.[i];
            const high = quote.high?.[i];
            const low = quote.low?.[i];
            const close = quote.close?.[i];
            const volume = quote.volume?.[i] ?? 0;
            if (![time, open, high, low, close].every(Number.isFinite) || !open || !high || !low || !close) return [];
            return [{ time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) }];
          });

          if (candles.length >= 5) {
            const currentBucket = Math.floor(Date.now() / 300_000) * 300;
            const completedCandles = candles.filter((candle) => candle.time < currentBucket).slice(-60);
            const liveCandle = candles.find((candle) => candle.time === currentBucket) || null;
            const newest = completedCandles.at(-1);
            if (!newest) throw new Error(`Waiting for a completed ${market.pair} candle.`);
            const price = Number(result?.meta?.regularMarketPrice ?? newest.close);
            const observedAt = Number(result?.meta?.regularMarketTime);
            return {
              symbol: market.symbol,
              pair: market.pair,
              name: market.name,
              instrumentKey: `${market.symbol}/USDT`,
              price,
              lastTradeAt: new Date(Number.isFinite(observedAt) && observedAt > 0 ? observedAt * 1000 : newest.time * 1000),
              candles: completedCandles,
              liveCandle,
              source: 'Yahoo Finance Crypto Feed',
              quantityStep: market.minQty,
            };
          }
        }
      }
    } catch {
      // fallback failed
    }
  }

  if (!rawKlines || rawKlines.length < 5) {
    throw new Error(`Unable to fetch real-time crypto candles for ${market.pair}.`);
  }

  const candles: Candle[] = rawKlines.flatMap((k) => {
    const time = Math.floor(k[0] / 1000);
    const open = parseFloat(k[1]);
    const high = parseFloat(k[2]);
    const low = parseFloat(k[3]);
    const close = parseFloat(k[4]);
    const volume = parseFloat(k[5]);
    if (![time, open, high, low, close, volume].every(Number.isFinite)) return [];
    return [{ time, open, high, low, close, volume }];
  });

  const lastKline = rawKlines.at(-1)!;
  const currentPrice = parseFloat(lastKline[4]);
  const lastTradeAt = new Date(lastKline[6]);
  let cvd = 0;
  const orderFlow = rawKlines.slice(0, -1).flatMap((k) => {
    const time = Math.floor(k[0] / 1000);
    const totalVolume = Number(k[5]);
    const buyerInitiatedVolume = Number(k[9]);
    const sellerInitiatedVolume = totalVolume - buyerInitiatedVolume;
    if (![time, totalVolume, buyerInitiatedVolume, sellerInitiatedVolume].every(Number.isFinite) || totalVolume < 0 || buyerInitiatedVolume < 0 || sellerInitiatedVolume < 0) return [];
    const delta = buyerInitiatedVolume - sellerInitiatedVolume;
    cvd += delta;
    return [{ time, buyerInitiatedVolume, sellerInitiatedVolume, delta, cvd }];
  });

  // Fetch higher-timeframe candles concurrently for multi-TF analysis
  const [candles15m, candles1h, candles1d] = await Promise.all([
    fetchHtfCandles(market.pair, '15m', 96),   // 96 × 15m = 24 hours
    fetchHtfCandles(market.pair, '1h', 168),    // 168 × 1h = 7 days
    fetchHtfCandles(market.pair, '1d', 60),     // 60 × 1d ≈ 2 months
  ]);

  return {
    symbol: market.symbol,
    pair: market.pair,
    name: market.name,
    instrumentKey: `${market.symbol}/USDT`,
    price: currentPrice,
    // The REST response contains the current in-progress kline close, so stamp the
    // observed quote time here; the completed candle timestamps remain exchange data.
    lastTradeAt: new Date(),
    // Exclude currently forming bar to only evaluate finalized completed bars
    candles: candles.slice(0, -1),
    liveCandle: candles.at(-1) || null,
    source,
    quantityStep: market.minQty,
    orderFlow,
    candles15m,
    candles1h,
    candles1d,
  };
}

export async function getCryptoMarketSnapshots(): Promise<CryptoMarketSnapshot[]> {
  const results = await Promise.allSettled(CRYPTO_MARKETS.map(getCryptoMarketSnapshot));
  return results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
}
