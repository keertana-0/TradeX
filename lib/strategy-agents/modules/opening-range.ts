import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, istDateKeyFromSeconds, noTrade, sessionMinute, withTrade } from '../strategy-utils';
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
    if (context.hasPosition) return noTrade(this.name, c, 'Position remains open; manage with configured stop, target, and session close.');
    if (last.close > high && last.close > last.open && last.volume >= avgVolume * cfg.volumeMultiplier) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`Closed above ${cfg.openingRangeMinutes}-minute range high ${high.toFixed(2)}.`, 'Break candle volume confirmed against opening-range average.'], 0.7, high);
    if (last.close < low && last.close < last.open && last.volume >= avgVolume * cfg.volumeMultiplier) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`Closed below ${cfg.openingRangeMinutes}-minute range low ${low.toFixed(2)}.`, 'Break candle volume confirmed against opening-range average.'], 0.7, low);
    return noTrade(this.name, c, 'Price remains in range or breakout volume/close is not confirmed.', 'SIDEWAYS');
  },
};
