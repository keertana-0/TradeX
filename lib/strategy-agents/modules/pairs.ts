import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, signal } from '../strategy-utils';
export const pairsStrategy: StrategyModule = {
  key: 'statistical_pairs', name: 'Statistical Mean Reversion / Pairs',
  description: 'Requires synchronized related-instrument closes, stable rolling correlation, and a spread z-score extreme.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), pair = Object.entries(context.relatedSeries || {})[0];
    if (!pair) return noTrade(this.name, c, 'No synchronized related instrument was supplied; pairs trading is disabled.');
    const [symbol, rows] = pair, aligned = rows.filter(x => Number.isFinite(x.time) && Number.isFinite(x.close) && x.close > 0).sort((a, b) => a.time - b.time);
    const common = new Map(aligned.map(x => [x.time, x.close]));
    const points = c.filter(x => common.has(x.time)).slice(-cfg.pairsLookback).map(x => [x.close, common.get(x.time)!] as const);
    if (points.length < cfg.pairsLookback) return noTrade(this.name, c, `Need ${cfg.pairsLookback} synchronized observations for ${symbol}.`);
    const x = points.map(p => Math.log(p[0])), y = points.map(p => Math.log(p[1])), mx = x.reduce((a, b) => a + b, 0) / x.length, my = y.reduce((a, b) => a + b, 0) / y.length;
    const cov = x.reduce((s, a, i) => s + (a - mx) * (y[i] - my), 0), vx = x.reduce((s, a) => s + (a - mx) ** 2, 0), vy = y.reduce((s, a) => s + (a - my) ** 2, 0), corr = cov / Math.sqrt(vx * vy);
    if (!Number.isFinite(corr) || corr < cfg.minCorrelation) return noTrade(this.name, c, `Rolling relationship with ${symbol} is weak (correlation ${Number(corr).toFixed(2)}).`);
    const beta = cov / vx, spread = x.map((v, i) => v - beta * y[i]), mean = spread.reduce((a, b) => a + b, 0) / spread.length, sd = Math.sqrt(spread.reduce((s, v) => s + (v - mean) ** 2, 0) / spread.length), z = (spread.at(-1)! - mean) / sd;
    if (!Number.isFinite(z) || sd === 0) return noTrade(this.name, c, 'Spread variance is zero or invalid.');
    if (context.hasPosition && Math.abs(z) <= cfg.pairsZExit) return signal(this.name, c, 'EXIT', 'SIDEWAYS', [`Spread z-score reverted to ${z.toFixed(2)}; close both ${symbol} legs.`]);
    if (context.hasPosition) return noTrade(this.name, c, `Paired position open; z=${z.toFixed(2)}, correlation=${corr.toFixed(2)}.`);
    if (z <= -cfg.pairsZEntry) return signal(this.name, c, 'LONG', 'BULLISH', [`Spread z-score ${z.toFixed(2)} <= -${cfg.pairsZEntry}; correlation ${corr.toFixed(2)}.`, `Pair instruction: long this instrument and short ${symbol}; execute both legs together.`], null, null, 0.65);
    if (z >= cfg.pairsZEntry) return signal(this.name, c, 'SHORT', 'BEARISH', [`Spread z-score ${z.toFixed(2)} >= +${cfg.pairsZEntry}; correlation ${corr.toFixed(2)}.`, `Pair instruction: short this instrument and long ${symbol}; execute both legs together.`], null, null, 0.65);
    return noTrade(this.name, c, `Spread z-score ${z.toFixed(2)} is inside the entry threshold.`, 'SIDEWAYS');
  },
};
