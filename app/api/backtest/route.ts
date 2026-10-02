import { NextRequest, NextResponse } from 'next/server';
import { BacktestConfig } from '@/types/backtest';
import { HistoricalOptionsCoverage } from '@/types/daily-options';
import { JugaadDailyOptionsProvider } from '@/lib/market-data/jugaad-daily-options-provider';
import { runDailyOptionsBacktest } from '@/lib/analysis/backtesting-engine';
import { getNseIndexOptionLotSize } from '@/lib/market-data/nse-index-lot-size';

export const runtime = 'nodejs';
export const maxDuration = 300;

const ALLOWED_SYMBOLS = new Set(['NIFTY50', 'BANKNIFTY', 'SENSEX']);

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return NextResponse.json({ error: 'Send backtest settings as a JSON object.' }, { status: 400 });
    body = parsed as Record<string, unknown>;
  }
  catch { return NextResponse.json({ error: 'Send backtest settings as JSON.' }, { status: 400 }); }

  const symbol = String(body.symbol || '').toUpperCase();
  const from = String(body.from || '');
  const to = String(body.to || '');
  const strikeCount = Number(body.strikeCount);
  const slippagePerUnit = Number(body.slippagePerUnit);
  const costPerTrade = Number(body.costPerTrade);
  const initialPerSideInvestment = Number(body.initialPerSideInvestment || 100_000);
  const tradingDays = body.tradingDays;

  if (!ALLOWED_SYMBOLS.has(symbol)) return NextResponse.json({ error: 'Choose NIFTY, BANK NIFTY, or SENSEX.' }, { status: 400 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || !Number.isFinite(Date.parse(`${from}T00:00:00Z`)) || !Number.isFinite(Date.parse(`${to}T00:00:00Z`))) {
    return NextResponse.json({ error: 'Choose a valid date range.' }, { status: 400 });
  }
  if (!Number.isInteger(strikeCount) || strikeCount < 2 || strikeCount > 40) return NextResponse.json({ error: 'Strike count must be an integer from 2 to 40.' }, { status: 400 });
  if (!Array.isArray(tradingDays) || tradingDays.length === 0 || tradingDays.some((day) => !Number.isInteger(day) || Number(day) < 1 || Number(day) > 5)) {
    return NextResponse.json({ error: 'Select at least one trading weekday from Monday to Friday.' }, { status: 400 });
  }
  if (!Number.isFinite(initialPerSideInvestment) || initialPerSideInvestment <= 0) {
    return NextResponse.json({ error: 'Investment per CE/PE side must be greater than zero.' }, { status: 400 });
  }
  if (!Number.isFinite(slippagePerUnit) || slippagePerUnit < 0 || !Number.isFinite(costPerTrade) || costPerTrade < 0) {
    return NextResponse.json({ error: 'Slippage and cost per order cannot be negative.' }, { status: 400 });
  }
  try {
    const config: BacktestConfig = {
      symbol, startingCapital: initialPerSideInvestment * 2 * strikeCount,
      lotSize: getNseIndexOptionLotSize(symbol, to), slippagePerUnit, costPerTrade, strategy: 'VOLATILITY_STRADDLE', strikeCount, initialPerSideInvestment, tradingDays: tradingDays as number[],
      backtestFrom: from, backtestTo: to,
    };
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        void (async () => {
          try {
            send({ type: 'status', message: `Fetching ${symbol === 'SENSEX' ? 'BSE' : 'NSE'} daily option contracts through Jugaad…` });
            const historyFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
            const dataset = await new JugaadDailyOptionsProvider().getHistoricalOptions(symbol, historyFrom, to);
            dataset.coverage.requestedFrom = from;
            send({ type: 'status', message: 'Cleaning daily option prices and applying the Expert Picks stop/target rules…' });
            const result = await runDailyOptionsBacktest(config, dataset.observations, async (progress) => {
              send({ type: 'progress', ...progress });
              await new Promise((resolve) => setTimeout(resolve, 0));
            });
            const exchangeName = symbol === 'SENSEX' ? 'BSE' : 'NSE';
            result.message = `${result.message || ''} Historical prices: ${dataset.provider} ${exchangeName} daily data. Lot sizes are selected by index and contract expiry.`.trim();
            result.dataSource = 'jugaad';
            result.dataGranularity = 'daily';
            result.coverage = dataset.coverage;
            result.dataQuality = dataset.quality;
            send({ type: 'result', result });
          } catch (error) {
            send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
          } finally { controller.close(); }
        })();
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive' } });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const status = /Jugaad\/NSE historical requests failed/i.test(detail) ? 502 : /no historical|no valid daily|unsupported|valid ISO|must be on or before|cannot be requested for future|limited to 180 calendar days/i.test(detail) ? 422 : 502;
    return NextResponse.json({ error: detail }, { status });
  }
}
