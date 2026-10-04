import type { Candle } from '../../types/market';

export type StrategyRegime = 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'UNKNOWN';
export type StrategySignalAction = 'LONG' | 'SHORT' | 'EXIT' | 'NO_TRADE';
export interface StrategyRuleCheck {
  direction: 'BUY' | 'SELL';
  label: string;
  passed: boolean;
  detail: string;
}
export type StrategyKey = 'ict_smc' | 'wyckoff' | 'trend_following' | 'breakout_retest' | 'mean_reversion' | 'vwap' | 'opening_range' | 'momentum' | 'order_flow' | 'statistical_pairs';
export interface StrategySignal {
  strategy: string;
  market_regime: StrategyRegime;
  signal: StrategySignalAction;
  confidence: number;
  entry_price: number | null;
  stop_loss: number | null;
  target: number | null;
  risk_reward: number | null;
  reason: string[];
  timestamp: string;
  checklist?: StrategyRuleCheck[];
}

/* ── Higher-Timeframe Bias ────────────────────────────────────────────── */

export type HtfTimeframeLabel = '15m' | '1h' | '1d';

export interface HtfTimeframeBias {
  timeframe: HtfTimeframeLabel;
  trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  emaFastAboveSlow: boolean;
  priceAboveEmaFast: boolean;
  keyResistance: number;
  keySupport: number;
  rsi: number;
}

export interface HtfBias {
  m15?: HtfTimeframeBias;
  h1?: HtfTimeframeBias;
  d1?: HtfTimeframeBias;
  /** Returns whether the majority of available higher timeframes agree with the proposed direction. */
  aligned: (direction: 'LONG' | 'SHORT') => { agreed: boolean; detail: string };
}

/* ── Strategy Context ─────────────────────────────────────────────────── */

export interface StrategyContext {
  candles: Candle[];
  /** True only when this strategy already owns an open position. */
  hasPosition?: boolean;
  positionSide?: 'LONG' | 'SHORT';
  /** Optional exchange supplied taker buy/sell volume; never inferred from candle volume alone. */
  orderFlow?: Array<{ time: number; buyerInitiatedVolume: number; sellerInitiatedVolume: number; delta: number; cvd: number }>;
  /** Synchronized close series keyed by instrument, with same-time observations. */
  relatedSeries?: Record<string, Array<{ time: number; close: number }>>;
  /** Set only by an executor capable of opening/closing both pair legs atomically. */
  supportsPairedExecution?: boolean;
  timeframeMinutes?: number;
  config?: Partial<StrategyConfig>;
  /** Multi-timeframe bias analysis (15m, 1h, 1d). When present, strategies use this to filter entries. */
  htfBias?: HtfBias;
}

export interface StrategyConfig {
  swingLookback: number;
  atrPeriod: number;
  atrStopMultiple: number;
  rewardRisk: number;
  emaFast: number;
  emaSlow: number;
  emaTrend: number;
  adxPeriod: number;
  adxMinimum: number;
  rsiPeriod: number;
  rsiOversold: number;
  rsiOverbought: number;
  rangeLookback: number;
  volumeLookback: number;
  volumeMultiplier: number;
  bollingerPeriod: number;
  bollingerDeviation: number;
  openingRangeMinutes: number;
  vwapCrossLimit: number;
  pairsLookback: number;
  pairsZEntry: number;
  pairsZExit: number;
  minCorrelation: number;
  timeframeMinutes: number;
  displacementBodyFraction: number;
  structureLookback: number;
  wyckoffTrendLookback: number;
  trendRsiLong: number;
  trendRsiShort: number;
  trendExitAdx: number;
  vwapSlopeMinimumPct: number;
  vwapRetestTolerancePct: number;
  vwapRepeatedCrossCount: number;
  openingHour: number;
  openingMinute: number;
  breakoutRetestTolerancePct: number;
  momentumRocBars: number;
  orderFlowDeltaMultiplier: number;
  minimumSetupCandles: number;
  breakoutRetestBars: number;
  momentumRsiLong: number;
  momentumRsiShort: number;
  wyckoffTargetExtensionPct: number;
  stopFloorPct: number;
  vwapMinimumSessionCandles: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  swingLookback: 10, atrPeriod: 14, atrStopMultiple: 1.5, rewardRisk: 2,
  emaFast: 20, emaSlow: 50, emaTrend: 200, adxPeriod: 14, adxMinimum: 25,
  rsiPeriod: 14, rsiOversold: 30, rsiOverbought: 70, rangeLookback: 20,
  volumeLookback: 20, volumeMultiplier: 1.2, bollingerPeriod: 20,
  bollingerDeviation: 2, openingRangeMinutes: 15, vwapCrossLimit: 4,
  pairsLookback: 60, pairsZEntry: 2, pairsZExit: 0.5, minCorrelation: 0.7,
  timeframeMinutes: 5,
  displacementBodyFraction: 0.65, structureLookback: 8, wyckoffTrendLookback: 20,
  trendRsiLong: 55, trendRsiShort: 45, trendExitAdx: 20,
  vwapSlopeMinimumPct: 0.00005, vwapRetestTolerancePct: 0.001, vwapRepeatedCrossCount: 4,
  openingHour: 9, openingMinute: 15, breakoutRetestTolerancePct: 0.001,
  momentumRocBars: 5, orderFlowDeltaMultiplier: 1,
  minimumSetupCandles: 3, breakoutRetestBars: 3, momentumRsiLong: 55,
  momentumRsiShort: 45, wyckoffTargetExtensionPct: 0.005,
  stopFloorPct: 0.0005, vwapMinimumSessionCandles: 3,
};

export type StrategyModule = {
  key: string;
  name: string;
  description: string;
  evaluate: (context: StrategyContext) => StrategySignal;
};
