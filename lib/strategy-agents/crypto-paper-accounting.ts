export interface PaperPositionAccountingInput {
  side: 'LONG' | 'SHORT';
  quantity: number;
  entryPrice: number;
  markPrice: number;
  entryFee: number;
  estimatedExitFee?: number;
}

/** Spot mode buys into a long holding and sells only to close that holding. */
export function cryptoSpotAction(signal: 'LONG' | 'SHORT' | 'EXIT' | 'NO_TRADE', hasLongPosition: boolean): 'BUY' | 'SELL' | 'HOLD' {
  if (!hasLongPosition && signal === 'LONG') return 'BUY';
  if (hasLongPosition && (signal === 'SHORT' || signal === 'EXIT')) return 'SELL';
  return 'HOLD';
}

export function calculatePaperUnrealizedPnl(input: PaperPositionAccountingInput): number {
  if (!Number.isFinite(input.quantity) || input.quantity <= 0) return 0;
  const direction = input.side === 'LONG' ? 1 : -1;
  return direction * (input.markPrice - input.entryPrice) * input.quantity - input.entryFee - (input.estimatedExitFee || 0);
}

/** Position value for equity when entry notional is reserved from cash for both sides. */
export function calculatePaperPositionValue(input: Pick<PaperPositionAccountingInput, 'side' | 'quantity' | 'entryPrice' | 'markPrice'> & { estimatedExitFee?: number }): number {
  const grossValue = input.side === 'LONG'
    ? input.markPrice * input.quantity
    : input.entryPrice * input.quantity + (input.entryPrice - input.markPrice) * input.quantity;
  return grossValue - (input.estimatedExitFee || 0);
}

export function calculatePaperRealizedPnl(input: Omit<PaperPositionAccountingInput, 'markPrice' | 'estimatedExitFee'> & { exitPrice: number; exitFee: number }): number {
  const direction = input.side === 'LONG' ? 1 : -1;
  return direction * (input.exitPrice - input.entryPrice) * input.quantity - input.entryFee - input.exitFee;
}

/** Entry notional is reserved from cash for shorts; release it with gross short P&L once. */
export function calculatePaperExitCashReturn(input: Omit<PaperPositionAccountingInput, 'markPrice' | 'entryFee' | 'estimatedExitFee'> & { exitPrice: number; exitFee: number }): number {
  if (input.side === 'LONG') return input.exitPrice * input.quantity - input.exitFee;
  return input.entryPrice * input.quantity + (input.entryPrice - input.exitPrice) * input.quantity - input.exitFee;
}

export function floorQuantityToStep(quantity: number, step: number): number {
  if (!Number.isFinite(quantity) || !Number.isFinite(step) || quantity <= 0 || step <= 0) return 0;
  const precision = Math.max(0, (String(step).split('.')[1] || '').length);
  return Number((Math.floor(quantity / step + 1e-10) * step).toFixed(precision));
}
