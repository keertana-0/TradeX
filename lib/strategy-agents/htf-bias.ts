/**
 * Higher-Timeframe (HTF) Bias Calculator
 *
 * Computes trend direction, key levels, and regime for 15m, 1h, and 1d
 * candles so that 5-minute strategy modules can filter entries against
 * the bigger picture.
 */
import type { Candle } from '@/types/market';
import type { HtfBias, HtfTimeframeBias, HtfTimeframeLabel } from './strategy-types';
import { ema, rsi } from './strategy-utils';

const EMA_FAST = 20;
const EMA_SLOW = 50;
const RSI_PERIOD = 14;
const SWING_LOOKBACK = 10;

/**
 * Compute bias for a single higher timeframe.
 * Requires at least EMA_SLOW + 1 completed candles to produce a valid result.
 */
export function computeTimeframeBias(candles: Candle[], label: HtfTimeframeLabel): HtfTimeframeBias | null {
  if (!candles || candles.length < EMA_SLOW + 1) return null;

  const closes = candles.map((c) => c.close);
  const fast = ema(closes, EMA_FAST);
  const slow = ema(closes, EMA_SLOW);
  const rs = rsi(closes, RSI_PERIOD);

  const n = candles.length;
  const lastClose = closes[n - 1];
  const lastFast = fast[n - 1];
  const lastSlow = slow[n - 1];
  const lastRsi = rs[n - 1];

  if (!Number.isFinite(lastFast) || !Number.isFinite(lastSlow)) return null;

  const emaFastAboveSlow = lastFast > lastSlow;
  const priceAboveEmaFast = lastClose > lastFast;

  // Determine trend
  let trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  if (priceAboveEmaFast && emaFastAboveSlow) {
    trend = 'BULLISH';
  } else if (!priceAboveEmaFast && !emaFastAboveSlow) {
    trend = 'BEARISH';
  } else {
    trend = 'NEUTRAL';
  }

  // Key swing levels from the most recent bars
  const lookbackSlice = candles.slice(-SWING_LOOKBACK);
  const keyResistance = Math.max(...lookbackSlice.map((c) => c.high));
  const keySupport = Math.min(...lookbackSlice.map((c) => c.low));

  return {
    timeframe: label,
    trend,
    emaFastAboveSlow,
    priceAboveEmaFast,
    keyResistance,
    keySupport,
    rsi: Number.isFinite(lastRsi) ? lastRsi : 50,
  };
}

/**
 * Build a complete HtfBias object from multi-timeframe candle data.
 * Any timeframe can be omitted (null/undefined/empty array) if data is unavailable.
 */
export function buildHtfBias(
  candles15m?: Candle[] | null,
  candles1h?: Candle[] | null,
  candles1d?: Candle[] | null,
): HtfBias {
  const m15 = candles15m ? computeTimeframeBias(candles15m, '15m') : null;
  const h1 = candles1h ? computeTimeframeBias(candles1h, '1h') : null;
  const d1 = candles1d ? computeTimeframeBias(candles1d, '1d') : null;

  return {
    m15: m15 ?? undefined,
    h1: h1 ?? undefined,
    d1: d1 ?? undefined,
    aligned(direction: 'LONG' | 'SHORT') {
      const biases = [m15, h1, d1].filter(Boolean) as HtfTimeframeBias[];
      if (biases.length === 0) return { agreed: true, detail: 'No higher-timeframe data available; HTF filter is bypassed.' };

      const opposing = direction === 'LONG' ? 'BEARISH' : 'BULLISH';
      const agreeing = direction === 'LONG' ? 'BULLISH' : 'BEARISH';

      const opposed = biases.filter((b) => b.trend === opposing);
      const agreed = biases.filter((b) => b.trend === agreeing);
      const neutral = biases.filter((b) => b.trend === 'NEUTRAL');

      // Majority rule: entry is blocked only if a majority of available HTFs actively oppose the direction
      const majorityOpposed = opposed.length > biases.length / 2;

      if (majorityOpposed) {
        const labels = opposed.map((b) => b.timeframe).join(', ');
        return {
          agreed: false,
          detail: `${direction} blocked: ${opposed.length}/${biases.length} higher timeframes (${labels}) show ${opposing} trend.`,
        };
      }

      const parts: string[] = [];
      if (agreed.length > 0) parts.push(`${agreed.length} TF(s) ${agreeing}`);
      if (neutral.length > 0) parts.push(`${neutral.length} TF(s) NEUTRAL`);
      if (opposed.length > 0) parts.push(`${opposed.length} TF(s) ${opposing}`);

      return {
        agreed: true,
        detail: `${direction} aligned: ${parts.join(', ')} — majority does not oppose.`,
      };
    },
  };
}
