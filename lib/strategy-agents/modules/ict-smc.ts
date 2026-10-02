import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, signal, withTrade } from '../strategy-utils';
export const ictSmcStrategy: StrategyModule = {
  key: 'ict_smc', name: 'ICT / Smart Money Concepts',
  description: 'Requires a confirmed liquidity sweep, displacement structure break, and retrace into an imbalance zone.',
  evaluate(context: StrategyContext) {
    const c = closedCandles(context), cfg = configFor(context), n = c.length;
    if (n < Math.max(cfg.minimumSetupCandles, cfg.swingLookback * 2 + 5, cfg.structureLookback + cfg.swingLookback + 5)) return noTrade(this.name, c, 'Insufficient candles to confirm swings and displacement.');
    const last = c[n - 1], sweep = c[n - 4], displacement = c[n - 3];
    const swingWindow = c.slice(n - cfg.swingLookback - 4, n - 4);
    const swingLow = Math.min(...swingWindow.map(x => x.low)), swingHigh = Math.max(...swingWindow.map(x => x.high));
    const sweptLow = sweep.low < swingLow && sweep.close > swingLow;
    const sweptHigh = sweep.high > swingHigh && sweep.close < swingHigh;
    const strongDisplacement = Math.abs(displacement.close - displacement.open) >= (displacement.high - displacement.low) * cfg.displacementBodyFraction;
    const bullishBreak = displacement.close > Math.max(...c.slice(n - cfg.structureLookback - 4, n - 4).map(x => x.high));
    const bearishBreak = displacement.close < Math.min(...c.slice(n - cfg.structureLookback - 4, n - 4).map(x => x.low));
    const gapBottom = c[n - 5].high, gapTop = displacement.low;
    const gapUpRetest = gapBottom < gapTop && last.low <= gapTop && last.close >= gapBottom;
    const gapCeiling = c[n - 5].low, gapFloor = displacement.high;
    const gapDownRetest = gapFloor < gapCeiling && last.high >= gapFloor && last.close <= gapCeiling;
    if (context.hasPosition) {
      if (context.positionSide === 'LONG' && sweptHigh && bearishBreak) return signal(this.name, c, 'EXIT', 'BEARISH', ['Opposing buy-side sweep and bearish structure break confirmed.']);
      if (context.positionSide === 'SHORT' && sweptLow && bullishBreak) return signal(this.name, c, 'EXIT', 'BULLISH', ['Opposing sell-side sweep and bullish structure break confirmed.']);
      return noTrade(this.name, c, 'Position remains open; no opposing structure shift.');
    }
    if (sweptLow && bullishBreak && strongDisplacement && gapUpRetest) return withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Sell-side liquidity was swept.', 'Bullish displacement broke recent structure.', `Price retraced into bullish fair-value gap ${gapBottom.toFixed(2)}–${gapTop.toFixed(2)}.`], 0.72, Math.min(sweep.low, swingLow), swingHigh > last.close ? swingHigh : undefined);
    if (sweptHigh && bearishBreak && strongDisplacement && gapDownRetest) return withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Buy-side liquidity was swept.', 'Bearish displacement broke recent structure.', `Price retraced into bearish fair-value gap ${gapFloor.toFixed(2)}–${gapCeiling.toFixed(2)}.`], 0.72, Math.max(sweep.high, swingHigh), swingLow < last.close ? swingLow : undefined);
    return noTrade(this.name, c, 'No complete liquidity sweep, displacement break, and FVG retracement setup.', 'SIDEWAYS');
  },
};
