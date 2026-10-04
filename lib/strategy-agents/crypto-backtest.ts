import type { Candle } from '@/types/market';
import { CRYPTO_MARKETS, type CryptoSymbol } from '@/lib/market-data/crypto-provider';
import { DEFAULT_STRATEGY_CONFIG } from './strategy-types';
import type { StrategyKey } from './strategy-types';
import type { StrategyContext } from './strategy-types';
import { STRATEGY_MODULES } from './strategies';
import { calculatePaperExitCashReturn, calculatePaperPositionValue, calculatePaperRealizedPnl, floorQuantityToStep } from './crypto-paper-accounting';
import { STRATEGY_MIN_CONFIDENCE } from './entry-policy';

const FEE_RATE = 0.0005;
const SLIPPAGE_RATE = 0.0005;
const RISK_FRACTION = 0.005;
const MAX_EXPOSURE = 0.2;

export interface CryptoBacktestTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  pnl: number;
  exitReason: string;
}

export interface CryptoAgentBacktestResult {
  key: StrategyKey;
  strategy: string;
  initialBudget: number;
  finalBalance: number;
  netPnl: number;
  returnPct: number;
  maxDrawdownPct: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  profitFactor: number | null;
  fees: number;
  bySymbol: Record<CryptoSymbol, number>;
  recentTrades: CryptoBacktestTrade[];
}

type OpenPosition = {
  symbol: CryptoSymbol;
  quantity: number;
  entryPrice: number;
  stop: number;
  target: number;
  side: 'LONG' | 'SHORT';
  entryFee: number;
  entryTime: number;
};

