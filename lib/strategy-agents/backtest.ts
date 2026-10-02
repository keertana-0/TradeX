import type { Candle } from '../../types/market';
import { DEFAULT_STRATEGY_CONFIG, STRATEGY_MODULES } from './strategies';
import type { StrategyModule, StrategySignal } from './strategy-types';
import { closedCandles, configFor } from './strategy-utils';
import { isAfterStrategyEntryStart, STRATEGY_ENTRY_START_IST, STRATEGY_MIN_CONFIDENCE } from './entry-policy';

export interface StrategyBacktestMetrics {
  winRate: number; profitFactor: number | null; totalReturnPct: number; maxDrawdownPct: number;
  averageR: number; sharpeRatio: number; numberOfTrades: number; averageHoldingMinutes: number;
  netProfit: number; grossProfit: number; grossLoss: number; feesAndSlippage: number;
}
export interface StrategyBacktestReport {
  strategy: string; key: string; timeframeMinutes: number; dataScope: 'NIFTY_SPOT_PROXY';
  periods: Record<'training' | 'validation' | 'testing', { from: string | null; to: string | null; metrics: StrategyBacktestMetrics }>;
  signalCounts: Record<string, number>;
  notes: string[];
}
type Trade = { entryTime: number; exitTime: number; entryPrice: number; exitPrice: number; side: 'LONG' | 'SHORT'; quantity: number; pnl: number; risk: number; charges: number; period: 'training' | 'validation' | 'testing' };
type Position = { side: 'LONG' | 'SHORT'; entry: number; rawEntry: number; stop: number; target: number; qty: number; entryTime: number; risk: number; fees: number; entryIndex: number };

const FEE_PER_SIDE = 20;
const SLIPPAGE_RATE = 0.0005;
const RISK_FRACTION = 0.005;
const MAX_EXPOSURE = 0.2;
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
const istDate = (seconds: number) => dateFormatter.format(new Date(seconds * 1000));
const emptyMetrics = (): StrategyBacktestMetrics => ({ winRate: 0, profitFactor: null, totalReturnPct: 0, maxDrawdownPct: 0, averageR: 0, sharpeRatio: 0, numberOfTrades: 0, averageHoldingMinutes: 0, netProfit: 0, grossProfit: 0, grossLoss: 0, feesAndSlippage: 0 });

function splitByTradingDay(candles: Candle[]) {
  const days = [...new Set(candles.map(c => istDate(c.time)))].sort();
  const trainingEnd = Math.max(1, Math.floor(days.length * 0.6));
  const validationEnd = Math.max(trainingEnd + 1, Math.floor(days.length * 0.8));
  const periodByDay = new Map<string, Trade['period']>();
  days.forEach((day, index) => periodByDay.set(day, index < trainingEnd ? 'training' : index < validationEnd ? 'validation' : 'testing'));
  return { days, periodByDay, bounds: {
    training: [days[0] || null, days[trainingEnd - 1] || null] as const,
    validation: [days[trainingEnd] || null, days[validationEnd - 1] || null] as const,
    testing: [days[validationEnd] || null, days.at(-1) || null] as const,
  } };
}

function computeMetrics(trades: Trade[], dailyEquity: Array<{ day: string; equity: number }>, startEquity: number, timeframeMinutes: number): StrategyBacktestMetrics {
  if (!trades.length) return emptyMetrics();
  const winners = trades.filter(t => t.pnl > 0), losers = trades.filter(t => t.pnl < 0);
  const netProfit = trades.reduce((s, t) => s + t.pnl, 0), grossProfit = winners.reduce((s, t) => s + t.pnl, 0), grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0));
  let peak = startEquity, maxDrawdown = 0;
  for (const point of dailyEquity) { peak = Math.max(peak, point.equity); maxDrawdown = Math.max(maxDrawdown, peak ? (peak - point.equity) / peak : 0); }
  const returns = dailyEquity.slice(1).map((item, i) => dailyEquity[i].equity > 0 ? item.equity / dailyEquity[i].equity - 1 : 0);
  const mean = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const std = returns.length > 1 ? Math.sqrt(returns.reduce((s, x) => s + (x - mean) ** 2, 0) / (returns.length - 1)) : 0;
  return {
    winRate: Number((winners.length / trades.length * 100).toFixed(2)), profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(3)) : grossProfit ? null : 0,
    totalReturnPct: Number((startEquity ? netProfit / startEquity * 100 : 0).toFixed(3)), maxDrawdownPct: Number((maxDrawdown * 100).toFixed(3)),
    averageR: Number((trades.reduce((s, t) => s + (t.risk ? t.pnl / t.risk : 0), 0) / trades.length).toFixed(3)),
    sharpeRatio: std ? Number((mean / std * Math.sqrt(252)).toFixed(3)) : 0,
    numberOfTrades: trades.length, averageHoldingMinutes: Number((trades.reduce((s, t) => s + (t.exitTime - t.entryTime) / 60, 0) / trades.length).toFixed(1)),
    netProfit: Number(netProfit.toFixed(2)), grossProfit: Number(grossProfit.toFixed(2)), grossLoss: Number(grossLoss.toFixed(2)),
    feesAndSlippage: Number(trades.reduce((s, t) => s + t.charges, 0).toFixed(2)),
  };
}

