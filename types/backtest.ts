export type BacktestStrategyType =
  | 'REGIME_MOMENTUM'
  | 'LONG_CALL_BREAKOUT'
  | 'LONG_PUT_BREAKDOWN'
  | 'VOLATILITY_STRADDLE';

export interface BacktestConfig {
  symbol: string;
  startingCapital: number;
  lotSize: number;
  slippagePerUnit: number;
  costPerTrade: number;
  strategy: BacktestStrategyType;
  entryTime?: string;
  exitTime?: string;
  strikeCount?: number;
  initialPerSideInvestment?: number;
  tradingDays?: number[];
  backtestFrom?: string;
  backtestTo?: string;
}

export interface BacktestTrade {
  id: string;
  date: string;
  symbol: string;
  action: 'BUY' | 'SELL';
  strike: number;
  optionType: 'CE' | 'PE';
  entryPrice: number;
  exitPrice: number;
  allocatedBudget?: number;
  investedAmount?: number;
  grossPnl?: number;
  charges?: number;
  pnl: number;
  returnPct: number;
  regime: string;
  reason: string;
  lotSize?: number;
  lots?: number;
  quantity?: number;
}

export interface BacktestMetrics {
  totalTrades: number;
  winningTrades: number;
  losingTrades: number;
  winRate: number;
  totalPnl: number;
  profitFactor: number;
  maxDrawdown: number;
  maxDrawdownPct: number;
  finalCapital: number;
  returnOnCapital: number;
  averageTradePnl: number;
}

export interface RegimePerformance {
  regime: string;
  trades: number;
  winRate: number;
  pnl: number;
}

export interface BacktestResult {
  status: 'SUCCESS' | 'INSUFFICIENT_DATA' | 'ERROR';
  message?: string;
  config: BacktestConfig;
  metrics: BacktestMetrics;
  trades: BacktestTrade[];
  equityCurve: { date: string; equity: number }[];
  regimePerformance: RegimePerformance[];
  signalCounts: Record<string, number>;
  dailyResults?: BacktestDailyResult[];
  strikeResults?: BacktestStrikeResult[];
  reinvestment?: {
    reinvestmentRate: number;
    initialPerSideInvestment: number;
    finalPerSideInvestment: number;
    totalReinvested: number;
  };
  dataSource?: string;
  dataGranularity?: 'daily' | 'intraday';
  coverage?: {
    requestedFrom: string;
    requestedTo: string;
    observedSessions: number;
    failedDateCount: number;
    failedDates: string[];
  };
  dataQuality?: {
    rawCandidateRows: number;
    acceptedRows: number;
    rejectedRows: number;
    rejectionCounts: Record<string, number>;
  };
}

export interface BacktestDailyResult {
  date: string;
  note?: string;
  pnl: number;
  cePnl: number;
  pePnl: number;
  strikesEntered: number[];
  capital: number;
  reinvested: number;
  investmentPerSideNextDay: number;
}

export interface BacktestStrikeResult {
  strike: number;
  side: 'ABOVE' | 'BELOW' | 'BOTH';
  days: number;
  cePnl: number;
  pePnl: number;
  totalPnl: number;
  dailyPnl: { date: string; pnl: number }[];
}
