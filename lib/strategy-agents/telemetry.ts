import type { Candle } from '@/types/market';
import { calculateEMA } from '@/lib/analysis/indicators/ema';
import { calculateRSI } from '@/lib/analysis/indicators/rsi';
import { calculateATR } from '@/lib/analysis/indicators/atr';
import { calculateBollingerBands } from '@/lib/analysis/indicators/bollinger';
import { STRATEGY_MIN_CONFIDENCE } from './entry-policy';
import { STRATEGY_MODULES } from './strategies';
import type { StrategyContext, StrategyRuleCheck } from './strategy-types';

export interface StrategyConditionReport {
  strategyKey: string;
  strategyName: string;
  symbol: string;
  currentPrice: number;
  evaluatedBarTime: number | null;
  dataStale?: boolean;
  dataSource?: string;
  marketRegime: 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'VOLATILE';
  confidence: number;
  confidenceThreshold: number;
  conditionsMet: Array<{ label: string; detail: string; status: 'MET' }>;
  conditionsNeeded: Array<{ label: string; detail: string; status: 'PENDING' }>;
  supportPrice: number;
  resistancePrice: number;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  thesis: string;
  checklist: StrategyRuleCheck[];
}

export function analyzeStrategyConditions(
  strategyKey: string,
  strategyName: string,
  symbol: string,
  candles: Candle[],
  contextExtras: Pick<StrategyContext, 'orderFlow' | 'relatedSeries' | 'supportsPairedExecution' | 'hasPosition' | 'positionSide' | 'timeframeMinutes' | 'config'> = {},
  markPrice?: number,
): StrategyConditionReport {
  const n = candles.length;
  const last = candles[n - 1] || { close: 0, high: 0, low: 0, open: 0, volume: 0, time: 0 };
  const currentPrice = markPrice ?? last.close;
  const ema20 = calculateEMA(candles, 20).at(-1) ?? null;
  const ema50 = calculateEMA(candles, 50).at(-1) ?? null;
  const rsi14 = calculateRSI(candles, 14).at(-1) ?? null;
  const atr14 = calculateATR(candles, 14).at(-1) ?? null;
  const window = candles.slice(-30);
  const resistancePrice = window.length ? Math.max(...window.map((c) => c.high)) : currentPrice;
  const supportPrice = window.length ? Math.min(...window.map((c) => c.low)) : currentPrice;
  const strategyModule = STRATEGY_MODULES.find((item) => item.key === strategyKey);
  const output = strategyModule?.evaluate({ candles, ...contextExtras });
  const regime = output?.market_regime || 'UNKNOWN';
  const marketRegime = regime === 'UNKNOWN' ? 'SIDEWAYS' : regime;
  const hasSignal = output?.signal === 'LONG' || output?.signal === 'SHORT' || output?.signal === 'EXIT';
  const checklist: StrategyRuleCheck[] = output?.checklist?.length
    ? output.checklist
    : output?.signal === 'NO_TRADE'
      ? [
          { direction: 'BUY', label: 'Strategy buy setup', passed: false, detail: output.reason.join(' ') },
          { direction: 'SELL', label: 'Bearish signal / close-holding setup', passed: false, detail: output.reason.join(' ') },
        ]
      : [];
  const conditionsMet = checklist.length
    ? checklist.filter((item) => item.passed).map((item) => ({ label: `${item.direction}: ${item.label}`, detail: item.detail, status: 'MET' as const }))
    : hasSignal
      ? output!.reason.map((detail) => ({ label: output!.signal === 'EXIT' ? 'Exit rule triggered' : 'Entry rule confirmed', detail, status: 'MET' as const }))
    : [];
  const conditionsNeeded = checklist.length
    ? checklist.filter((item) => !item.passed).map((item) => ({ label: `${item.direction}: ${item.label}`, detail: item.detail, status: 'PENDING' as const }))
    : output?.signal === 'NO_TRADE'
      ? output.reason.map((detail) => ({ label: 'Rule not satisfied', detail, status: 'PENDING' as const }))
    : [];

  return {
    strategyKey,
    strategyName,
    symbol,
    currentPrice,
    evaluatedBarTime: candles.length ? last.time : null,
    marketRegime,
    // These are the strategy's rule scores, not statistically calibrated win probabilities.
    confidence: output?.confidence ?? 0,
    confidenceThreshold: STRATEGY_MIN_CONFIDENCE,
    conditionsMet,
    conditionsNeeded,
    supportPrice,
    resistancePrice,
    ema20: Number.isFinite(ema20) ? ema20 : null,
    ema50: Number.isFinite(ema50) ? ema50 : null,
    rsi14: Number.isFinite(rsi14) ? rsi14 : null,
    atr14: Number.isFinite(atr14) ? atr14 : null,
    thesis: strategyModule?.description || `${strategyName} strategy module is not registered.`,
    checklist,
  };
}
