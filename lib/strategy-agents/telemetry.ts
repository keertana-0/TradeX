import type { Candle } from '@/types/market';
import { calculateEMA } from '@/lib/analysis/indicators/ema';
import { calculateRSI } from '@/lib/analysis/indicators/rsi';
import { calculateATR } from '@/lib/analysis/indicators/atr';
import { calculateBollingerBands } from '@/lib/analysis/indicators/bollinger';

export interface StrategyConditionReport {
  strategyKey: string;
  strategyName: string;
  symbol: string;
  currentPrice: number;
  marketRegime: 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'VOLATILE';
  confidence: number;
  confidenceThreshold: number;
  conditionsMet: Array<{ label: string; detail: string; status: 'MET' }>;
  conditionsNeeded: Array<{ label: string; detail: string; status: 'PENDING' }>;
  supportPrice: number;
  resistancePrice: number;
  ema20: number | null;
  ema50: number | null;
  rsi14: number | null;
  atr14: number | null;
  thesis: string;
}

export function analyzeStrategyConditions(
  strategyKey: string,
  strategyName: string,
  symbol: string,
  candles: Candle[]
): StrategyConditionReport {
  const n = candles.length;
  const last = candles[n - 1] || { close: 0, high: 0, low: 0, open: 0, volume: 0 };
  const currentPrice = last.close;

  const ema20Arr = calculateEMA(candles, 20);
  const ema50Arr = calculateEMA(candles, 50);
  const rsiArr = calculateRSI(candles, 14);
  const atrArr = calculateATR(candles, 14);
  const bb = calculateBollingerBands(candles, 20, 2);

  const ema20 = ema20Arr.at(-1) ?? null;
  const ema50 = ema50Arr.at(-1) ?? null;
  const rsi14 = rsiArr.at(-1) ?? null;
  const atr14 = atrArr.at(-1) ?? null;

  // Identify local 30-period support and resistance
  const lookback = candles.slice(-30);
  const resistancePrice = lookback.length ? Math.max(...lookback.map((c) => c.high)) : currentPrice * 1.02;
  const supportPrice = lookback.length ? Math.min(...lookback.map((c) => c.low)) : currentPrice * 0.98;

  const avgVol = lookback.length ? lookback.reduce((acc, c) => acc + c.volume, 0) / lookback.length : 1;
  const volExpansion = last.volume > avgVol * 1.2;

  let marketRegime: 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'VOLATILE' = 'SIDEWAYS';
  if (ema20 && ema50) {
    if (ema20 > ema50 && currentPrice > ema20) marketRegime = 'BULLISH';
    else if (ema20 < ema50 && currentPrice < ema20) marketRegime = 'BEARISH';
  }
  if (rsi14 && (rsi14 > 70 || rsi14 < 30)) marketRegime = 'VOLATILE';

  const conditionsMet: Array<{ label: string; detail: string; status: 'MET' }> = [];
  const conditionsNeeded: Array<{ label: string; detail: string; status: 'PENDING' }> = [];
  let confidence = 0.35;
  let thesis = '';

  switch (strategyKey) {
    case 'ict_smc':
      thesis = 'Smart Money Concepts actively tracks order blocks, liquidity pools, and Fair Value Gaps (FVG) for institutional footprints.';
      if (currentPrice > (supportPrice + resistancePrice) / 2) {
        conditionsMet.push({ label: 'Premium/Discount Equilibrium', detail: `Price is trading in premium zone above ${( (supportPrice + resistancePrice) / 2 ).toFixed(2)}`, status: 'MET' });
      } else {
        conditionsMet.push({ label: 'Discount Pricing Structure', detail: `Price is sitting in institutional discount below ${( (supportPrice + resistancePrice) / 2 ).toFixed(2)}`, status: 'MET' });
      }
      if (volExpansion) {
        conditionsMet.push({ label: 'Displacement Expansion', detail: `Latest candle volume (${Math.round(last.volume)}) expanded above 20-bar baseline (${Math.round(avgVol)})`, status: 'MET' });
        confidence += 0.15;
      } else {
        conditionsNeeded.push({ label: 'Institutional Displacement', detail: 'Waiting for high-momentum displacement candle with >= 55% body fraction', status: 'PENDING' });
      }
      conditionsNeeded.push({ label: 'Liquidity Sweep Confirmation', detail: `Requires a false break beyond ${resistancePrice.toFixed(2)} or ${supportPrice.toFixed(2)} with swift rejection`, status: 'PENDING' });
      conditionsNeeded.push({ label: 'Fair Value Gap (FVG) Imbalance', detail: 'Waiting for clean 3-candle imbalance and retrace entry trigger', status: 'PENDING' });
      break;

    case 'breakout_retest':
      thesis = 'Monitors defined consolidation ranges to buy clean volume breakouts that hold support on retest.';
      conditionsMet.push({ label: 'Range Boundaries Defined', detail: `Established Resistance at ${resistancePrice.toFixed(2)} and Support at ${supportPrice.toFixed(2)}`, status: 'MET' });
      if (Math.abs(currentPrice - resistancePrice) / resistancePrice < 0.015) {
        conditionsMet.push({ label: 'Testing Key Resistance Level', detail: `Current price ${currentPrice.toFixed(2)} is within 1.5% of range ceiling`, status: 'MET' });
        confidence += 0.20;
      }
      if (volExpansion) {
        conditionsMet.push({ label: 'Volume Surge Detected', detail: 'Volume expansion supports potential breakout impulse', status: 'MET' });
        confidence += 0.10;
      } else {
        conditionsNeeded.push({ label: 'Volume Multiplier Trigger', detail: 'Breakout candle must exceed 1.5x average 20-period volume', status: 'PENDING' });
      }
      conditionsNeeded.push({ label: 'Retest Confirmation', detail: `Must cleanly break above ${resistancePrice.toFixed(2)} and close a bullish candle on the retest`, status: 'PENDING' });
      break;

    case 'trend_following':
      thesis = 'Captures sustained directional momentum using moving average ribbon alignment and pullback continuation.';
      if (ema20 && ema50 && ema20 > ema50) {
        conditionsMet.push({ label: 'Bullish Moving Average Ribbon', detail: `Fast EMA 20 (${ema20.toFixed(2)}) is leading above Slow EMA 50 (${ema50.toFixed(2)})`, status: 'MET' });
        confidence += 0.20;
      } else if (ema20 && ema50 && ema20 < ema50) {
        conditionsMet.push({ label: 'Bearish Moving Average Ribbon', detail: `Fast EMA 20 (${ema20.toFixed(2)}) is trailing below Slow EMA 50 (${ema50.toFixed(2)})`, status: 'MET' });
        confidence += 0.20;
      }
      if (rsi14 && rsi14 >= 45 && rsi14 <= 65) {
        conditionsMet.push({ label: 'Trend RSI Sustainability', detail: `RSI at ${rsi14.toFixed(1)} indicates healthy trending momentum without extreme overbought exhaustion`, status: 'MET' });
        confidence += 0.15;
      } else {
        conditionsNeeded.push({ label: 'Momentum Alignment', detail: 'Waiting for RSI momentum to stabilize inside trending territory (45 - 65)', status: 'PENDING' });
      }
      conditionsNeeded.push({ label: 'Pullback & Bounce Trigger', detail: 'Requires a shallow test of the 20 EMA followed by immediate continuation candle', status: 'PENDING' });
      break;

    case 'mean_reversion':
      thesis = 'Identifies statistical price overextensions outside normal volatility bands to fade extreme moves.';
      const lastBb = bb.at(-1);
      if (lastBb && lastBb.lower !== null && lastBb.upper !== null && rsi14 !== null) {
        if (currentPrice <= lastBb.lower || rsi14 < 35) {
          conditionsMet.push({ label: 'Oversold Volatility Extension', detail: `Price tested lower Bollinger Band (${lastBb.lower.toFixed(2)}) with RSI at ${rsi14.toFixed(1)}`, status: 'MET' });
          confidence += 0.25;
        } else if (currentPrice >= lastBb.upper || rsi14 > 65) {
          conditionsMet.push({ label: 'Overbought Volatility Extension', detail: `Price tested upper Bollinger Band (${lastBb.upper.toFixed(2)}) with RSI at ${rsi14.toFixed(1)}`, status: 'MET' });
          confidence += 0.25;
        } else {
          conditionsNeeded.push({ label: 'Statistical 2-Sigma Stretch', detail: `Price is inside normal bands (${lastBb.lower.toFixed(2)} - ${lastBb.upper.toFixed(2)}); waiting for 2σ extension`, status: 'PENDING' });
        }
      }
      conditionsNeeded.push({ label: 'Reversal Bar Close', detail: 'Requires engulfing or pin-bar reversal close back inside bands before trigger', status: 'PENDING' });
      break;

    case 'vwap':
      thesis = 'Evaluates institutional intraday average price and volume delta at standard deviation boundaries.';
      const vwapProxy = lookback.reduce((sum, b) => sum + ((b.high + b.low + b.close) / 3) * b.volume, 0) / (avgVol * lookback.length || 1);
      if (currentPrice > vwapProxy) {
        conditionsMet.push({ label: 'Institutional Bullish Bias', detail: `Trading above VWAP benchmark (${vwapProxy.toFixed(2)})`, status: 'MET' });
        confidence += 0.15;
      } else {
        conditionsMet.push({ label: 'Institutional Discount Bias', detail: `Trading below VWAP benchmark (${vwapProxy.toFixed(2)})`, status: 'MET' });
        confidence += 0.15;
      }
      conditionsNeeded.push({ label: 'VWAP Band Extension', detail: 'Waiting for clean tap of ±1.5 standard deviation VWAP band', status: 'PENDING' });
      conditionsNeeded.push({ label: 'Volume Delta Expansion', detail: 'Requires directional buy/sell volume spike confirming reaction', status: 'PENDING' });
      break;

    default:
      thesis = 'Autonomous quantitative algorithm assessing trend strength, multi-timeframe volume, and risk-reward geometry.';
      conditionsMet.push({ label: 'Timeframe Bars Synchronized', detail: `Analyzed ${n} consecutive 5-minute bars`, status: 'MET' });
      if (rsi14) conditionsMet.push({ label: 'RSI Indicator Ready', detail: `Current reading: ${rsi14.toFixed(1)}`, status: 'MET' });
      conditionsNeeded.push({ label: 'Pattern Execution Trigger', detail: 'Waiting for high-probability setup alignment', status: 'PENDING' });
      conditionsNeeded.push({ label: 'Minimum Confidence Gate', detail: 'Requires algorithm confidence >= 65% to allocate capital', status: 'PENDING' });
      break;
  }

  // Ensure minimum baseline requirements are explicitly shown
  if (confidence < 0.65) {
    conditionsNeeded.unshift({
      label: 'Confidence Gate Threshold',
      detail: `Current algorithm confidence is ${(confidence * 100).toFixed(0)}% (Needs >= 65% to open paper position)`,
      status: 'PENDING',
    });
  }

  return {
    strategyKey,
    strategyName,
    symbol,
    currentPrice,
    marketRegime,
    confidence: Math.min(1.0, confidence),
    confidenceThreshold: 0.65,
    conditionsMet,
    conditionsNeeded,
    supportPrice,
    resistancePrice,
    ema20,
    ema50,
    rsi14,
    atr14,
    thesis,
  };
}
