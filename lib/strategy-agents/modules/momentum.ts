import type { StrategyContext, StrategyModule } from '../strategy-types';
import { adx, closedCandles, configFor, ema, noTrade, rsi, withTrade } from '../strategy-utils';
export const momentumStrategy: StrategyModule = {
  key: 'momentum', name: 'Momentum',
  description: 'Requires EMA alignment, ADX, RSI, ROC, volume expansion, and a recent range break.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length, lookback = Math.max(5, cfg.rangeLookback);
    if (n < Math.max(lookback + 2, cfg.volumeLookback + 2, cfg.momentumRocBars + 2, cfg.adxPeriod * 2 + 1, cfg.emaFast + 2)) return noTrade(this.name, c, 'Insufficient momentum and volume history.');
    const strength = adx(c, cfg.adxPeriod), values = c.map(x => x.close), averages = ema(values, cfg.emaFast), rs = rsi(values, cfg.rsiPeriod), last = c[n - 1];
    if (!strength) return noTrade(this.name, c, 'ADX is not ready.');
    const baseline = c.slice(n - cfg.volumeLookback - 1, n - 1), avgVol = baseline.reduce((s, x) => s + x.volume, 0) / baseline.length;
    const high = Math.max(...c.slice(n - lookback - 1, n - 1).map(x => x.high)), low = Math.min(...c.slice(n - lookback - 1, n - 1).map(x => x.low));
    const roc = (last.close / c[n - cfg.momentumRocBars - 1].close - 1) * 100;
    if (context.hasPosition) return noTrade(this.name, c, 'Position remains open; exit is managed by momentum fade, stop, target, or session limit.');
    if (strength.adx >= cfg.adxMinimum && last.close > averages[n - 1] && rs[n - 1] > cfg.momentumRsiLong && roc > 0 && last.volume > avgVol * cfg.volumeMultiplier && last.close > high) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}, ROC ${roc.toFixed(2)}%.`, 'Volume expanded and price closed above the prior range.'], 0.72);
    if (strength.adx >= cfg.adxMinimum && last.close < averages[n - 1] && rs[n - 1] < cfg.momentumRsiShort && roc < 0 && last.volume > avgVol * cfg.volumeMultiplier && last.close < low) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}, ROC ${roc.toFixed(2)}%.`, 'Volume expanded and price closed below the prior range.'], 0.72);
    return noTrade(this.name, c, 'Trend strength, volume, momentum, or range-break condition is missing.', 'SIDEWAYS');
  },
};