function priceWithSlippage(price: number, side: 'LONG' | 'SHORT', entering: boolean) {
  const buy = (side === 'LONG') === entering;
  return price * (buy ? 1 + SLIPPAGE_RATE : 1 - SLIPPAGE_RATE);
}

function backtestOne(module: StrategyModule, input: Candle[], timeframeMinutes: number) {
  const candles = closedCandles({ candles: input });
  const { periodByDay, bounds } = splitByTradingDay(candles);
  const trades: Trade[] = [], counts: Record<string, number> = {};
  const dailyEquity: Array<{ day: string; equity: number }> = [];
  let equity = 1_000_000, position: Position | null = null, dailyStartEquity = equity, currentDay = '';
  const recordedDays = new Set<string>();
  const recordDay = (day: string) => { if (day && !recordedDays.has(day)) { dailyEquity.push({ day, equity }); recordedDays.add(day); } };
  const close = (rawPrice: number, time: number, period: Trade['period'], gap = false) => {
    if (!position) return;
    const px = priceWithSlippage(rawPrice, position.side, false), direction = position.side === 'LONG' ? 1 : -1;
    const gross = (px - position.entry) * direction * position.qty;
    const charges = FEE_PER_SIDE;
    const exitSlippage = Math.abs(rawPrice - px) * position.qty;
    const pnl = gross - charges - position.fees;
    // Entry commission was removed from equity at entry; add only the position's marked P&L and exit fee now.
    equity += gross - charges;
    trades.push({ entryTime: candles[position.entryIndex].time, exitTime: time, entryPrice: position.entry, exitPrice: px, side: position.side, quantity: position.qty, pnl, risk: position.risk, charges: position.fees + charges + Math.abs(position.rawEntry - position.entry) * position.qty + exitSlippage, period });
    position = null;
  };
  for (let i = 0; i < candles.length - 1; i++) {
    const bar = candles[i], next = candles[i + 1], day = istDate(bar.time), period = periodByDay.get(day)!;
    if (day !== currentDay) { if (position) close(bar.close, bar.time, period); recordDay(currentDay); currentDay = day; dailyStartEquity = equity; }
    const history = candles.slice(Math.max(0, i - 250), i + 1); // Long enough for EMA200 warm-up while bounding streaming work.
    const decision = module.evaluate({ candles: history, hasPosition: !!position, positionSide: position?.side, timeframeMinutes });
    counts[decision.signal] = (counts[decision.signal] || 0) + 1;

    if (position) {
      const long = position.side === 'LONG';
      const stopTouched = long ? bar.low <= position.stop : bar.high >= position.stop;
      const targetTouched = long ? bar.high >= position.target : bar.low <= position.target;
      // If a one-minute bar reaches both, assume the protective stop was hit first.
      if (stopTouched) close(long && bar.open < position.stop ? bar.open : !long && bar.open > position.stop ? bar.open : position.stop, bar.time, period);
      else if (targetTouched) close(long && bar.open > position.target ? bar.open : !long && bar.open < position.target ? bar.open : position.target, bar.time, period);
      else if (decision.signal === 'EXIT' && next && istDate(next.time) === day) close(next.open, next.time, period);
      else if (next && istDate(next.time) !== day) close(bar.close, bar.time, period);
    }

    if (!position && (decision.signal === 'LONG' || decision.signal === 'SHORT') && decision.confidence >= STRATEGY_MIN_CONFIDENCE && isAfterStrategyEntryStart(new Date(next.time * 1000)) && istDate(next.time) === day && i < candles.length - 2) {
      const side = decision.signal, signalEntry = decision.entry_price;
      if (signalEntry === null || decision.stop_loss === null || decision.target === null) continue;
      const rawEntry = next.open, entry = priceWithSlippage(rawEntry, side, true);
      const sign = side === 'LONG' ? 1 : -1;
      const stopDistance = Math.abs(signalEntry - decision.stop_loss), targetDistance = Math.abs(decision.target - signalEntry);
      const stop = entry - sign * stopDistance, target = entry + sign * targetDistance;
      if ((side === 'LONG' && (stop >= entry || target <= entry)) || (side === 'SHORT' && (stop <= entry || target >= entry))) continue;
      const riskUnit = Math.max(Math.abs(entry - stop), entry * 0.0005), riskBudget = equity * 0.005, notionalLimit = equity * 0.2;
      const qty = Math.max(0, Math.min(Math.floor(riskBudget / riskUnit), Math.floor(notionalLimit / entry), Math.floor((equity * 0.2 - FEE_PER_SIDE) / entry)));
      if (!qty) continue;
      const entryFees = FEE_PER_SIDE, entrySlippage = Math.abs(rawEntry - entry) * qty, risk = riskUnit * qty + 2 * FEE_PER_SIDE + entrySlippage;
      equity -= entryFees;
      position = { side, entry, rawEntry, stop, target, qty, entryTime: next.time, risk, fees: entryFees, entryIndex: i + 1 };
      // A new position's first full OHLC interval begins on the next loop.
    }
    if (i === candles.length - 2 && position) close(bar.close, bar.time, period);
    if (istDate(next.time) !== day) recordDay(day);
  }
  if (position && candles.length) close(candles.at(-1)!.close, candles.at(-1)!.time, periodByDay.get(istDate(candles.at(-1)!.time))!);
  recordDay(currentDay);
  const periods = {} as StrategyBacktestReport['periods'];
  for (const period of ['training', 'validation', 'testing'] as const) {
    const [from, to] = bounds[period];
    const startEquity = period === 'training' ? 1_000_000 : period === 'validation' ? 1_000_000 + trades.filter(t => t.period === 'training').reduce((s, t) => s + t.pnl, 0) : 1_000_000 + trades.filter(t => t.period !== 'testing').reduce((s, t) => s + t.pnl, 0);
    periods[period] = { from, to, metrics: computeMetrics(trades.filter(t => t.period === period), dailyEquity.filter(x => x.day >= (from || '') && x.day <= (to || '')), startEquity, timeframeMinutes) };
  }
  return { periods, signalCounts: counts };
}

