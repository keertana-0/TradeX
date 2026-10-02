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
  source: string;
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
            const newest = candles.at(-1)!;
            const price = Number(result?.meta?.regularMarketPrice ?? newest.close);
            return {
              symbol: market.symbol,
              pair: market.pair,
              name: market.name,
              instrumentKey: `${market.symbol}/USDT`,
              price,
              lastTradeAt: new Date(newest.time * 1000),
              candles: candles.slice(-60),
              source: 'Yahoo Finance Crypto Feed',
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

  return {
    symbol: market.symbol,
    pair: market.pair,
    name: market.name,
    instrumentKey: `${market.symbol}/USDT`,
    price: currentPrice,
    lastTradeAt,
    // Exclude currently forming bar to only evaluate finalized completed bars
    candles: candles.slice(0, -1),
    source,
  };
}

export async function getCryptoMarketSnapshots(): Promise<CryptoMarketSnapshot[]> {
  return Promise.all(CRYPTO_MARKETS.map(getCryptoMarketSnapshot));
}
