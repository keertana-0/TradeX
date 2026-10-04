import type { StrategyContext, StrategyModule } from '../strategy-types';
import { closedCandles, configFor, noTrade, ruleProgress, signal, withChecklist, withTrade } from '../strategy-utils';
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
    const checklist = [
      { direction: 'BUY' as const, label: 'Sell-side liquidity sweep', passed: sweptLow, detail: `A candle must sweep below swing low ${swingLow.toFixed(2)} and close back above it.` },
      { direction: 'BUY' as const, label: 'Bullish structure break', passed: bullishBreak, detail: `Displacement candle must close above recent structure (${Math.max(...c.slice(n - cfg.structureLookback - 4, n - 4).map(x => x.high)).toFixed(2)}).` },
      { direction: 'BUY' as const, label: 'Displacement candle', passed: strongDisplacement, detail: `Body must be at least ${(cfg.displacementBodyFraction * 100).toFixed(0)}% of its range.` },
      { direction: 'BUY' as const, label: 'Bullish imbalance retest', passed: gapUpRetest, detail: 'Price must retrace into the bullish fair-value gap and close inside it.' },
      { direction: 'SELL' as const, label: 'Buy-side liquidity sweep', passed: sweptHigh, detail: `A candle must sweep above swing high ${swingHigh.toFixed(2)} and close back below it.` },
      { direction: 'SELL' as const, label: 'Bearish structure break', passed: bearishBreak, detail: `Displacement candle must close below recent structure (${Math.min(...c.slice(n - cfg.structureLookback - 4, n - 4).map(x => x.low)).toFixed(2)}).` },
      { direction: 'SELL' as const, label: 'Displacement candle', passed: strongDisplacement, detail: `Body must be at least ${(cfg.displacementBodyFraction * 100).toFixed(0)}% of its range.` },
      { direction: 'SELL' as const, label: 'Bearish imbalance retest', passed: gapDownRetest, detail: 'Price must retrace into the bearish fair-value gap and close inside it.' },
    ];
    if (context.hasPosition) {
      if (context.positionSide === 'LONG' && sweptHigh && bearishBreak) return withChecklist(signal(this.name, c, 'EXIT', 'BEARISH', ['Opposing buy-side sweep and bearish structure break confirmed.']), checklist);
      if (context.positionSide === 'SHORT' && sweptLow && bullishBreak) return withChecklist(signal(this.name, c, 'EXIT', 'BULLISH', ['Opposing sell-side sweep and bullish structure break confirmed.']), checklist);
      return withChecklist(noTrade(this.name, c, 'Position remains open; no opposing structure shift.'), checklist);
    }
    if (sweptLow && bullishBreak && strongDisplacement && gapUpRetest) return withChecklist(withTrade(this.name, c, 'LONG', cfg, 'BULLISH', ['Sell-side liquidity was swept.', 'Bullish displacement broke recent structure.', `Price retraced into bullish fair-value gap ${gapBottom.toFixed(2)}-${gapTop.toFixed(2)}.`], 0.72, Math.min(sweep.low, swingLow), swingHigh > last.close ? swingHigh : undefined), checklist);
    if (sweptHigh && bearishBreak && strongDisplacement && gapDownRetest) return withChecklist(withTrade(this.name, c, 'SHORT', cfg, 'BEARISH', ['Buy-side liquidity was swept.', 'Bearish displacement broke recent structure.', `Price retraced into bearish fair-value gap ${gapFloor.toFixed(2)}-${gapCeiling.toFixed(2)}.`], 0.72, Math.max(sweep.high, swingHigh), swingLow < last.close ? swingLow : undefined), checklist);
    const setupScore = Math.max(
      ruleProgress(sweptLow, bullishBreak, strongDisplacement, gapUpRetest),
      ruleProgress(sweptHigh, bearishBreak, strongDisplacement, gapDownRetest),
    );
    return withChecklist(noTrade(this.name, c, 'No complete liquidity sweep, displacement break, and FVG retracement setup.', 'SIDEWAYS', setupScore), checklist);
  },
};
