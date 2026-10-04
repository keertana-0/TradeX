import type { StrategyContext, StrategyModule } from '../strategy-types';
import { adx, closedCandles, configFor, ema, noTrade, ruleProgress, rsi, withChecklist, withTrade } from '../strategy-utils';
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
    const adxReady = strength.adx >= cfg.adxMinimum, volumeReady = last.volume > avgVol * cfg.volumeMultiplier;
    const buyEma = last.close > averages[n - 1], buyRsi = rs[n - 1] > cfg.momentumRsiLong, buyRoc = roc > 0, buyBreak = last.close > high;
    const sellEma = last.close < averages[n - 1], sellRsi = rs[n - 1] < cfg.momentumRsiShort, sellRoc = roc < 0, sellBreak = last.close < low;
    const checklist = [
      { direction: 'BUY' as const, label: 'Trend strength', passed: adxReady, detail: `ADX ${strength.adx.toFixed(1)} must be at least ${cfg.adxMinimum}.` },
      { direction: 'BUY' as const, label: 'Price above fast EMA', passed: buyEma, detail: `Close ${last.close.toFixed(2)} must exceed EMA${cfg.emaFast} (${averages[n - 1].toFixed(2)}).` },
      { direction: 'BUY' as const, label: 'Bullish RSI', passed: buyRsi, detail: `RSI ${rs[n - 1].toFixed(1)} must exceed ${cfg.momentumRsiLong}.` },
      { direction: 'BUY' as const, label: 'Positive rate of change', passed: buyRoc, detail: `ROC over ${cfg.momentumRocBars} bars is ${roc.toFixed(2)}%; it must be positive.` },
      { direction: 'BUY' as const, label: 'Volume expansion', passed: volumeReady, detail: `Volume must exceed ${cfg.volumeMultiplier}× recent average.` },
      { direction: 'BUY' as const, label: 'Break above recent range', passed: buyBreak, detail: `Close must exceed ${high.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Trend strength', passed: adxReady, detail: `ADX ${strength.adx.toFixed(1)} must be at least ${cfg.adxMinimum}.` },
      { direction: 'SELL' as const, label: 'Price below fast EMA', passed: sellEma, detail: `Close ${last.close.toFixed(2)} must fall below EMA${cfg.emaFast} (${averages[n - 1].toFixed(2)}).` },
      { direction: 'SELL' as const, label: 'Bearish RSI', passed: sellRsi, detail: `RSI ${rs[n - 1].toFixed(1)} must be below ${cfg.momentumRsiShort}.` },
      { direction: 'SELL' as const, label: 'Negative rate of change', passed: sellRoc, detail: `ROC over ${cfg.momentumRocBars} bars is ${roc.toFixed(2)}%; it must be negative.` },
      { direction: 'SELL' as const, label: 'Volume expansion', passed: volumeReady, detail: `Volume must exceed ${cfg.volumeMultiplier}× recent average.` },
      { direction: 'SELL' as const, label: 'Break below recent range', passed: sellBreak, detail: `Close must fall below ${low.toFixed(2)}.` },
    ];
    if (context.hasPosition) return withChecklist(noTrade(this.name, c, 'Position remains open; exit is managed by momentum fade, stop, target, or session limit.'), checklist);
    if (adxReady && buyEma && buyRsi && buyRoc && volumeReady && buyBreak) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}, ROC ${roc.toFixed(2)}%.`, 'Volume expanded and price closed above the prior range.'], 0.72), checklist);
    if (adxReady && sellEma && sellRsi && sellRoc && volumeReady && sellBreak) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}, ROC ${roc.toFixed(2)}%.`, 'Volume expanded and price closed below the prior range.'], 0.72), checklist);
    const score = Math.max(
      ruleProgress(adxReady, buyEma, buyRsi, buyRoc, volumeReady, buyBreak),
      ruleProgress(adxReady, sellEma, sellRsi, sellRoc, volumeReady, sellBreak),
    );
    return withChecklist(noTrade(this.name, c, 'Trend strength, volume, momentum, or range-break condition is missing.', 'SIDEWAYS', score), checklist);
  },
};
