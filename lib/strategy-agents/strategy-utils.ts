import type { Candle } from '../../types/market';
import { DEFAULT_STRATEGY_CONFIG, type StrategyConfig, type StrategyContext, type StrategyRegime, type StrategyRuleCheck, type StrategySignal, type StrategySignalAction } from './strategy-types';
const istDateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const istMinuteFormatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export const istDateKeyFromSeconds = (seconds: number) => istDateFormatter.format(new Date(seconds * 1000));

export function configFor(context: StrategyContext): StrategyConfig {
  return { ...DEFAULT_STRATEGY_CONFIG, ...context.config, ...(context.timeframeMinutes ? { timeframeMinutes: context.timeframeMinutes } : {}) };
}
export function closedCandles(context: StrategyContext): Candle[] {
  const input = context.candles;
  let orderedAndValid = true;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) || c.high < c.low || c.low <= 0 || (i > 0 && input[i - 1].time > c.time)) { orderedAndValid = false; break; }
  }
  if (orderedAndValid) return input;
  return input.filter((c) => [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.high >= c.low && c.low > 0).sort((a, b) => a.time - b.time);
}
export function signal(name: string, candles: Candle[], action: StrategySignalAction, regime: StrategyRegime, reason: string[], stop: number | null = null, target: number | null = null, confidence = 0): StrategySignal {
  const last = candles.at(-1);
  const entry = action === 'LONG' || action === 'SHORT' ? last?.close ?? null : null;
  const risk = entry !== null && stop !== null ? Math.abs(entry - stop) : null;
  const reward = entry !== null && target !== null ? Math.abs(target - entry) : null;
  return {
    strategy: name, market_regime: regime, signal: action,
    confidence: Math.max(0, Math.min(1, confidence)), entry_price: entry,
    stop_loss: stop, target,
    risk_reward: risk && reward ? Number((reward / risk).toFixed(2)) : null,
    reason, timestamp: last ? new Date(last.time * 1000).toISOString() : new Date(0).toISOString(),
  };
}
export function noTrade(name: string, candles: Candle[], reason: string, regime: StrategyRegime = 'UNKNOWN', setupScore = 0): StrategySignal {
  return signal(name, candles, 'NO_TRADE', regime, [reason], null, null, Math.min(0.64, Math.max(0, setupScore)));
}
/** Fraction of the strategy's explicit entry checks currently satisfied; deliberately capped below the execution gate. */
export function ruleProgress(...checks: boolean[]): number {
  return checks.length ? Number((checks.filter(Boolean).length / checks.length * 0.64).toFixed(4)) : 0;
}
export function withChecklist<T extends StrategySignal>(output: T, checklist: StrategyRuleCheck[]): T {
  return { ...output, checklist };
}
export function atr(c: Candle[], period: number): number | null {
  if (c.length < period + 1) return null;
  const ranges = c.slice(-period).map((x, i) => {
    const previous = c[c.length - period + i - 1].close;
    return Math.max(x.high - x.low, Math.abs(x.high - previous), Math.abs(x.low - previous));
  });
  return ranges.reduce((a, b) => a + b, 0) / period;
}
export function ema(values: number[], period: number): number[] {
  const out: number[] = Array(values.length).fill(NaN); if (values.length < period) return out;
  let value = values.slice(0, period).reduce((a, b) => a + b, 0) / period; out[period - 1] = value;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) { value = values[i] * k + value * (1 - k); out[i] = value; }
  return out;
}
export function rsi(values: number[], period: number): number[] {
  const out: number[] = Array(values.length).fill(NaN); if (values.length <= period) return out;
  let up = 0, down = 0;
  for (let i = 1; i <= period; i++) { const d = values[i] - values[i - 1]; up += Math.max(0, d); down += Math.max(0, -d); }
  up /= period; down /= period; out[period] = down === 0 ? 100 : 100 - 100 / (1 + up / down);
  for (let i = period + 1; i < values.length; i++) { const d = values[i] - values[i - 1]; up = (up * (period - 1) + Math.max(0, d)) / period; down = (down * (period - 1) + Math.max(0, -d)) / period; out[i] = down === 0 ? 100 : 100 - 100 / (1 + up / down); }
  return out;
}
export function adx(c: Candle[], period: number): { adx: number; plus: number; minus: number } | null {
  if (c.length < period * 2 + 1) return null;
  const dx: number[] = []; let trSum = 0, plusSum = 0, minusSum = 0;
  const dm: Array<[number, number, number]> = [];
  for (let i = 1; i < c.length; i++) {
    const up = c[i].high - c[i - 1].high, down = c[i - 1].low - c[i].low;
    const tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    dm.push([tr, up > down && up > 0 ? up : 0, down > up && down > 0 ? down : 0]);
  }
  for (let i = 0; i < dm.length; i++) {
    const [tr, p, m] = dm[i]; trSum += tr; plusSum += p; minusSum += m;
    if (i >= period) { trSum -= dm[i - period][0]; plusSum -= dm[i - period][1]; minusSum -= dm[i - period][2]; }
    if (i >= period - 1) { const pdi = 100 * plusSum / trSum, mdi = 100 * minusSum / trSum; dx.push(pdi + mdi ? 100 * Math.abs(pdi - mdi) / (pdi + mdi) : 0); }
  }
  if (dx.length < period) return null;
  const value = dx.slice(-period).reduce((a, b) => a + b, 0) / period;
  const lastTr = dm.slice(-period).reduce((s, x) => s + x[0], 0);
  const lastP = dm.slice(-period).reduce((s, x) => s + x[1], 0);
  const lastM = dm.slice(-period).reduce((s, x) => s + x[2], 0);
  return { adx: value, plus: 100 * lastP / lastTr, minus: 100 * lastM / lastTr };
}
export function sessionMinute(time: number): number {
  const parts = istMinuteFormatter.format(new Date(time * 1000)).split(':').map(Number);
  return parts[0] * 60 + parts[1];
}
export function boundedStops(c: Candle[], direction: 'LONG' | 'SHORT', cfg: StrategyConfig, explicitStop?: number, explicitTarget?: number) {
  const last = c.at(-1)!; const volatility = atr(c, cfg.atrPeriod);
  if (!volatility || !Number.isFinite(volatility)) return { stop: null, target: null };
  const risk = Math.max(volatility * cfg.atrStopMultiple, last.close * cfg.stopFloorPct);
  const swing = c.slice(-cfg.swingLookback);
  const stop = explicitStop ?? (direction === 'LONG' ? Math.min(...swing.map(x => x.low), last.close - risk) : Math.max(...swing.map(x => x.high), last.close + risk));
  const target = explicitTarget ?? last.close + (direction === 'LONG' ? 1 : -1) * Math.abs(last.close - stop) * cfg.rewardRisk;
  if (direction === 'LONG' ? stop >= last.close || target <= last.close : stop <= last.close || target >= last.close) return { stop: null, target: null };
  return { stop, target };
}
export function withTrade(name: string, c: Candle[], direction: 'LONG' | 'SHORT', cfg: StrategyConfig, regime: StrategyRegime, reason: string[], confidence: number, stop?: number, target?: number): StrategySignal {
  const levels = boundedStops(c, direction, cfg, stop, target);
  if (levels.stop === null || levels.target === null) return noTrade(name, c, 'Insufficient volatility history to define a valid stop and target.', regime);
  return signal(name, c, direction, regime, reason, levels.stop, levels.target, confidence);
}
