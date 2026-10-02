import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, istDateKeyFromSeconds, noTrade, sessionMinute, withTrade } from '../strategy-utils';
export const vwapStrategy: StrategyModule = {
  key: 'vwap', name: 'Session VWAP',
  description: 'Trades a directional VWAP pullback and rejection; skips flat or repeatedly crossed sessions.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length;
    if (n < cfg.vwapMinimumSessionCandles) return noTrade(this.name, c, `At least ${cfg.vwapMinimumSessionCandles} candles are required.`);
    const today = istDateKeyFromSeconds(c[n - 1].time);
    const session = c.filter(x => istDateKeyFromSeconds(x.time) === today);
    if (session.length < cfg.vwapMinimumSessionCandles) return noTrade(this.name, c, 'Waiting for sufficient current-session VWAP history.');
    let vol = 0, pv = 0; const vwap = session.map(x => { const typical = (x.high + x.low + x.close) / 3; const weight = x.volume > 0 ? x.volume : 1; vol += weight; pv += typical * weight; return pv / vol; });
    const last = session.at(-1)!, prev = session.at(-2)!, now = vwap.at(-1)!, before = vwap.at(-2)!;
    const crossed = session.slice(-cfg.vwapCrossLimit - 1).reduce((count, x, i, a) => i > 0 && (a[i - 1].close - vwap[Math.max(0, vwap.length - a.length + i - 1)]) * (x.close - vwap[Math.max(0, vwap.length - a.length + i)]) < 0 ? count + 1 : count, 0);
    if (context.hasPosition) return noTrade(this.name, c, 'Position remains open; exit is managed by stop, target, or session close.');
    if (crossed >= cfg.vwapRepeatedCrossCount || Math.abs(now - before) < last.close * cfg.vwapSlopeMinimumPct) return noTrade(this.name, c, 'VWAP is flat or price has crossed it repeatedly.', 'SIDEWAYS');
    if (last.close > now && before > 0 && prev.low <= before * (1 + cfg.vwapRetestTolerancePct) && last.close > prev.high) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Price held rising session VWAP on pullback.', 'Bullish confirmation closed above prior high.'], 0.67, Math.min(prev.low, now * (1 - cfg.vwapRetestTolerancePct)));
    if (last.close < now && now < before && prev.high >= before * (1 - cfg.vwapRetestTolerancePct) && last.close < prev.low) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Price rejected declining session VWAP on retrace.', 'Bearish confirmation closed below prior low.'], 0.67, Math.max(prev.high, now * (1 + cfg.vwapRetestTolerancePct)));
    if (sessionMinute(last.time) < cfg.openingHour * 60 + cfg.openingMinute + cfg.openingRangeMinutes) return noTrade(this.name, c, `Waiting for the first ${cfg.openingRangeMinutes} minutes of session VWAP data.`);
    return noTrade(this.name, c, 'No directional VWAP retest and confirmation.', 'SIDEWAYS');
  },
};
