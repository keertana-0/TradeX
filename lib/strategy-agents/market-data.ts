import type { Candle } from '@/types/market';

export const STRATEGY_MARKETS = [
  { symbol: 'NIFTY', yahooSymbol: '^NSEI', name: 'NIFTY 50' },
  { symbol: 'BANKNIFTY', yahooSymbol: '^NSEBANK', name: 'NIFTY BANK' },
  { symbol: 'SENSEX', yahooSymbol: '^BSESN', name: 'S&P BSE SENSEX' },
] as const;
export type StrategyMarketSymbol = (typeof STRATEGY_MARKETS)[number]['symbol'];

export interface StrategyMarketSnapshot {
  symbol: StrategyMarketSymbol;
  yahooSymbol: string;
  name: string;
  instrumentKey: string;
  price: number;
  lastTradeAt: Date;
  candles: Candle[];
  source: 'Yahoo Finance chart';
}

type YahooChart = {
  chart?: { error?: { description?: string }; result?: Array<{
    meta?: { regularMarketPrice?: number; regularMarketTime?: number; currency?: string; exchangeName?: string };
    timestamp?: number[];
    indicators?: { quote?: Array<{ open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }> };
  }> };
};

export function timeframeMinutes(): number {
  const parsed = Number(process.env.STRATEGY_AGENT_TIMEFRAME_MINUTES || 5);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 60 ? parsed : 5;
}

function resample(candles: Candle[], minutes: number): Candle[] {
  if (minutes <= 1) {
    const currentBucket = Math.floor(Date.now() / 60_000) * 60;
    return candles.filter(c => c.time < currentBucket);
  }
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const key = Math.floor(candle.time / (minutes * 60)) * minutes * 60;
    const found = buckets.get(key);
    if (found) { found.high = Math.max(found.high, candle.high); found.low = Math.min(found.low, candle.low); found.close = candle.close; found.volume += candle.volume; }
    else buckets.set(key, { ...candle, time: key });
  }
  // Only return fully formed bars. Current partially forming interval is intentionally withheld.
  const currentBucket = Math.floor(Date.now() / (minutes * 60_000)) * minutes * 60;
  return [...buckets.values()].filter(c => c.time < currentBucket).sort((a, b) => a.time - b.time);
}

export async function getYahooMarketSnapshot(market: typeof STRATEGY_MARKETS[number]): Promise<StrategyMarketSnapshot> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(market.yahooSymbol)}?range=1d&interval=1m&includePrePost=false`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 TradeX paper strategy monitor' },
    cache: 'no-store', signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Yahoo Finance returned HTTP ${response.status} for ${market.symbol}.`);
  const payload = await response.json() as YahooChart;
  const result = payload.chart?.result?.[0];
  if (payload.chart?.error || !result) throw new Error(payload.chart?.error?.description || `Yahoo Finance has no intraday chart for ${market.symbol}.`);
  const quote = result.indicators?.quote?.[0];
  const candles: Candle[] = (result.timestamp || []).flatMap((time, i) => {
    const open = quote?.open?.[i], high = quote?.high?.[i], low = quote?.low?.[i], close = quote?.close?.[i], volume = quote?.volume?.[i] ?? 0;
    if (![time, open, high, low, close, volume].every(Number.isFinite) || !open || !high || !low || !close) return [];
    return [{ time, open: Number(open), high: Number(high), low: Number(low), close: Number(close), volume: Number(volume) }];
  });
  const sampled = resample(candles, timeframeMinutes());
  const newest = candles.at(-1);
  const price = Number(result.meta?.regularMarketPrice ?? newest?.close);
  const lastTradeAt = new Date((result.meta?.regularMarketTime ?? newest?.time ?? 0) * 1000);
  if (!Number.isFinite(price) || price <= 0 || !newest || !Number.isFinite(lastTradeAt.getTime())) throw new Error(`Yahoo Finance has not returned a usable live quote for ${market.symbol}.`);
  if (sampled.length < 2) throw new Error(`Waiting for completed ${timeframeMinutes()}-minute ${market.symbol} candles from Yahoo Finance.`);
  return { ...market, instrumentKey: market.yahooSymbol, price, lastTradeAt, candles: sampled, source: 'Yahoo Finance chart' };
}

export async function getYahooMarketSnapshots(): Promise<StrategyMarketSnapshot[]> {
  return Promise.all(STRATEGY_MARKETS.map(getYahooMarketSnapshot));
}

/** Kept for compatibility while the portfolio runner is migrated to the three-index feed. */
export async function getStrategyMarketSnapshot(): Promise<StrategyMarketSnapshot> {
  return getYahooMarketSnapshot(STRATEGY_MARKETS[0]);
}