export function runIndependentStrategyBacktests(candles: Candle[], timeframeMinutes = 1) {
  const valid = closedCandles({ candles });
  const days = [...new Set(valid.map(c => istDate(c.time)))].sort();
  return {
    generatedAt: new Date().toISOString(), data: { symbol: 'NIFTY 50', firstTimestamp: valid[0] ? new Date(valid[0].time * 1000).toISOString() : null, lastTimestamp: valid.at(-1) ? new Date(valid.at(-1)!.time * 1000).toISOString() : null, tradingDays: days.length, candles: valid.length },
    methodology: { split: 'Chronological trading days: 60% training, 20% validation, 20% testing.', usesParameterFitting: false, execution: 'Hypothetical index spot units; signal at completed candle close, fill at next candle open.', entryGate: `All strategies require confidence >= ${(STRATEGY_MIN_CONFIDENCE * 100).toFixed(0)}% and entries are allowed from ${STRATEGY_ENTRY_START_IST} IST.`, fees: `${FEE_PER_SIDE} INR each side`, slippage: `${(SLIPPAGE_RATE * 100).toFixed(2)}% each side`, positionSizing: '0.5% of current equity risk and 20% maximum notional exposure; profits compound.', ambiguity: 'If stop and target both occur in one candle, stop is assumed first. Positions flatten at each session end.', limitation: 'This is not an options backtest. Premium, implied volatility, option bid/ask spread, lot size, expiry and Greeks are not modeled.' },
    config: { ...DEFAULT_STRATEGY_CONFIG, timeframeMinutes },
    strategies: STRATEGY_MODULES.map((module): StrategyBacktestReport => {
      const result = backtestOne(module, valid, timeframeMinutes);
      return { strategy: module.name, key: module.key, timeframeMinutes, dataScope: 'NIFTY_SPOT_PROXY', periods: result.periods, signalCounts: result.signalCounts, notes: ['Rule thresholds are fixed before validation/testing; no profitability claim is inferred from the training period.', 'Underlying direction is only a proxy for option strategy outcomes.'] };
    }),
  };
}
