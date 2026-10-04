import { describe, expect, it } from 'vitest';
import type { Candle } from '@/types/market';
import { STRATEGY_MODULES } from '@/lib/strategy-agents/strategies';
import { analyzeStrategyConditions } from '@/lib/strategy-agents/telemetry';
import { STRATEGY_MIN_CONFIDENCE } from '@/lib/strategy-agents/entry-policy';
import { calculatePaperExitCashReturn, calculatePaperPositionValue, calculatePaperRealizedPnl, calculatePaperUnrealizedPnl, cryptoSpotAction, floorQuantityToStep } from '@/lib/strategy-agents/crypto-paper-accounting';

function candlesForOrderFlow(direction: 'buy' | 'sell'): Candle[] {
  return Array.from({ length: 20 }, (_, index) => {
    const close = 100 + index * 0.2;
    return { time: 1_800_000_000 + index * 300, open: close - 0.1, high: close + 0.2, low: close - 0.2, close, volume: 100 };
  }).map((candle, index, list) => index === list.length - 1
    ? direction === 'buy'
      ? { ...candle, open: 95, high: 109, low: 90, close: 108 }
      : { ...candle, open: 105, high: 110, low: 91, close: 92 }
    : candle);
}

function flowFor(candles: Candle[], direction: 'buy' | 'sell') {
  let cvd = 0;
  return candles.map((candle, index) => {
    const delta = index === candles.length - 1 ? (direction === 'buy' ? -30 : 30) : 1;
    cvd += delta;
    return { time: candle.time, buyerInitiatedVolume: 50 + delta / 2, sellerInitiatedVolume: 50 - delta / 2, delta, cvd };
  });
}

describe('strategy modules', () => {
  it('exposes buy and bearish-close checklist items for all ten strategies', () => {
    const candles = Array.from({ length: 230 }, (_, index) => {
      const close = 100 + Math.sin(index / 6) * 2 + index * 0.005;
      return { time: 1_800_000_000 + index * 300, open: close - 0.15, high: close + 0.4, low: close - 0.4, close, volume: 100 + index % 5 };
    });
    for (const strategy of STRATEGY_MODULES) {
      const report = analyzeStrategyConditions(strategy.key, strategy.name, 'BTC/USDT', candles, { supportsPairedExecution: false });
      expect(report.checklist.length, strategy.key).toBeGreaterThan(0);
      expect(report.checklist.some((item) => item.direction === 'BUY'), strategy.key).toBe(true);
      expect(report.checklist.some((item) => item.direction === 'SELL'), strategy.key).toBe(true);
    }
  });

  it('reports partial strategy-rule progress below the execution gate for live unconfirmed setups', () => {
    const strategy = STRATEGY_MODULES.find((item) => item.key === 'trend_following')!;
    const candles = Array.from({ length: 230 }, (_, index) => {
      const close = 100 + index * 0.05 + Math.sin(index / 4) * 0.2;
      return { time: 1_800_000_000 + index * 300, open: close - 0.03, high: close + 0.2, low: close - 0.2, close, volume: 100 };
    });
    const output = strategy.evaluate({ candles });
    expect(output.signal).toBe('NO_TRADE');
    expect(output.confidence).toBeGreaterThan(0);
    expect(output.confidence).toBeLessThan(0.65);
  });

  it('uses spot-only actions: buys bullish setups and sells bearish setups only when holding', () => {
    expect(cryptoSpotAction('LONG', false)).toBe('BUY');
    expect(cryptoSpotAction('SHORT', false)).toBe('HOLD');
    expect(cryptoSpotAction('SHORT', true)).toBe('SELL');
    expect(cryptoSpotAction('EXIT', true)).toBe('SELL');
  });

  it('return well-formed no-trade signals when there is no candle history', () => {
    for (const strategy of STRATEGY_MODULES) {
      const output = strategy.evaluate({ candles: [] });
      expect(output.signal).toBe('NO_TRADE');
      expect(output.confidence).toBe(0);
      expect(output.entry_price).toBeNull();
    }
  });

  it('keeps order-flow signals possible using synchronized Binance taker-volume delta', () => {
    for (const direction of ['buy', 'sell'] as const) {
      const candles = candlesForOrderFlow(direction);
      const flow = flowFor(candles, direction);
      const output = STRATEGY_MODULES.find((strategy) => strategy.key === 'order_flow')!.evaluate({ candles, orderFlow: flow });
      expect(output.signal).toBe(direction === 'buy' ? 'LONG' : 'SHORT');
      expect(output.stop_loss).not.toBeNull();
      expect(output.target).not.toBeNull();
      expect(output.risk_reward).toBeCloseTo(2);
    }
  });

  it('does not emit a pairs trade when the executor cannot execute both legs', () => {
    const candles = candlesForOrderFlow('buy');
    const rows = candles.map(({ time, close }) => ({ time, close: close * 1.01 }));
    const output = STRATEGY_MODULES.find((strategy) => strategy.key === 'statistical_pairs')!.evaluate({ candles, relatedSeries: { ETH: rows } });
    expect(output.signal).toBe('NO_TRADE');
    expect(output.reason.join(' ')).toContain('cannot open and close both pair legs atomically');
  });

  it('uses the same live module signal and score in inspection telemetry', () => {
    const candles = candlesForOrderFlow('buy');
    const orderFlow = flowFor(candles, 'buy');
    const direct = STRATEGY_MODULES.find((strategy) => strategy.key === 'order_flow')!.evaluate({ candles, orderFlow });
    const report = analyzeStrategyConditions('order_flow', 'Order Flow', 'BTC/USDT', candles, { orderFlow });
    expect(report.confidence).toBe(direct.confidence);
    expect(report.confidenceThreshold).toBe(STRATEGY_MIN_CONFIDENCE);
    expect(report.confidenceThreshold).toBe(0.65);
    expect(report.conditionsMet.map((condition) => condition.detail)).toEqual(direct.checklist?.filter((item) => item.passed).map((item) => item.detail));
  });
});

