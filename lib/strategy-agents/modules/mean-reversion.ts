import type { StrategyContext, StrategyModule } from '../strategy-types';
import { adx, closedCandles, configFor, noTrade, ruleProgress, rsi, withChecklist, withTrade } from '../strategy-utils';
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
    const buyExtreme = prev.close < lower, buyRsi = rs[n - 2] <= cfg.rsiOversold, buyTurn = last.close > prev.close && last.close > lower, trendOk = trend.adx < cfg.adxMinimum;
    const sellExtreme = prev.close > upper, sellRsi = rs[n - 2] >= cfg.rsiOverbought, sellTurn = last.close < prev.close && last.close < upper;
    const checklist = [
      { direction: 'BUY' as const, label: 'Below lower Bollinger band', passed: buyExtreme, detail: `Prior close must be below ${lower.toFixed(2)}.` },
      { direction: 'BUY' as const, label: 'Oversold RSI', passed: buyRsi, detail: `Prior RSI ${rs[n - 2].toFixed(1)} must be at or below ${cfg.rsiOversold}.` },
      { direction: 'BUY' as const, label: 'Bullish band reclaim', passed: buyTurn, detail: 'Current candle must rise and close back above the lower band.' },
      { direction: 'BUY' as const, label: 'No strong trend', passed: trendOk, detail: `ADX ${trend.adx.toFixed(1)} must stay below ${cfg.adxMinimum}.` },
      { direction: 'SELL' as const, label: 'Above upper Bollinger band', passed: sellExtreme, detail: `Prior close must be above ${upper.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Overbought RSI', passed: sellRsi, detail: `Prior RSI ${rs[n - 2].toFixed(1)} must be at or above ${cfg.rsiOverbought}.` },
      { direction: 'SELL' as const, label: 'Bearish band rejection', passed: sellTurn, detail: 'Current candle must fall and close back below the upper band.' },
      { direction: 'SELL' as const, label: 'No strong trend', passed: trendOk, detail: `ADX ${trend.adx.toFixed(1)} must stay below ${cfg.adxMinimum}.` },
    ];
    if (context.hasPosition) return withChecklist(noTrade(this.name, c, 'Position remains open; exit is managed at the mean target or protective stop.'), checklist);
    if (trend.adx >= cfg.adxMinimum) return withChecklist(noTrade(this.name, c, `Strong trend (ADX ${trend.adx.toFixed(1)}) disables mean-reversion entries.`, trend.plus > trend.minus ? 'BULLISH' : 'BEARISH'), checklist);
    if (buyExtreme && buyRsi && buyTurn && trendOk) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`Prior close below lower Bollinger band (${lower.toFixed(2)}).`, `RSI ${rs[n - 2].toFixed(1)} was oversold; current candle reclaimed the band.`, 'ADX is below the configured trend threshold.'], 0.66, prev.low, mean), checklist);
    if (sellExtreme && sellRsi && sellTurn && trendOk) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`Prior close above upper Bollinger band (${upper.toFixed(2)}).`, `RSI ${rs[n - 2].toFixed(1)} was overbought; current candle lost the band.`, 'ADX is below the configured trend threshold.'], 0.66, prev.high, mean), checklist);
    const score = Math.max(
      ruleProgress(trend.adx < cfg.adxMinimum, prev.close < lower, rs[n - 2] <= cfg.rsiOversold, last.close > prev.close && last.close > lower),
      ruleProgress(trend.adx < cfg.adxMinimum, prev.close > upper, rs[n - 2] >= cfg.rsiOverbought, last.close < prev.close && last.close < upper),
    );
    return withChecklist(noTrade(this.name, c, 'No confirmed band extreme and reversal candle.', 'SIDEWAYS', score), checklist);
  },
};
