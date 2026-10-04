import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, ruleProgress, withChecklist, withTrade } from '../strategy-utils';
export const orderFlowStrategy: StrategyModule = {
  key: 'order_flow', name: 'Order Flow / Volume Delta',
  description: 'Uses exchange taker buy/sell volume delta and CVD; candle volume alone is not treated as directional flow.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), flow = context.orderFlow;
    if (!flow || flow.length < cfg.swingLookback + 2 || flow.some(x => ![x.time, x.buyerInitiatedVolume, x.sellerInitiatedVolume, x.delta, x.cvd].every(Number.isFinite))) return withChecklist(noTrade(this.name, c, 'Exchange taker buy/sell volume delta is unavailable.'), [
      { direction: 'BUY', label: 'Live taker flow feed', passed: false, detail: 'Exchange buyer/seller initiated volume is required; candle volume is not substituted.' },
      { direction: 'SELL', label: 'Live taker flow feed', passed: false, detail: 'Exchange buyer/seller initiated volume is required; candle volume is not substituted.' },
    ]);
    const last = c.at(-1), f = flow.at(-1)!, prior = flow.slice(-cfg.swingLookback - 1, -1), deltaMean = prior.reduce((s, x) => s + Math.abs(x.delta), 0) / prior.length;
    if (!last || !deltaMean) return noTrade(this.name, c, 'Insufficient order-flow baseline.');
    if (f.time !== last.time || flow.at(-2)!.time !== c.at(-2)?.time) return noTrade(this.name, c, 'Order-flow and candle timestamps are not synchronized.');
    const support = Math.min(...c.slice(-cfg.swingLookback).map(x => x.low)), resistance = Math.max(...c.slice(-cfg.swingLookback).map(x => x.high));
    // CVD moves in the same direction as its delta by definition. Requiring negative
    // delta and rising CVD (or vice versa) on the same bar makes absorption impossible.
    const absorptionBuy = last.low <= support * (1 + cfg.breakoutRetestTolerancePct) && f.delta < -deltaMean * cfg.orderFlowDeltaMultiplier && last.close > last.open;
    const absorptionSell = last.high >= resistance * (1 - cfg.breakoutRetestTolerancePct) && f.delta > deltaMean * cfg.orderFlowDeltaMultiplier && last.close < last.open;
    const buySupport = last.low <= support * (1 + cfg.breakoutRetestTolerancePct), buyDelta = f.delta < -deltaMean * cfg.orderFlowDeltaMultiplier, buyCandle = last.close > last.open, buyBreak = last.close > c.at(-2)!.high;
    const sellResistance = last.high >= resistance * (1 - cfg.breakoutRetestTolerancePct), sellDelta = f.delta > deltaMean * cfg.orderFlowDeltaMultiplier, sellCandle = last.close < last.open, sellBreak = last.close < c.at(-2)!.low;
    const checklist = [
      { direction: 'BUY' as const, label: 'Price at support', passed: buySupport, detail: `Price must test the ${support.toFixed(2)} support area.` },
      { direction: 'BUY' as const, label: 'Sell pressure absorbed', passed: buyDelta, detail: `Taker delta ${f.delta.toFixed(2)} must be below -${(deltaMean * cfg.orderFlowDeltaMultiplier).toFixed(2)}.` },
      { direction: 'BUY' as const, label: 'Bullish rejection candle', passed: buyCandle, detail: 'Current candle must close above its open.' },
      { direction: 'BUY' as const, label: 'Bullish structure confirmation', passed: buyBreak, detail: `Close must exceed prior high ${c.at(-2)!.high.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Price at resistance', passed: sellResistance, detail: `Price must test the ${resistance.toFixed(2)} resistance area.` },
      { direction: 'SELL' as const, label: 'Buy pressure absorbed', passed: sellDelta, detail: `Taker delta ${f.delta.toFixed(2)} must exceed ${(deltaMean * cfg.orderFlowDeltaMultiplier).toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Bearish rejection candle', passed: sellCandle, detail: 'Current candle must close below its open.' },
      { direction: 'SELL' as const, label: 'Bearish structure confirmation', passed: sellBreak, detail: `Close must fall below prior low ${c.at(-2)!.low.toFixed(2)}.` },
    ];
    if (context.hasPosition) return withChecklist(noTrade(this.name, c, 'Position remains open; protective stop and target manage exits.'), checklist);
    if (absorptionBuy && buyBreak) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Strong negative taker delta at support was absorbed.', 'Price confirmed with a close above the prior candle high.'], 0.7, support), checklist);
    if (absorptionSell && sellBreak) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Strong positive taker delta at resistance was absorbed.', 'Price confirmed with a close below the prior candle low.'], 0.7, resistance), checklist);
    const score = Math.max(
      ruleProgress(buySupport, buyDelta, buyCandle, buyBreak),
      ruleProgress(sellResistance, sellDelta, sellCandle, sellBreak),
    );
    return withChecklist(noTrade(this.name, c, 'No confirmed absorption and structure break.', 'SIDEWAYS', score), checklist);
  },
};