describe('crypto paper accounting', () => {
  it('floors fractional asset size to the exchange increment without forcing one whole coin', () => {
    expect(floorQuantityToStep(0.00339, 0.0001)).toBe(0.0033);
    expect(floorQuantityToStep(0.00009, 0.0001)).toBe(0);
  });

  it('calculates short unrealized P&L and equity with the correct direction', () => {
    const position = { side: 'SHORT' as const, quantity: 2, entryPrice: 100, markPrice: 90, entryFee: 0.1, estimatedExitFee: 0.09 };
    expect(calculatePaperUnrealizedPnl(position)).toBeCloseTo(19.81);
    expect(calculatePaperPositionValue(position)).toBeCloseTo(219.91);
  });

  it('returns the reserved short collateral exactly once and reconciles to realized P&L', () => {
    const close = { side: 'SHORT' as const, quantity: 2, entryPrice: 100, exitPrice: 90, entryFee: 0.1, exitFee: 0.09 };
    const realized = calculatePaperRealizedPnl(close);
    const returnedCash = calculatePaperExitCashReturn(close);
    expect(realized).toBeCloseTo(19.81);
    expect(returnedCash).toBeCloseTo(219.91);
    expect(799.9 + returnedCash).toBeCloseTo(1_000 + realized);
  });

  it('calculates long P&L and close cash net of each fee exactly once', () => {
    const close = { side: 'LONG' as const, quantity: 2, entryPrice: 100, exitPrice: 110, entryFee: 0.1, exitFee: 0.11 };
    expect(calculatePaperRealizedPnl(close)).toBeCloseTo(19.79);
    expect(calculatePaperExitCashReturn(close)).toBeCloseTo(219.89);
  });
});
