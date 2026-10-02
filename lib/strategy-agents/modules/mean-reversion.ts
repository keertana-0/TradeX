import type { StrategyContext, StrategyModule } from '../strategy-types';
import { adx, closedCandles, configFor, noTrade, rsi, withTrade } from '../strategy-utils';
export const meanReversionStrategy: StrategyModule = {
  key: 'mean_reversion', name: 'Mean Reversion',
  description: 'Fades a Bollinger/RSI extreme only after reversal confirmation and outside a strong ADX trend.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length, p = cfg.bollingerPeriod;
    if (n < Math.max(p + 2, cfg.adxPeriod * 2 + 1)) return noTrade(this.name, c, 'Insufficient Bollinger, RSI, and ADX history.');
    const sample = c.slice(n - p - 1, n - 1).map(x => x.close), mean = sample.reduce((a, b) => a + b, 0) / p;
    const sd = Math.sqrt(sample.reduce((s, x) => s + (x - mean) ** 2, 0) / p), upper = mean + cfg.bollingerDeviation * sd, lower = mean - cfg.bollingerDeviation * sd;
    const values = c.map(x => x.close), rs = rsi(values, cfg.rsiPeriod), trend = adx(c, cfg.adxPeriod), last = c[n - 1], prev = c[n - 2];
    if (!trend) return noTrade(this.name, c, 'ADX is not ready.');
    if (context.hasPosition) return noTrade(this.name, c, 'Position remains open; exit is managed at the mean target or protective stop.');
    if (trend.adx >= cfg.adxMinimum) return noTrade(this.name, c, `Strong trend (ADX ${trend.adx.toFixed(1)}) disables mean-reversion entries.`, trend.plus > trend.minus ? 'BULLISH' : 'BEARISH');
    if (prev.close < lower && rs[n - 2] <= cfg.rsiOversold && last.close > prev.close && last.close > lower) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`Prior close below lower Bollinger band (${lower.toFixed(2)}).`, `RSI ${rs[n - 2].toFixed(1)} was oversold; current candle reclaimed the band.`, 'ADX is below the configured trend threshold.'], 0.66, prev.low, mean);
    if (prev.close > upper && rs[n - 2] >= cfg.rsiOverbought && last.close < prev.close && last.close < upper) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`Prior close above upper Bollinger band (${upper.toFixed(2)}).`, `RSI ${rs[n - 2].toFixed(1)} was overbought; current candle lost the band.`, 'ADX is below the configured trend threshold.'], 0.66, prev.high, mean);
    return noTrade(this.name, c, 'No confirmed band extreme and reversal candle.', 'SIDEWAYS');
  },
};
