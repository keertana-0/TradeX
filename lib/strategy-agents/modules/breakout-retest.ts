import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, withTrade } from '../strategy-utils';
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
    if (context.hasPosition) return noTrade(this.name, c, 'Position remains open; manage exit using stop, target, or session risk controls.');
    if (breakUp && last.low <= resistance * (1 + cfg.breakoutRetestTolerancePct) && last.close > resistance && last.close > last.open) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', [`Prior resistance ${resistance.toFixed(2)} broke with volume.`, 'Retest held above the broken level and closed bullish.'], 0.7, Math.min(last.low, resistance * (1 - cfg.breakoutRetestTolerancePct)));
    if (breakDown && last.high >= support * (1 - cfg.breakoutRetestTolerancePct) && last.close < support && last.close < last.open) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', [`Prior support ${support.toFixed(2)} broke with volume.`, 'Retest rejected below the broken level and closed bearish.'], 0.7, Math.max(last.high, support * (1 + cfg.breakoutRetestTolerancePct)));
    return noTrade(this.name, c, 'No volume-confirmed breakout followed by a successful retest.', 'SIDEWAYS');
  },
};
