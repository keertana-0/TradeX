import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, ruleProgress, withChecklist, withTrade } from '../strategy-utils';
export const breakoutRetestStrategy: StrategyModule = {
  key: 'breakout_retest', name: 'Breakout and Retest',
  description: 'Requires a prior close beyond a multi-bar level, volume confirmation, and a retest holding the level.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length, lb = cfg.rangeLookback;
    if (n < lb + cfg.breakoutRetestBars + 1) return noTrade(this.name, c, 'Insufficient consolidation history.');
    const prior = c.slice(n - lb - 3, n - 3), resistance = Math.max(...prior.map(x => x.high)), support = Math.min(...prior.map(x => x.low));
    const baseVolume = prior.slice(-cfg.volumeLookback).reduce((s, x) => s + x.volume, 0) / Math.min(prior.length, cfg.volumeLookback);
    const recent = c.slice(-cfg.breakoutRetestBars - 1, -1), breakUp = recent.some((x) => x.close > resistance && x.volume >= baseVolume * cfg.volumeMultiplier);
    const breakDown = recent.some(x => x.close < support && x.volume >= baseVolume * cfg.volumeMultiplier), last = c[n - 1];
    const buyRetest = last.low <= resistance * (1 + cfg.breakoutRetestTolerancePct), buyHold = last.close > resistance, buyCandle = last.close > last.open;
    const sellRetest = last.high >= support * (1 - cfg.breakoutRetestTolerancePct), sellHold = last.close < support, sellCandle = last.close < last.open;
    const checklist = [
      { direction: 'BUY' as const, label: 'Volume-confirmed resistance break', passed: breakUp, detail: `A recent close above ${resistance.toFixed(2)} with volume at least ${cfg.volumeMultiplier}× baseline.` },
      { direction: 'BUY' as const, label: 'Retest of broken resistance', passed: buyRetest, detail: `The current low must revisit the breakout level (tolerance ${(cfg.breakoutRetestTolerancePct * 100).toFixed(2)}%).` },
      { direction: 'BUY' as const, label: 'Close holds above resistance', passed: buyHold, detail: `Current close must be above ${resistance.toFixed(2)}.` },
      { direction: 'BUY' as const, label: 'Bullish confirmation candle', passed: buyCandle, detail: 'Current candle must close above its open.' },
      { direction: 'SELL' as const, label: 'Volume-confirmed support break', passed: breakDown, detail: `A recent close below ${support.toFixed(2)} with volume at least ${cfg.volumeMultiplier}× baseline.` },
      { direction: 'SELL' as const, label: 'Retest of broken support', passed: sellRetest, detail: `The current high must revisit the breakdown level (tolerance ${(cfg.breakoutRetestTolerancePct * 100).toFixed(2)}%).` },
      { direction: 'SELL' as const, label: 'Close holds below support', passed: sellHold, detail: `Current close must be below ${support.toFixed(2)}.` },
      { direction: 'SELL' as const, label: 'Bearish confirmation candle', passed: sellCandle, detail: 'Current candle must close below its open.' },
    ];
    if (context.hasPosition) return withChecklist(noTrade(this.name, c, 'Position remains open; manage exit using stop, target, or session risk controls.'), checklist);
    if (breakUp && buyRetest && buyHold && buyCandle) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`Prior resistance ${resistance.toFixed(2)} broke with volume.`, 'Retest held above the broken level and closed bullish.'], 0.7, Math.min(last.low, resistance * (1 - cfg.breakoutRetestTolerancePct))), checklist);
    if (breakDown && sellRetest && sellHold && sellCandle) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`Prior support ${support.toFixed(2)} broke with volume.`, 'Retest rejected below the broken level and closed bearish.'], 0.7, Math.max(last.high, support * (1 + cfg.breakoutRetestTolerancePct))), checklist);
    const setupScore = Math.max(
      ruleProgress(breakUp, last.low <= resistance * (1 + cfg.breakoutRetestTolerancePct), last.close > resistance, last.close > last.open),
      ruleProgress(breakDown, last.high >= support * (1 - cfg.breakoutRetestTolerancePct), last.close < support, last.close < last.open),
    );
    return withChecklist(noTrade(this.name, c, 'No volume-confirmed breakout followed by a successful retest.', 'SIDEWAYS', setupScore), checklist);
  },
};
