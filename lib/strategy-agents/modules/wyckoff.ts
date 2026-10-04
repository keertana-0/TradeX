import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, ruleProgress, signal, withChecklist, withTrade } from '../strategy-utils';
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
    const buyConfirmed = c[n - 1].close > c[n - 2].high, sellConfirmed = c[n - 1].close < c[n - 2].low;
    const checklist = [
      { direction: 'BUY' as const, label: 'Prior decline into a trading range', passed: priorDown, detail: 'Price must trend down before the range forms.' },
      { direction: 'BUY' as const, label: 'Spring below range support', passed: spring, detail: `Price must dip below ${low.toFixed(2)} then close back above it.` },
      { direction: 'BUY' as const, label: 'Elevated spring volume', passed: volumeOk, detail: `Spring candle volume must be at least ${cfg.volumeMultiplier}× range average.` },
      { direction: 'BUY' as const, label: 'Bullish confirmation', passed: buyConfirmed, detail: 'Confirmation candle must close above the spring candle high.' },
      { direction: 'SELL' as const, label: 'Prior advance into a trading range', passed: priorRise, detail: 'Price must trend up before the range forms.' },
      { direction: 'SELL' as const, label: 'Upthrust above range resistance', passed: upthrust, detail: `Price must poke above ${high.toFixed(2)} then close back below it.` },
      { direction: 'SELL' as const, label: 'Elevated upthrust volume', passed: volumeOk, detail: `Upthrust candle volume must be at least ${cfg.volumeMultiplier}× range average.` },
      { direction: 'SELL' as const, label: 'Bearish confirmation', passed: sellConfirmed, detail: 'Confirmation candle must close below the upthrust candle low.' },
    ];
    if (context.hasPosition) {
      if (c[n - 1].close < low || c[n - 1].close > high) return withChecklist(signal(this.name, c, 'EXIT', 'UNKNOWN', ['Price invalidated the prior trading range.']), checklist);
      return withChecklist(noTrade(this.name, c, 'Position remains open; range invalidation not seen.'), checklist);
    }
    if (priorDown && spring && volumeOk && buyConfirmed) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Range formed after a decline.', 'Spring reclaimed range support.', 'Confirmation closed above spring bar on elevated volume.'], 0.7, c[n - 2].low, c[n - 1].close + Math.max(width, c[n - 1].close * cfg.wyckoffTargetExtensionPct)), checklist);
    if (priorRise && upthrust && volumeOk && sellConfirmed) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Range formed after an advance.', 'Upthrust failed above range resistance.', 'Weakness confirmed below upthrust bar on elevated volume.'], 0.7, c[n - 2].high, c[n - 1].close - Math.max(width, c[n - 1].close * cfg.wyckoffTargetExtensionPct)), checklist);
    const score = Math.max(
      ruleProgress(priorDown, spring, volumeOk, c[n - 1].close > c[n - 2].high),
      ruleProgress(priorRise, upthrust, volumeOk, c[n - 1].close < c[n - 2].low),
    );
    return withChecklist(noTrade(this.name, c, `No range-edge spring/upthrust with volume confirmation. Range width ${width.toFixed(2)}.`, 'SIDEWAYS', score), checklist);
  },
};
