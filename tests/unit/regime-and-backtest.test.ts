import { describe, it, expect } from 'vitest';
import { detectMarketRegime } from '@/lib/analysis/regime-engine';
import { analyzeOptionsSignal } from '@/lib/options/options-signal-engine';
import { runBacktestSimulation, runDailyOptionsBacktest } from '@/lib/analysis/backtesting-engine';
import { Candle } from '@/types/market';
import { OptionChainData } from '@/types/options';
import { DailyHistoricalOptionObservation } from '@/types/daily-options';

function generateSampleCandles(count: number, trend: 'up' | 'down' | 'flat'): Candle[] {
  const candles: Candle[] = [];
  let basePrice = 24000;
  const now = Math.floor(Date.now() / 1000);

  for (let i = 0; i < count; i++) {
    const delta = trend === 'up' ? 25 : trend === 'down' ? -25 : (i % 2 === 0 ? 10 : -10);
    basePrice += delta;
    candles.push({
      time: now - (count - i) * 86400,
      open: basePrice - 10,
      high: basePrice + 30,
      low: basePrice - 20,
      close: basePrice,
      volume: 150000,
    });
  }
  return candles;
}

describe('Market Regime & Options Signal Engine', () => {
  it('detects BULLISH regime on sustained upward candles and bullish PCR', () => {
    const candles = generateSampleCandles(60, 'up');
    const regime = detectMarketRegime(candles, 1.4, 25500, 25500);

    expect(regime.regime).toBe('BULLISH');
    expect(regime.confidence).toBeGreaterThan(30);
    expect(regime.trendStrength).toBeDefined();
    expect(regime.supportingFactors.length).toBeGreaterThan(0);
  });

  it('detects BEARISH regime on sustained downward candles and low PCR', () => {
    const candles = generateSampleCandles(60, 'down');
    const regime = detectMarketRegime(candles, 0.6, 22500, 22500);

    expect(regime.regime).toBe('BEARISH');
    expect(regime.confidence).toBeGreaterThan(30);
    expect(regime.supportingFactors.length).toBeGreaterThan(0);
  });

  it('returns INSUFFICIENT_DATA when candle history is below 20 bars', () => {
    const candles = generateSampleCandles(10, 'up');
    const regime = detectMarketRegime(candles, 1.2, 24000);

    expect(regime.regime).toBe('INSUFFICIENT_DATA');
    expect(regime.confidence).toBe(0);
  });

  it('evaluates LONG_CALL option trade on bullish regime with favorable asymmetry', () => {
    const candles = generateSampleCandles(60, 'up');
    const regime = detectMarketRegime(candles, 1.3, 25500, 25500);
    const spot = candles[candles.length - 1].close;

    const mockChain: OptionChainData = {
      underlyingSymbol: 'NIFTY50',
      underlyingPrice: spot,
      timestamp: new Date().toISOString(),
      expiryDates: [new Date(Date.now() + 7 * 86400000).toISOString()],
      selectedExpiry: new Date(Date.now() + 7 * 86400000).toISOString(),
      highestVolumeStrikeCE: { strike: 25500, volume: 50000 },
      highestVolumeStrikePE: { strike: 25500, volume: 40000 },
      pcr: { volumePcr: 1.2, oiPcr: 1.3 },
      dataSource: 'Test Provider',
      isDelayed: false,
      strikes: [
        {
          strikePrice: 25500,
          ce: { ltp: 150, change: 5, volume: 50000, oi: 100000, changeOi: 5000, iv: 14 },
          pe: { ltp: 140, change: -5, volume: 40000, oi: 90000, changeOi: -2000, iv: 14 },
        },
      ],
    };

    const signal = analyzeOptionsSignal(regime, mockChain, spot);
    expect(signal.signal).toBe('LONG_CALL');
    expect(signal.optionType).toBe('CE');
    expect(signal.strike).toBe(25500);
    expect(signal.riskReward).toBeGreaterThan(0.4);
  });

  it('refuses to simulate option trades without historical option prices', () => {
    const candles = generateSampleCandles(60, 'up');
    const result = runBacktestSimulation(candles, {
      symbol: 'NIFTY50',
      startingCapital: 500000,
      lotSize: 25,
      slippagePerUnit: 0.5,
      costPerTrade: 20,
      strategy: 'REGIME_MOMENTUM',
    });

    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.metrics.totalTrades).toBe(0);
  });

  it('runs only trades backed by timestamped historical option prices', () => {
    const candles = generateSampleCandles(60, 'up');
    const options = candles.flatMap((candle) => {
      const timestamp = new Date(candle.time * 1000).toISOString();
      const strike = Math.round(candle.close / 50) * 50;
      return (['CE', 'PE'] as const).map((optionType) => ({
        timestamp, underlying: 'NIFTY50', underlyingPrice: candle.close,
        expiry: '2099-01-01', strike, optionType, ltp: optionType === 'CE' ? 100 : 110,
      }));
    });
    const result = runBacktestSimulation(candles, {
      symbol: 'NIFTY50',
      startingCapital: 500000,
      lotSize: 25,
      slippagePerUnit: 0.5,
      costPerTrade: 20,
      strategy: 'REGIME_MOMENTUM',
    }, options);

    expect(result.status).toBe('SUCCESS');
    expect(result.metrics.totalTrades).toBeGreaterThan(0);
    expect(result.equityCurve.length).toBeGreaterThan(20);
    expect(result.regimePerformance.length).toBeGreaterThan(0);
  });

  it('uses the following session open and close for daily option trades', async () => {
    const observations: DailyHistoricalOptionObservation[] = [];
    const addDay = (date: string, open: number, close: number) => {
      for (const strike of [90, 110]) {
        for (const optionType of ['CE', 'PE'] as const) {
          observations.push({ date, underlying: 'NIFTY50', underlyingPrice: 100, expiry: '2025-02-27', strike, optionType, open, high: Math.max(open, close), low: Math.min(open, close), close, ltp: close });
        }
      }
    };
    addDay('2025-02-03', 5, 5);
    addDay('2025-02-04', 7, 3);
    const result = await runDailyOptionsBacktest({
      symbol: 'NIFTY50', startingCapital: 40_000, lotSize: 1, slippagePerUnit: 0, costPerTrade: 0,
      strategy: 'VOLATILITY_STRADDLE', strikeCount: 2, initialPerSideInvestment: 10_000,
    }, observations);

    expect(result.status).toBe('SUCCESS');
    expect(result.metrics.totalTrades).toBe(4);
    expect(result.trades.every((trade) => trade.date === '2025-02-04')).toBe(true);
    expect(result.trades.find((trade) => trade.strike === 110 && trade.optionType === 'CE')?.entryPrice).toBe(7);
    // The session low crossed the 50% stop (3.50 from a 7.00 adjusted entry),
    // so the stop price takes priority over the later daily close at 3.00.
    expect(result.trades.find((trade) => trade.strike === 110 && trade.optionType === 'CE')?.exitPrice).toBe(3.5);
  });

  it('does not create a daily fill when the next session lacks the selected contract', async () => {
    const rows: DailyHistoricalOptionObservation[] = [
      ...(['CE', 'PE'] as const).map((optionType) => ({ date: '2025-02-03', underlying: 'NIFTY50', underlyingPrice: 100, expiry: '2025-02-27', strike: 110, optionType, open: 5, high: 6, low: 4, close: 5, ltp: 5 })),
      { date: '2025-02-04', underlying: 'NIFTY50', underlyingPrice: 101, expiry: '2025-02-27', strike: 110, optionType: 'CE', open: 7, high: 8, low: 6, close: 7, ltp: 7 },
    ];
    const result = await runDailyOptionsBacktest({
      symbol: 'NIFTY50', startingCapital: 40_000, lotSize: 1, slippagePerUnit: 0, costPerTrade: 0,
      strategy: 'VOLATILITY_STRADDLE', strikeCount: 2, initialPerSideInvestment: 10_000,
    }, rows);
    expect(result.status).toBe('INSUFFICIENT_DATA');
    expect(result.trades).toHaveLength(0);
  });

  it('applies the per-leg stop and blocks a later entry when reduced equity cannot afford one lot', async () => {
    const observations: DailyHistoricalOptionObservation[] = [];
    const addDay = (date: string, open: number, close: number) => {
      for (const strike of [90, 110]) {
        for (const optionType of ['CE', 'PE'] as const) {
          observations.push({ date, underlying: 'NIFTY50', underlyingPrice: 100, expiry: '2025-02-27', strike, optionType, open, high: Math.max(open, close), low: Math.min(open, close), close, ltp: close });
        }
      }
    };
    addDay('2025-02-03', 5, 5);
    addDay('2025-02-04', 10, 1);
    addDay('2025-02-05', 10, 9);
    const result = await runDailyOptionsBacktest({
      symbol: 'NIFTY50', startingCapital: 4_000, lotSize: 1, slippagePerUnit: 0, costPerTrade: 0,
      strategy: 'VOLATILITY_STRADDLE', strikeCount: 2, initialPerSideInvestment: 1_000,
    }, observations);

    expect(result.status).toBe('SUCCESS');
    expect(result.dailyResults?.[0].pnl).toBe(-1_500);
    expect(result.dailyResults?.[1].pnl).toBe(0);
    expect(result.trades.every((trade) => trade.quantity === 75 && trade.lotSize === 75 && trade.lots === 1)).toBe(true);
    expect(result.trades).toHaveLength(4);
    expect(result.metrics.finalCapital).toBe(2_500);
  });
});
