import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, withTrade } from '../strategy-utils';
export const orderFlowStrategy: StrategyModule = {
  key: 'order_flow', name: 'Order Flow / Volume Delta',
  description: 'Requires exchange bid/ask volume delta and CVD; candle volume is not treated as order flow.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), flow = context.orderFlow;
    if (!flow || flow.length < cfg.swingLookback + 2 || flow.some(x => ![x.time, x.bidVolume, x.askVolume, x.delta, x.cvd].every(Number.isFinite))) return noTrade(this.name, c, 'Reliable bid/ask volume delta and cumulative delta are unavailable.');
    const last = c.at(-1), f = flow.at(-1)!, prior = flow.slice(-cfg.swingLookback - 1, -1), deltaMean = prior.reduce((s, x) => s + Math.abs(x.delta), 0) / prior.length;
    if (!last || !deltaMean) return noTrade(this.name, c, 'Insufficient order-flow baseline.');
    const support = Math.min(...c.slice(-cfg.swingLookback).map(x => x.low)), resistance = Math.max(...c.slice(-cfg.swingLookback).map(x => x.high));
    const absorptionBuy = last.low <= support * (1 + cfg.breakoutRetestTolerancePct) && f.delta < -deltaMean * cfg.orderFlowDeltaMultiplier && f.cvd > flow.at(-2)!.cvd && last.close > last.open;
    const absorptionSell = last.high >= resistance * (1 - cfg.breakoutRetestTolerancePct) && f.delta > deltaMean * cfg.orderFlowDeltaMultiplier && f.cvd < flow.at(-2)!.cvd && last.close < last.open;
    if (context.hasPosition) return noTrade(this.name, c, 'Position remains open; protective stop and target manage exits.');
    if (absorptionBuy && last.close > c.at(-2)!.high) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Strong negative delta at support did not extend price lower.', 'CVD improved and price broke short-term structure upward.'], 0.7, support);
    if (absorptionSell && last.close < c.at(-2)!.low) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Strong positive delta at resistance did not extend price higher.', 'CVD deteriorated and price broke short-term structure downward.'], 0.7, resistance);
    return noTrade(this.name, c, 'No confirmed absorption and structure break.', 'SIDEWAYS');
  },
};
