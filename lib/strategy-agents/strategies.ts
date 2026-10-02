import type { Candle } from '../../types/market';
import type { StrategyContext, StrategySignal, StrategyKey } from './strategy-types';
import { DEFAULT_STRATEGY_CONFIG } from './strategy-types';
import { ictSmcStrategy } from './modules/ict-smc';
import { wyckoffStrategy } from './modules/wyckoff';
import { trendFollowingStrategy } from './modules/trend-following';
import { breakoutRetestStrategy } from './modules/breakout-retest';
import { meanReversionStrategy } from './modules/mean-reversion';
import { vwapStrategy } from './modules/vwap';
import { openingRangeStrategy } from './modules/opening-range';
import { momentumStrategy } from './modules/momentum';
import { orderFlowStrategy } from './modules/order-flow';
import { pairsStrategy } from './modules/pairs';

export { DEFAULT_STRATEGY_CONFIG };
export type { StrategyKey } from './strategy-types';
export const STRATEGY_MODULES = [ictSmcStrategy, wyckoffStrategy, trendFollowingStrategy, breakoutRetestStrategy, meanReversionStrategy, vwapStrategy, openingRangeStrategy, momentumStrategy, orderFlowStrategy, pairsStrategy] as const;
export const STRATEGY_DEFINITIONS = STRATEGY_MODULES.map(({ key, name, description }) => ({ key, name, description, stopAtr: DEFAULT_STRATEGY_CONFIG.atrStopMultiple, targetAtr: DEFAULT_STRATEGY_CONFIG.rewardRisk }));
export type StrategyDecision = { action: 'BUY' | 'SELL' | 'HOLD'; reason: string; output: StrategySignal };
export type StrategyDecisionMap = Record<StrategyKey, StrategyDecision>;

/** Pure, deterministic one-candle-at-a-time strategy evaluation. Call after appending a completed candle. */
export function evaluateStrategySignals(context: StrategyContext): Record<StrategyKey, StrategySignal> {
  return Object.fromEntries(STRATEGY_MODULES.map((module) => [module.key, module.evaluate(context)])) as Record<StrategyKey, StrategySignal>;
}

/** Compatibility adapter for the current long-only spot paper executor. */
export function evaluateStrategies(candles: Candle[], openKeys: Set<StrategyKey>): { decisions: StrategyDecisionMap; atr: number } {
  const context: StrategyContext = { candles, config: DEFAULT_STRATEGY_CONFIG };
  const outputs = Object.fromEntries(STRATEGY_MODULES.map((module) => { const key = module.key as StrategyKey; return [key, module.evaluate({ ...context, hasPosition: openKeys.has(key), positionSide: openKeys.has(key) ? 'LONG' : undefined })]; })) as Record<StrategyKey, StrategySignal>;
  const decisions = Object.fromEntries(STRATEGY_MODULES.map((module) => {
    const key = module.key as StrategyKey;
    const output = outputs[key];
    // The existing executor is long-only and spot-only. Do not mis-execute a bearish setup as a short trade.
    const action = output.signal === 'LONG' ? 'BUY' : output.signal === 'EXIT' && openKeys.has(key) ? 'SELL' : 'HOLD';
    const reason = output.signal === 'SHORT' ? `${output.reason.join(' ')} Short setup logged; current paper executor has no short/options contract execution.` : output.reason.join(' ');
    return [module.key, { action, reason, output }];
  })) as StrategyDecisionMap;
  const last = candles.at(-1);
  return { decisions, atr: last ? Math.max(last.high - last.low, last.close * 0.001) : 0 };
}
