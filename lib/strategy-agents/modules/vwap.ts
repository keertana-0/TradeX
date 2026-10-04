import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, istDateKeyFromSeconds, noTrade, ruleProgress, sessionMinute, withChecklist, withTrade } from '../strategy-utils';
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
    const rising = now > before, falling = now < before, priceAbove = last.close > now, priceBelow = last.close < now;
    const buyRetest = prev.low <= before * (1 + cfg.vwapRetestTolerancePct), buyConfirm = last.close > prev.high;
    const sellRetest = prev.high >= before * (1 - cfg.vwapRetestTolerancePct), sellConfirm = last.close < prev.low;
    const cleanVwap = crossed < cfg.vwapRepeatedCrossCount && Math.abs(now - before) >= last.close * cfg.vwapSlopeMinimumPct;
    const checklist = [
      { direction: 'BUY' as const, label: 'Rising VWAP', passed: rising, detail: `Current VWAP ${now.toFixed(2)} must be above prior VWAP ${before.toFixed(2)}.` },
      { direction: 'BUY' as const, label: 'Price above VWAP', passed: priceAbove, detail: `Close ${last.close.toFixed(2)} must be above VWAP ${now.toFixed(2)}.` },
      { direction: 'BUY' as const, label: 'Pullback retest', passed: buyRetest, detail: 'Prior candle low must retest the prior VWAP within configured tolerance.' },
      { direction: 'BUY' as const, label: 'Bullish confirmation', passed: buyConfirm, detail: 'Current close must break above the prior candle high.' },
      { direction: 'BUY' as const, label: 'VWAP not flat or repeatedly crossed', passed: cleanVwap, detail: `Cross count ${crossed}; require fewer than ${cfg.vwapRepeatedCrossCount} and sufficient slope.` },
      { direction: 'SELL' as const, label: 'Falling VWAP', passed: falling, detail: `Current VWAP ${now.toFixed(2)} must be below prior VWAP ${before.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Price below VWAP', passed: priceBelow, detail: `Close ${last.close.toFixed(2)} must be below VWAP ${now.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Rally retest', passed: sellRetest, detail: 'Prior candle high must retest the prior VWAP within configured tolerance.' },
      { direction: 'SELL' as const, label: 'Bearish confirmation', passed: sellConfirm, detail: 'Current close must break below the prior candle low.' },
      { direction: 'SELL' as const, label: 'VWAP not flat or repeatedly crossed', passed: cleanVwap, detail: `Cross count ${crossed}; require fewer than ${cfg.vwapRepeatedCrossCount} and sufficient slope.` },
    ];
    if (context.hasPosition) return withChecklist(noTrade(this.name, c, 'Position remains open; exit is managed by stop, target, or session close.'), checklist);
    if (crossed >= cfg.vwapRepeatedCrossCount || Math.abs(now - before) < last.close * cfg.vwapSlopeMinimumPct) return withChecklist(noTrade(this.name, c, 'VWAP is flat or price has crossed it repeatedly.', 'SIDEWAYS'), checklist);
    if (priceAbove && before > 0 && buyRetest && buyConfirm) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Price held rising session VWAP on pullback.', 'Bullish confirmation closed above prior high.'], 0.67, Math.min(prev.low, now * (1 - cfg.vwapRetestTolerancePct))), checklist);
    if (priceBelow && falling && sellRetest && sellConfirm) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Price rejected declining session VWAP on retrace.', 'Bearish confirmation closed below prior low.'], 0.67, Math.max(prev.high, now * (1 + cfg.vwapRetestTolerancePct))), checklist);
    if (sessionMinute(last.time) < cfg.openingHour * 60 + cfg.openingMinute + cfg.openingRangeMinutes) return withChecklist(noTrade(this.name, c, `Waiting for the first ${cfg.openingRangeMinutes} minutes of session VWAP data.`), checklist);
    const score = Math.max(
      ruleProgress(now > before, last.close > now, prev.low <= before * (1 + cfg.vwapRetestTolerancePct), last.close > prev.high, crossed < cfg.vwapRepeatedCrossCount),
      ruleProgress(now < before, last.close < now, prev.high >= before * (1 - cfg.vwapRetestTolerancePct), last.close < prev.low, crossed < cfg.vwapRepeatedCrossCount),
    );
    return withChecklist(noTrade(this.name, c, 'No directional VWAP retest and confirmation.', 'SIDEWAYS', score), checklist);
  },
};
