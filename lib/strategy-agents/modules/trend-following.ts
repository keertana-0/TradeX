import type { StrategyContext, StrategyModule } from '../strategy-types';
import { adx, closedCandles, configFor, ema, noTrade, rsi, signal, withTrade } from '../strategy-utils';
export const trendFollowingStrategy: StrategyModule = {
  key: 'trend_following', name: 'Trend Following',
  description: 'Requires EMA alignment, ADX direction, RSI confirmation, and a pullback/rejection.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length;
    if (n < cfg.emaTrend + 3) return noTrade(this.name, c, `Warm-up requires ${cfg.emaTrend + 3} candles for the configured trend filter.`);
    const closes = c.map(x => x.close), e20 = ema(closes, cfg.emaFast), e50 = ema(closes, cfg.emaSlow), e200 = ema(closes, cfg.emaTrend), strength = adx(c, cfg.adxPeriod), rs = rsi(closes, cfg.rsiPeriod);
    if (!strength || !Number.isFinite(rs[n - 1])) return noTrade(this.name, c, 'ADX/RSI history is incomplete.');
    const last = c[n - 1], prev = c[n - 2], bullish = last.close > e20[n - 1] && e20[n - 1] > e50[n - 1] && e50[n - 1] > e200[n - 1] && strength.adx >= cfg.adxMinimum && strength.plus > strength.minus && rs[n - 1] > cfg.trendRsiLong;
    const bearish = last.close < e20[n - 1] && e20[n - 1] < e50[n - 1] && e50[n - 1] < e200[n - 1] && strength.adx >= cfg.adxMinimum && strength.minus > strength.plus && rs[n - 1] < cfg.trendRsiShort;
    if (context.hasPosition) {
      if (context.positionSide === 'LONG' && (last.close < e50[n - 1] || strength.adx < cfg.trendExitAdx || strength.minus > strength.plus)) return signal(this.name, c, 'EXIT', 'BEARISH', ['Trend filter no longer supports a long position.']);
      if (context.positionSide === 'SHORT' && (last.close > e50[n - 1] || strength.adx < cfg.trendExitAdx || strength.plus > strength.minus)) return signal(this.name, c, 'EXIT', 'BULLISH', ['Trend filter no longer supports a short position.']);
      return noTrade(this.name, c, 'Position remains open; trend exit filter has not fired.');
    }
    if (bullish && prev.low <= e20[n - 2] && last.close > prev.close) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`EMA${cfg.emaFast}>EMA${cfg.emaSlow}>EMA${cfg.emaTrend}.`, `ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}; pullback reclaimed EMA${cfg.emaFast}.`], 0.74);
    if (bearish && prev.high >= e20[n - 2] && last.close < prev.close) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`EMA${cfg.emaFast}<EMA${cfg.emaSlow}<EMA${cfg.emaTrend}.`, `ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}; pullback rejected EMA${cfg.emaFast}.`], 0.74);
    return noTrade(this.name, c, `Trend/pullback conditions incomplete (ADX ${strength.adx.toFixed(1)}).`, 'SIDEWAYS');
  },
};
