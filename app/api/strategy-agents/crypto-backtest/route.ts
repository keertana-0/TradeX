import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { CRYPTO_MARKETS, type CryptoSymbol } from '@/lib/market-data/crypto-provider';
import { runCryptoSpotBacktest } from '@/lib/strategy-agents/crypto-backtest';
import { STRATEGY_MODULES } from '@/lib/strategy-agents/strategies';
import type { StrategyKey } from '@/lib/strategy-agents/strategy-types';
import type { Candle } from '@/types/market';

export const dynamic = 'force-dynamic';
export const maxDuration = 600;

const DAY_MS = 24 * 60 * 60 * 1000;
// 730 days allows a little over two years of one-minute history.
const MAX_RANGE_DAYS = 730;
const BINANCE_BASES = ['https://api.binance.com', 'https://data-api.binance.vision'];
type BinanceKline = [number, string, string, string, string, string, number, string, number, string, string, string];

function parseUtcDate(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : null;
}

async function fetchMinuteCandles(pair: string, startTime: number, endTime: number, onPage?: (fraction: number) => void): Promise<{ candles: Candle[]; orderFlow: Array<{ time: number; buyerInitiatedVolume: number; sellerInitiatedVolume: number; delta: number; cvd: number }> }> {
  const candles: Candle[] = [];
  const orderFlow: Array<{ time: number; buyerInitiatedVolume: number; sellerInitiatedVolume: number; delta: number; cvd: number }> = [];
  let cvd = 0;
  let cursor = startTime;
  while (cursor <= endTime) {
    let rows: BinanceKline[] | null = null;
    let lastError = 'Binance returned no candle data.';
    for (const base of BINANCE_BASES) {
      try {
        const url = `${base}/api/v3/klines?symbol=${pair}&interval=1m&startTime=${cursor}&endTime=${endTime}&limit=1000`;
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15_000), headers: { Accept: 'application/json' } });
        if (!response.ok) { lastError = `Binance returned HTTP ${response.status} for ${pair}.`; continue; }
        const payload = await response.json();
        if (Array.isArray(payload)) { rows = payload as BinanceKline[]; break; }
        lastError = `Binance returned an invalid candle response for ${pair}.`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : `Could not download ${pair} candles.`;
      }
    }
    if (!rows) throw new Error(lastError);
    if (!rows.length) break;

    const now = Date.now();
    for (const row of rows) {
      const time = Math.floor(row[0] / 1000);
      const open = Number(row[1]), high = Number(row[2]), low = Number(row[3]), close = Number(row[4]), volume = Number(row[5]);
      if (row[0] < startTime || row[0] > endTime || row[6] >= now) continue;
      if (![time, open, high, low, close, volume].every(Number.isFinite) || low <= 0 || high < low) continue;
      candles.push({ time, open, high, low, close, volume });
      const buyerInitiatedVolume = Number(row[9]);
      const sellerInitiatedVolume = volume - buyerInitiatedVolume;
      if ([buyerInitiatedVolume, sellerInitiatedVolume].every(Number.isFinite) && buyerInitiatedVolume >= 0 && sellerInitiatedVolume >= 0) {
        const delta = buyerInitiatedVolume - sellerInitiatedVolume;
        cvd += delta;
        orderFlow.push({ time, buyerInitiatedVolume, sellerInitiatedVolume, delta, cvd });
      }
    }
    const lastOpenTime = rows.at(-1)![0];
    onPage?.(Math.min(1, Math.max(0, (lastOpenTime - startTime) / Math.max(1, endTime - startTime))));
    if (lastOpenTime < cursor || rows.length < 1000) break;
    cursor = lastOpenTime + 60_000;
  }
  return { candles, orderFlow };
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in to run a crypto backtest.' }, { status: 401 });

  try {
    const body = await request.json();
    const startTime = parseUtcDate(body?.startDate);
    const endDateStart = parseUtcDate(body?.endDate);
    if (startTime === null || endDateStart === null) return NextResponse.json({ error: 'Choose valid start and end dates.' }, { status: 400 });
    if (endDateStart < startTime) return NextResponse.json({ error: 'The end date must be on or after the start date.' }, { status: 400 });
    if (endDateStart > Date.now()) return NextResponse.json({ error: 'The end date cannot be in the future.' }, { status: 400 });
    const endTime = endDateStart + DAY_MS - 1;
    if (endTime - startTime + 1 > MAX_RANGE_DAYS * DAY_MS) return NextResponse.json({ error: `Choose a date range of ${MAX_RANGE_DAYS} days or less for one-minute backtesting.` }, { status: 400 });

    const budgets = {} as Record<StrategyKey, number>;
    for (const agent of STRATEGY_MODULES) {
      const agentKey = agent.key as StrategyKey;
      const budget = Number(body?.budgets?.[agentKey]);
      if (!Number.isFinite(budget) || budget < 1 || budget > 1_000_000_000) {
        return NextResponse.json({ error: `Enter a starting budget between 1 and 1,000,000,000 USDT for ${agent.name}.` }, { status: 400 });
      }
      budgets[agentKey] = budget;
    }

    const encoder = new TextEncoder();
    let cancelled = false;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          if (!cancelled) controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        void (async () => {
          try {
            let downloadProgress = 0;
            send({ type: 'progress', phase: 'download', percentage: 1, message: 'Starting 1-minute candle downloads…' });
            const snapshots = await Promise.all(CRYPTO_MARKETS.map(async (market, marketIndex) => ({
              symbol: market.symbol,
              ...await fetchMinuteCandles(market.pair, startTime, endTime, (fraction) => {
                const percentage = 5 + ((marketIndex + fraction) / CRYPTO_MARKETS.length) * 45;
                if (percentage > downloadProgress) {
                  downloadProgress = percentage;
                  send({ type: 'progress', phase: 'download', percentage, message: `Downloading ${market.symbol}/USDT 1-minute candles…` });
                }
              }),
            })));
            const candlesBySymbol = Object.fromEntries(snapshots.map((snapshot) => [snapshot.symbol, snapshot.candles])) as Record<CryptoSymbol, Candle[]>;
            const orderFlowBySymbol = Object.fromEntries(snapshots.map((snapshot) => [snapshot.symbol, snapshot.orderFlow])) as Parameters<typeof runCryptoSpotBacktest>[3];
            send({ type: 'progress', phase: 'backtest', percentage: 52, message: 'Candles downloaded. Preparing strategy agents…' });
            const backtest = await runCryptoSpotBacktest(candlesBySymbol, budgets, (strategyIndex, fraction, strategyName) => {
              const percentage = 55 + ((strategyIndex + fraction) / STRATEGY_MODULES.length) * 44;
              send({ type: 'progress', phase: 'backtest', percentage, message: `Backtesting ${strategyName} (${strategyIndex + 1}/${STRATEGY_MODULES.length})…` });
            }, orderFlowBySymbol);
            send({ type: 'result', payload: {
              backtest,
              data: snapshots.map((snapshot) => ({ symbol: `${snapshot.symbol}/USDT`, candles: snapshot.candles.length })),
              requestedRange: { startDate: body.startDate, endDate: body.endDate },
              maxRangeDays: MAX_RANGE_DAYS,
            } });
          } catch (error) {
            const message = error instanceof Error ? error.message : 'The crypto backtest could not be completed.';
            send({ type: 'error', message });
          } finally {
            if (!cancelled) controller.close();
          }
        })();
      },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The crypto backtest could not be completed.';
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