export async function runCryptoSpotBacktest(
  candlesBySymbol: Record<CryptoSymbol, Candle[]>,
  budgets: Record<StrategyKey, number>,
  onProgress?: (strategyIndex: number, fraction: number, strategyName: string) => void,
  orderFlowBySymbol: Record< CryptoSymbol, NonNullable<StrategyContext['orderFlow']> > = { BTC: [], ETH: [], SOL: [] },
) {
  const timestamps = CRYPTO_MARKETS.map((market) => candlesBySymbol[market.symbol].map((candle) => candle.time));
  const timestampSets = timestamps.slice(1).map((list) => new Set(list));
  const commonTimes = timestamps.length ? timestamps[0].filter((time) => timestampSets.every((set) => set.has(time))) : [];
  const candles = Object.fromEntries(CRYPTO_MARKETS.map((market) => {
    const byTime = new Map(candlesBySymbol[market.symbol].map((candle) => [candle.time, candle]));
    return [market.symbol, commonTimes.map((time) => byTime.get(time)!).filter(Boolean)];
  })) as Record<CryptoSymbol, Candle[]>;

  // Live crypto agents make decisions on completed 5-minute candles. Keep the
  // downloaded 1-minute bars for fills and protective exits, and aggregate them
  // into completed 5-minute bars for strategy evaluation.
  const completedFiveMinuteAt = new Map<number, Record<CryptoSymbol, Candle>>();
  const completedFiveMinuteFlowAt = new Map<number, Record<CryptoSymbol, NonNullable<StrategyContext['orderFlow']>[number]>>();
  const alignedFlow = Object.fromEntries(CRYPTO_MARKETS.map((market) => {
    const byTime = new Map(orderFlowBySymbol[market.symbol].map((point) => [point.time, point]));
    return [market.symbol, commonTimes.map((time) => byTime.get(time) || null)];
  })) as Record<CryptoSymbol, Array<NonNullable<StrategyContext['orderFlow']>[number] | null>>;
  const cumulativeDelta = { BTC: 0, ETH: 0, SOL: 0 } satisfies Record<CryptoSymbol, number>;
  for (let index = 4; index < commonTimes.length; index++) {
    const closeMinute = commonTimes[index];
    const bucketStart = Math.floor(closeMinute / 300) * 300;
    if (closeMinute !== bucketStart + 240) continue;
    const times = commonTimes.slice(index - 4, index + 1);
    if (times.length !== 5 || times.some((time, offset) => time !== bucketStart + offset * 60)) continue;
    const bars = Object.fromEntries(CRYPTO_MARKETS.map((market) => {
      const group = candles[market.symbol].slice(index - 4, index + 1);
      return [market.symbol, {
        time: bucketStart,
        open: group[0].open,
        high: Math.max(...group.map((bar) => bar.high)),
        low: Math.min(...group.map((bar) => bar.low)),
        close: group[4].close,
        volume: group.reduce((sum, bar) => sum + bar.volume, 0),
      }];
    })) as Record<CryptoSymbol, Candle>;
    completedFiveMinuteAt.set(index, bars);
    const flowBars = Object.fromEntries(CRYPTO_MARKETS.map((market) => {
      const group = alignedFlow[market.symbol].slice(index - 4, index + 1);
      if (group.some((point) => !point)) return [market.symbol, null];
      const buyerInitiatedVolume = group.reduce((sum, point) => sum + point!.buyerInitiatedVolume, 0);
      const sellerInitiatedVolume = group.reduce((sum, point) => sum + point!.sellerInitiatedVolume, 0);
      const delta = buyerInitiatedVolume - sellerInitiatedVolume;
      cumulativeDelta[market.symbol] += delta;
      return [market.symbol, { time: bucketStart, buyerInitiatedVolume, sellerInitiatedVolume, delta, cvd: cumulativeDelta[market.symbol] }];
    })) as Record<CryptoSymbol, NonNullable<StrategyContext['orderFlow']>[number] | null>;
    if (CRYPTO_MARKETS.every((market) => flowBars[market.symbol])) {
      completedFiveMinuteFlowAt.set(index, Object.fromEntries(CRYPTO_MARKETS.map((market) => [market.symbol, flowBars[market.symbol]!])) as Record<CryptoSymbol, NonNullable<StrategyContext['orderFlow']>[number]>);
    }
  }

  if (commonTimes.length < 2) throw new Error('Not enough aligned one-minute candles across BTC, ETH, and SOL for this date range.');

  const results: CryptoAgentBacktestResult[] = [];
  for (let strategyIndex = 0; strategyIndex < STRATEGY_MODULES.length; strategyIndex++) {
    const strategyModule = STRATEGY_MODULES[strategyIndex];
    const strategyKey = strategyModule.key as StrategyKey;
    const initialBudget = budgets[strategyKey];
    let cash = initialBudget;
    let position: OpenPosition | null = null;
    let peakEquity = initialBudget;
    let maxDrawdown = 0;
    let totalFees = 0;
    const trades: CryptoBacktestTrade[] = [];
    const bySymbol = { BTC: 0, ETH: 0, SOL: 0 } satisfies Record<CryptoSymbol, number>;
    const strategyCandles = Object.fromEntries(CRYPTO_MARKETS.map((market) => [market.symbol, [] as Candle[]])) as Record<CryptoSymbol, Candle[]>;
    const strategyFlow = Object.fromEntries(CRYPTO_MARKETS.map((market) => [market.symbol, [] as NonNullable<StrategyContext['orderFlow']>])) as Record<CryptoSymbol, NonNullable<StrategyContext['orderFlow']>>;

    const closePosition = (rawPrice: number, time: number, reason: string) => {
      if (!position) return;
      const exitPrice = rawPrice * (position.side === 'LONG' ? 1 - SLIPPAGE_RATE : 1 + SLIPPAGE_RATE);
      const exitFee = exitPrice * position.quantity * FEE_RATE;
      const pnl = calculatePaperRealizedPnl({ side: position.side, quantity: position.quantity, entryPrice: position.entryPrice, exitPrice, entryFee: position.entryFee, exitFee });
      cash += calculatePaperExitCashReturn({ side: position.side, quantity: position.quantity, entryPrice: position.entryPrice, exitPrice, exitFee });
      totalFees += exitFee;
      trades.push({
        symbol: `${position.symbol}/USDT`, side: position.side, entryTime: new Date(position.entryTime * 1000).toISOString(),
        exitTime: new Date(time * 1000).toISOString(), entryPrice: position.entryPrice, exitPrice,
        quantity: position.quantity, pnl, exitReason: reason,
      });
      bySymbol[position.symbol] += 1;
      position = null;
    };

    for (let index = 1; index < commonTimes.length - 1; index++) {
      const time = commonTimes[index];
      const completedFiveMinute = completedFiveMinuteAt.get(index);
      if (completedFiveMinute) {
        const completedFlow = completedFiveMinuteFlowAt.get(index);
        for (const market of CRYPTO_MARKETS) {
          strategyCandles[market.symbol].push(completedFiveMinute[market.symbol]);
          if (completedFlow) strategyFlow[market.symbol].push(completedFlow[market.symbol]);
        }
      }
      let closedThisMinute = false;
      if (position) {
        const heldBars = candles[position.symbol];
        const bar = heldBars[index];
        const isLong = position.side === 'LONG';
        const stopTouched = isLong ? bar.low <= position.stop : bar.high >= position.stop;
        const targetTouched = isLong ? bar.high >= position.target : bar.low <= position.target;
        if (stopTouched) {
          const fill = isLong ? (bar.open < position.stop ? bar.open : position.stop) : (bar.open > position.stop ? bar.open : position.stop);
          closePosition(fill, time, 'STOP_LOSS');
          closedThisMinute = true;
        } else if (targetTouched) {
          const fill = isLong ? (bar.open > position.target ? bar.open : position.target) : (bar.open < position.target ? bar.open : position.target);
          closePosition(fill, time, 'TAKE_PROFIT');
          closedThisMinute = true;
        } else if (completedFiveMinute) {
          const history = strategyCandles[position.symbol].slice(-250);
          const orderFlow = strategyFlow[position.symbol].slice(-250);
          const decision = strategyModule.evaluate({ candles: history, orderFlow, hasPosition: true, positionSide: position.side, timeframeMinutes: 5, config: { ...DEFAULT_STRATEGY_CONFIG, timeframeMinutes: 5 }, supportsPairedExecution: false });
          const directionalDecision = strategyModule.evaluate({ candles: history, orderFlow, timeframeMinutes: 5, config: { ...DEFAULT_STRATEGY_CONFIG, timeframeMinutes: 5 }, supportsPairedExecution: false });
          if (decision.signal === 'EXIT' || directionalDecision.signal === (isLong ? 'SHORT' : 'LONG')) {
            const next = heldBars[index + 1];
            closePosition(next.open, next.time, 'OPPOSING_STRATEGY_SIGNAL');
            closedThisMinute = true;
          }
        }
        if (position) {
          const markEquity = cash + calculatePaperPositionValue({ side: position.side, quantity: position.quantity, entryPrice: position.entryPrice, markPrice: bar.close });
          peakEquity = Math.max(peakEquity, markEquity);
          maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - markEquity) / peakEquity : 0);
        }
      }

      if (!position && !closedThisMinute && completedFiveMinute) {
        let best: { symbol: CryptoSymbol; output: ReturnType<typeof strategyModule.evaluate>; side: 'LONG' | 'SHORT' } | null = null;
        for (const market of CRYPTO_MARKETS) {
          const history = strategyCandles[market.symbol].slice(-250);
          const output = strategyModule.evaluate({ candles: history, orderFlow: strategyFlow[market.symbol].slice(-250), timeframeMinutes: 5, config: { ...DEFAULT_STRATEGY_CONFIG, timeframeMinutes: 5 }, supportsPairedExecution: false });
          if ((output.signal !== 'LONG' && output.signal !== 'SHORT') || output.confidence < STRATEGY_MIN_CONFIDENCE) continue;
          if (!best || output.confidence > best.output.confidence) best = { symbol: market.symbol, output, side: output.signal };
        }

        if (best?.output.entry_price !== null && best?.output.entry_price !== undefined && best.output.stop_loss !== null && best.output.target !== null) {
          const market = CRYPTO_MARKETS.find((item) => item.symbol === best!.symbol)!;
          const isLong = best.side === 'LONG';
          const fillPrice = candles[best.symbol][index + 1].open * (isLong ? 1 + SLIPPAGE_RATE : 1 - SLIPPAGE_RATE);
          const riskDistance = Math.abs(best.output.entry_price - best.output.stop_loss);
          const targetDistance = Math.abs(best.output.target - best.output.entry_price);
          const stop = fillPrice + (isLong ? -1 : 1) * riskDistance;
          const target = fillPrice + (isLong ? 1 : -1) * targetDistance;
          const riskBudget = cash * RISK_FRACTION;
          const notionalLimit = cash * MAX_EXPOSURE;
          const rawQuantity = Math.min(riskBudget / riskDistance, notionalLimit / fillPrice);
          const quantity = floorQuantityToStep(rawQuantity, market.minQty);
          const notional = quantity * fillPrice;
          const entryFee = notional * FEE_RATE;
          if (quantity >= market.minQty && riskDistance > 0 && cash >= notional + entryFee && (isLong ? target > fillPrice && stop < fillPrice : target < fillPrice && stop > fillPrice)) {
            cash -= notional + entryFee;
            totalFees += entryFee;
            position = { symbol: best.symbol, quantity, side: best.side, entryPrice: fillPrice, stop, target, entryFee, entryTime: commonTimes[index + 1] };
          }
        }
      }

      const equity = cash + (position ? calculatePaperPositionValue({ side: position.side, quantity: position.quantity, entryPrice: position.entryPrice, markPrice: candles[position.symbol][index].close }) : 0);
      peakEquity = Math.max(peakEquity, equity);
      maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0);
      const stride = Math.max(50, Math.floor(commonTimes.length / 100));
      if (index % stride === 0) {
        onProgress?.(strategyIndex, index / Math.max(1, commonTimes.length - 2), strategyModule.name);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }

    if (position) {
      const lastIndex = commonTimes.length - 1;
      closePosition(candles[position.symbol][lastIndex].close, commonTimes[lastIndex], 'END_OF_BACKTEST');
    }

    const wins = trades.filter((trade) => trade.pnl > 0).length;
    const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
    const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
    const netPnl = trades.reduce((sum, trade) => sum + trade.pnl, 0);
    const finalBalance = initialBudget + netPnl;
    maxDrawdown = Math.max(maxDrawdown, peakEquity > 0 ? Math.max(0, (peakEquity - finalBalance) / peakEquity) : 0);
    results.push({
      key: strategyKey, strategy: strategyModule.name, initialBudget, finalBalance: Number(finalBalance.toFixed(2)),
      netPnl: Number(netPnl.toFixed(2)), returnPct: Number((netPnl / initialBudget * 100).toFixed(2)),
      maxDrawdownPct: Number((maxDrawdown * 100).toFixed(2)), trades: trades.length, wins, losses: trades.length - wins,
      winRate: trades.length ? Number((wins / trades.length * 100).toFixed(1)) : 0,
      profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit ? null : 0,
      fees: Number(totalFees.toFixed(2)), bySymbol, recentTrades: trades.slice(-20).reverse(),
    });
    onProgress?.(strategyIndex, 1, strategyModule.name);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }

  return {
    timeframe: '1m execution / 5m strategy signals', candleCount: commonTimes.length, from: new Date(commonTimes[0] * 1000).toISOString(),
    to: new Date(commonTimes.at(-1)! * 1000).toISOString(), symbols: CRYPTO_MARKETS.map((market) => `${market.symbol}/USDT`),
    methodology: 'Crypto long and fully collateralized 1x short simulation using one-minute candles for fills and stop/target checks, with strategy signals evaluated on completed five-minute bars to match the live agents. Binance taker-buy volume is aggregated into five-minute order-flow bars for Order Flow. Entry notional is reserved from the agent budget, so no borrowed funds or leverage above 1x is used. Opposing strategy signals close positions at the next one-minute open. Fees and slippage are applied on both sides; if stop and target touch in the same minute, stop is assumed first. Statistical Pairs remains disabled because paired atomic execution is unsupported.',
    results,
  };
}
