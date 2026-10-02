import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, signal, withTrade } from '../strategy-utils';
export const wyckoffStrategy: StrategyModule = {
  key: 'wyckoff', name: 'Wyckoff Spring / Upthrust',
  description: 'Looks for a range-edge spring or upthrust followed by reclaim/rejection and volume confirmation.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length, lookback = cfg.rangeLookback;
    if (n < lookback + cfg.wyckoffTrendLookback + 5) return noTrade(this.name, c, 'Insufficient range and preceding trend history.');
    const range = c.slice(n - lookback - 4, n - 4), low = Math.min(...range.map(x => x.low)), high = Math.max(...range.map(x => x.high));
    const width = high - low, avgVol = range.reduce((s, x) => s + x.volume, 0) / range.length;
    const priorDown = c[n - lookback - cfg.wyckoffTrendLookback].close > c[n - lookback - 1].close;
    const priorRise = c[n - lookback - cfg.wyckoffTrendLookback].close < c[n - lookback - 1].close;
    const spring = c[n - 2].low < low && c[n - 2].close > low;
    const upthrust = c[n - 2].high > high && c[n - 2].close < high;
    const volumeOk = avgVol > 0 && c[n - 2].volume >= avgVol * cfg.volumeMultiplier;
    if (context.hasPosition) {
      if (c[n - 1].close < low || c[n - 1].close > high) return signal(this.name, c, 'EXIT', 'UNKNOWN', ['Price invalidated the prior trading range.']);
      return noTrade(this.name, c, 'Position remains open; range invalidation not seen.');
    }
    if (priorDown && spring && volumeOk && c[n - 1].close > c[n - 2].high) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Range formed after a decline.', 'Spring reclaimed range support.', 'Confirmation closed above spring bar on elevated volume.'], 0.7, c[n - 2].low, c[n - 1].close + Math.max(width, c[n - 1].close * cfg.wyckoffTargetExtensionPct));
    if (priorRise && upthrust && volumeOk && c[n - 1].close < c[n - 2].low) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Range formed after an advance.', 'Upthrust failed above range resistance.', 'Weakness confirmed below upthrust bar on elevated volume.'], 0.7, c[n - 2].high, c[n - 1].close - Math.max(width, c[n - 1].close * cfg.wyckoffTargetExtensionPct));
    return noTrade(this.name, c, `No range-edge spring/upthrust with volume confirmation. Range width ${width.toFixed(2)}.`, 'SIDEWAYS');
  },
};
