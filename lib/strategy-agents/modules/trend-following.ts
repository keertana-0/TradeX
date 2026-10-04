import type { StrategyContext, StrategyModule } from '../strategy-types';
import { adx, closedCandles, configFor, ema, noTrade, ruleProgress, rsi, signal, withChecklist, withTrade } from '../strategy-utils';
export const trendFollowingStrategy: StrategyModule = {
  key: 'trend_following', name: 'Trend Following',
  description: 'Requires EMA alignment, ADX direction, RSI confirmation, and a pullback/rejection.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length;
    if (n < cfg.emaTrend + 3) return noTrade(this.name, c, `Warm-up requires ${cfg.emaTrend + 3} candles for the configured trend filter.`);
    const closes = c.map(x => x.close), e20 = ema(closes, cfg.emaFast), e50 = ema(closes, cfg.emaSlow), e200 = ema(closes, cfg.emaTrend), strength = adx(c, cfg.adxPeriod), rs = rsi(closes, cfg.rsiPeriod);
    if (!strength || !Number.isFinite(rs[n - 1])) return noTrade(this.name, c, 'ADX/RSI history is incomplete.');
    const last = c[n - 1], prev = c[n - 2];
    const bullAlignment = last.close > e20[n - 1] && e20[n - 1] > e50[n - 1] && e50[n - 1] > e200[n - 1];
    const bearAlignment = last.close < e20[n - 1] && e20[n - 1] < e50[n - 1] && e50[n - 1] < e200[n - 1];
    const strongTrend = strength.adx >= cfg.adxMinimum;
    const bullDirection = strength.plus > strength.minus, bearDirection = strength.minus > strength.plus;
    const bullMomentum = rs[n - 1] > cfg.trendRsiLong, bearMomentum = rs[n - 1] < cfg.trendRsiShort;
    const bullPullback = prev.low <= e20[n - 2], bearPullback = prev.high >= e20[n - 2];
    const bullReclaim = last.close > prev.close, bearReject = last.close < prev.close;
    const checklist = [
      { direction: 'BUY' as const, label: 'Bullish EMA alignment', passed: bullAlignment, detail: `Close > EMA${cfg.emaFast} > EMA${cfg.emaSlow} > EMA${cfg.emaTrend}.` },
      { direction: 'BUY' as const, label: 'Minimum trend strength', passed: strongTrend, detail: `ADX ${strength.adx.toFixed(1)} must be at least ${cfg.adxMinimum}.` },
      { direction: 'BUY' as const, label: 'Bullish directional strength', passed: bullDirection, detail: 'Positive directional index must exceed negative directional index.' },
      { direction: 'BUY' as const, label: 'Bullish RSI momentum', passed: bullMomentum, detail: `RSI ${rs[n - 1].toFixed(1)} must exceed ${cfg.trendRsiLong}.` },
      { direction: 'BUY' as const, label: 'EMA pullback', passed: bullPullback, detail: `Previous low must touch or cross EMA${cfg.emaFast}.` },
      { direction: 'BUY' as const, label: 'Bullish reclaim', passed: bullReclaim, detail: 'Latest close must exceed the prior close.' },
      { direction: 'SELL' as const, label: 'Bearish EMA alignment', passed: bearAlignment, detail: `Close < EMA${cfg.emaFast} < EMA${cfg.emaSlow} < EMA${cfg.emaTrend}.` },
      { direction: 'SELL' as const, label: 'Minimum trend strength', passed: strongTrend, detail: `ADX ${strength.adx.toFixed(1)} must be at least ${cfg.adxMinimum}.` },
      { direction: 'SELL' as const, label: 'Bearish directional strength', passed: bearDirection, detail: 'Negative directional index must exceed positive directional index.' },
      { direction: 'SELL' as const, label: 'Bearish RSI momentum', passed: bearMomentum, detail: `RSI ${rs[n - 1].toFixed(1)} must be below ${cfg.trendRsiShort}.` },
      { direction: 'SELL' as const, label: 'EMA pullback', passed: bearPullback, detail: `Previous high must touch or cross EMA${cfg.emaFast}.` },
      { direction: 'SELL' as const, label: 'Bearish rejection', passed: bearReject, detail: 'Latest close must be below the prior close.' },
    ];
    const bullish = bullAlignment && strongTrend && bullDirection && bullMomentum;
    const bearish = bearAlignment && strongTrend && bearDirection && bearMomentum;
    if (context.hasPosition) {
      if (context.positionSide === 'LONG' && (last.close < e50[n - 1] || strength.adx < cfg.trendExitAdx || strength.minus > strength.plus)) return withChecklist(signal(this.name, c, 'EXIT', 'BEARISH', ['Trend filter no longer supports a long position.']), checklist);
      if (context.positionSide === 'SHORT' && (last.close > e50[n - 1] || strength.adx < cfg.trendExitAdx || strength.plus > strength.minus)) return signal(this.name, c, 'EXIT', 'BULLISH', ['Trend filter no longer supports a short position.']);
      return withChecklist(noTrade(this.name, c, 'Position remains open; trend exit filter has not fired.'), checklist);
    }
    if (bullish && bullPullback && bullReclaim) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`EMA${cfg.emaFast}>EMA${cfg.emaSlow}>EMA${cfg.emaTrend}.`, `ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}; pullback reclaimed EMA${cfg.emaFast}.`], 0.74), checklist);
    if (bearish && bearPullback && bearReject) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`EMA${cfg.emaFast}<EMA${cfg.emaSlow}<EMA${cfg.emaTrend}.`, `ADX ${strength.adx.toFixed(1)}, RSI ${rs[n - 1].toFixed(1)}; pullback rejected EMA${cfg.emaFast}.`], 0.74), checklist);
    const setupScore = Math.max(
      ruleProgress(bullAlignment, strongTrend, bullDirection, bullMomentum, bullPullback, bullReclaim),
      ruleProgress(bearAlignment, strongTrend, bearDirection, bearMomentum, bearPullback, bearReject),
    );
    return withChecklist(noTrade(this.name, c, `Trend/pullback conditions incomplete (ADX ${strength.adx.toFixed(1)}).`, 'SIDEWAYS', setupScore), checklist);
  },
};
