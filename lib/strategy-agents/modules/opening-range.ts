import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, istDateKeyFromSeconds, noTrade, ruleProgress, sessionMinute, withChecklist, withTrade } from '../strategy-utils';
export const openingRangeStrategy: StrategyModule = {
  key: 'opening_range', name: 'Opening Range Breakout',
  description: 'Builds a configurable opening range, then trades only a volume-confirmed close outside it.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length;
    if (!n) return noTrade(this.name, c, 'No candles received.');
    const last = c[n - 1], date = istDateKeyFromSeconds(last.time);
    const day = c.filter(x => istDateKeyFromSeconds(x.time) === date);
    const start = cfg.openingHour * 60 + cfg.openingMinute, end = start + cfg.openingRangeMinutes;
    const range = day.filter(x => sessionMinute(x.time) >= start && sessionMinute(x.time) < end);
    if (sessionMinute(last.time) < end || range.length < Math.max(1, Math.floor(cfg.openingRangeMinutes / cfg.timeframeMinutes))) return noTrade(this.name, c, `Building the ${cfg.openingRangeMinutes}-minute opening range.`);
    const high = Math.max(...range.map(x => x.high)), low = Math.min(...range.map(x => x.low));
    const avgVolume = range.reduce((s, x) => s + x.volume, 0) / range.length;
    const buyBreak = last.close > high, buyCandle = last.close > last.open, volumeOk = last.volume >= avgVolume * cfg.volumeMultiplier;
    const sellBreak = last.close < low, sellCandle = last.close < last.open;
    const checklist = [
      { direction: 'BUY' as const, label: 'Opening range formed', passed: true, detail: `${range.length} candles have formed the ${cfg.openingRangeMinutes}-minute range.` },
      { direction: 'BUY' as const, label: 'Close above range high', passed: buyBreak, detail: `Close must exceed ${high.toFixed(2)}.` },
      { direction: 'BUY' as const, label: 'Bullish breakout candle', passed: buyCandle, detail: 'Break candle must close above its open.' },
      { direction: 'BUY' as const, label: 'Breakout volume confirmation', passed: volumeOk, detail: `Volume must be at least ${cfg.volumeMultiplier}× range average.` },
      { direction: 'SELL' as const, label: 'Opening range formed', passed: true, detail: `${range.length} candles have formed the ${cfg.openingRangeMinutes}-minute range.` },
      { direction: 'SELL' as const, label: 'Close below range low', passed: sellBreak, detail: `Close must fall below ${low.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Bearish breakout candle', passed: sellCandle, detail: 'Break candle must close below its open.' },
      { direction: 'SELL' as const, label: 'Breakout volume confirmation', passed: volumeOk, detail: `Volume must be at least ${cfg.volumeMultiplier}× range average.` },
    ];
    if (context.hasPosition) return withChecklist(noTrade(this.name, c, 'Position remains open; manage with configured stop, target, and session close.'), checklist);
    if (buyBreak && buyCandle && volumeOk) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`Closed above ${cfg.openingRangeMinutes}-minute range high ${high.toFixed(2)}.`, 'Break candle volume confirmed against opening-range average.'], 0.7, high), checklist);
    if (sellBreak && sellCandle && volumeOk) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`Closed below ${cfg.openingRangeMinutes}-minute range low ${low.toFixed(2)}.`, 'Break candle volume confirmed against opening-range average.'], 0.7, low), checklist);
    const score = Math.max(
      ruleProgress(last.close > high, last.close > last.open, last.volume >= avgVolume * cfg.volumeMultiplier),
      ruleProgress(last.close < low, last.close < last.open, last.volume >= avgVolume * cfg.volumeMultiplier),
    );
    return withChecklist(noTrade(this.name, c, 'Price remains in range or breakout volume/close is not confirmed.', 'SIDEWAYS', score), checklist);
  },
};
