import { prisma } from '@/lib/db/prisma';
import { getIndianMarketStatus } from '@/lib/market-data/calendar';
import { getYahooMarketSnapshots, timeframeMinutes, type StrategyMarketSymbol } from './market-data';
import { getCryptoMarketSnapshots } from '@/lib/market-data/crypto-provider';
import { DEFAULT_STRATEGY_CONFIG, evaluateStrategySignals, STRATEGY_DEFINITIONS, STRATEGY_MODULES, type StrategyKey } from './strategies';
import { isAfterStrategyEntryStart, STRATEGY_MIN_CONFIDENCE } from './entry-policy';
import { getLiveOptionChain, getOptionQuoteForOpenTrade, parseOptionSymbol, selectLiveOption } from './live-options';
import { Prisma, StrategyCompetitionStatus } from '@prisma/client';

const ORDER_FEE = 20;
const SLIPPAGE_RATE = 0.0005;
const DAILY_LOSS_LIMIT = 0.02;
const RISK_PER_TRADE = 0.005;
const MAX_EXPOSURE = 0.2;
const MAX_QUOTE_AGE_MS = 60_000;
const MAX_BAR_AGE_MS = 90_000;

export function istDateKey(date = new Date()): string {
  return date.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

const money = (value: number) => new Prisma.Decimal(value.toFixed(2));
const roundPrice = (value: number) => Number(value.toFixed(4));

export async function getLatestCompetition(userId: string, marketType: string = 'INDIAN') {
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const competition = await prisma.strategyCompetition.findFirst({
    where: { userId, marketType },
    orderBy: { createdAt: 'desc' },
    include: {
      agents: {
        include: {
          trades: {
            where: {
              OR: [
                { status: 'OPEN' },
                { openedAt: { gte: twentyFourHoursAgo } },
                { closedAt: { gte: twentyFourHoursAgo } },
              ],
            },
            orderBy: { openedAt: 'desc' },
          },
          signals: { take: 5, orderBy: { createdAt: 'desc' } },
        },
      },
    },
  });
  if (!competition) return null;
  const latestPrice = Number(competition.latestPrice || 0);
  const currency = competition.currency || (competition.marketType === 'CRYPTO' ? 'USDT' : 'INR');
  const agents = competition.agents.map((agent) => {
    const openTrade = agent.trades.find((t) => t.status === 'OPEN') || null;
    const tradesLast24h = agent.trades.filter((t) => (t.openedAt >= twentyFourHoursAgo || (t.closedAt && t.closedAt >= twentyFourHoursAgo)));
    const markedPrice = Number(openTrade?.currentPrice || latestPrice || 0);
    const isLong = !openTrade?.entryReason?.includes('SHORT');
    const unrealizedPnL = openTrade
      ? (isLong ? (markedPrice - Number(openTrade.entryPrice)) : (Number(openTrade.entryPrice) - markedPrice)) * openTrade.quantity - Number(openTrade.entryFees)
      : 0;
    const equity = Number(agent.cashBalance) + (openTrade ? (isLong ? markedPrice * openTrade.quantity : (Number(openTrade.entryPrice) * openTrade.quantity + unrealizedPnL)) : 0);
    return {
      ...agent,
      currency: agent.currency || currency,
      initialCapital: Number(agent.initialCapital),
      cashBalance: Number(agent.cashBalance),
      realizedPnL: Number(agent.realizedPnL),
      dailyRealizedPnL: Number(agent.dailyRealizedPnL),
      peakEquity: Number(agent.peakEquity),
      maxDrawdown: Number(agent.maxDrawdown),
      hasRecentTrades: tradesLast24h.length > 0 || agent.entriesToday > 0 || openTrade !== null,
      openTrade: openTrade ? {
        ...openTrade,
        quantity: openTrade.quantity,
        entryPrice: Number(openTrade.entryPrice),
        currentPrice: markedPrice,
        stopLossPrice: Number(openTrade.stopLossPrice),
        takeProfitPrice: Number(openTrade.takeProfitPrice),
        unrealizedPnL,
      } : null,
      equity,
      totalPnL: equity - Number(agent.initialCapital),
      dailyPnL: Number(agent.dailyRealizedPnL) + (agent.sessionDate === istDateKey() ? unrealizedPnL : 0),
      recentSignals: agent.signals.map((signal) => ({ ...signal, referencePrice: Number(signal.referencePrice) })),
    };
  });
  const portfolioLeaderboard = [...agents].sort((a, b) => b.equity - a.equity).map((agent, index) => ({ ...agent, rank: index + 1 }));
  const dailyProfitLeaderboard = [...agents]
    .filter((agent) => agent.hasRecentTrades)
    .sort((a, b) => b.dailyPnL - a.dailyPnL)
    .map((agent, index) => ({ ...agent, rank: index + 1 }));
  return {
    id: competition.id,
    marketType: competition.marketType || 'INDIAN',
    currency,
    status: competition.status,
    instrumentKey: competition.instrumentKey,
    initialCapital: Number(competition.initialCapital),
    latestPrice,
    latestPriceAt: competition.latestPriceAt,
    lastTickAt: competition.lastTickAt,
    lastError: competition.lastError,
    startedAt: competition.startedAt,
    stoppedAt: competition.stoppedAt,
    portfolioLeaderboard,
    dailyProfitLeaderboard,
  };
}

export async function createCompetition(userId: string, marketType: string = 'INDIAN') {
  const existing = await prisma.strategyCompetition.findFirst({
    where: { userId, marketType, status: { in: ['WAITING_FOR_MARKET', 'WAITING_FOR_LIVE_DATA', 'RUNNING'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (existing) return existing;

  const initialCapital = new Prisma.Decimal(1_000_000);
  const sessionDate = istDateKey();
  const isCrypto = marketType === 'CRYPTO';
  const currency = isCrypto ? 'USDT' : 'INR';
  const instrumentKey = isCrypto ? 'BTC · ETH · SOL Perpetual & Spot' : 'NIFTY · BANKNIFTY · SENSEX options';
  const status = isCrypto ? 'RUNNING' : 'WAITING_FOR_MARKET';

  return prisma.strategyCompetition.create({
    data: {
      userId,
      marketType,
      currency,
      status,
      instrumentKey,
      initialCapital,
      agents: {
        create: STRATEGY_DEFINITIONS.map((strategy) => ({
          key: strategy.key,
          name: strategy.name,
          description: strategy.description,
          currency,
          initialCapital,
          cashBalance: initialCapital,
          peakEquity: initialCapital,
          sessionDate,
        })),
      },
    },
    include: { agents: true },
  });
}

/** Opening the arena starts today's paper session automatically; a manual stop remains in effect for that day. */
export async function getOrCreateTodayCompetition(userId: string, marketType: string = 'INDIAN') {
  const today = istDateKey();
  const latest = await prisma.strategyCompetition.findFirst({ where: { userId, marketType }, orderBy: { createdAt: 'desc' } });
  if (latest && (latest.status !== 'STOPPED' || (marketType === 'INDIAN' && istDateKey(latest.createdAt) === today))) return latest;
  return createCompetition(userId, marketType);
}

async function updateWaiting(competitionId: string, status: StrategyCompetitionStatus, message: string) {
  await prisma.strategyCompetition.update({
    where: { id: competitionId },
    data: { status, lastError: message, tickLeaseUntil: null, lastTickAt: new Date() },
  });
}

export async function tickCompetition(userId: string, competitionId: string) {
  const now = new Date();
  const claimed = await prisma.strategyCompetition.updateMany({
    where: { id: competitionId, userId, status: { in: ['WAITING_FOR_MARKET', 'WAITING_FOR_LIVE_DATA', 'RUNNING'] }, OR: [{ tickLeaseUntil: null }, { tickLeaseUntil: { lt: now } }] },
    data: { tickLeaseUntil: new Date(now.getTime() + 30_000) },
  });

  const comp = await prisma.strategyCompetition.findUnique({ where: { id: competitionId } });
  const marketType = comp?.marketType || 'INDIAN';

  if (!claimed.count) return getLatestCompetition(userId, marketType);

  try {
    const competition = await prisma.strategyCompetition.findFirst({ where: { id: competitionId, userId } });
    if (!competition || competition.status === 'STOPPED') return getLatestCompetition(userId, marketType);

    if (competition.marketType === 'CRYPTO') {
      await tickCryptoCompetition(userId, competitionId);
    } else {
      await tickIndianCompetition(userId, competitionId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Live market data or strategy processing failed.';
    await updateWaiting(competitionId, 'WAITING_FOR_LIVE_DATA', message).catch(() => undefined);
  }
  return getLatestCompetition(userId, marketType);
}

async function tickCryptoCompetition(userId: string, competitionId: string) {
  const now = new Date();
  const markets = await getCryptoMarketSnapshots();
  const marketBySymbol = new Map(markets.map((m) => [m.symbol, m]));
  const marketByPair = new Map(markets.map((m) => [m.pair, m]));

  const latestBar = markets[0].candles.at(-1)!;
  if (!latestBar) throw new Error('Waiting for 24/7 crypto market candles.');

  await prisma.$transaction(async (tx) => {
    const currentCompetition = await tx.strategyCompetition.findFirst({
      where: { id: competitionId, userId, status: { in: ['WAITING_FOR_MARKET', 'WAITING_FOR_LIVE_DATA', 'RUNNING'] } },
      include: { agents: true },
    });
    if (!currentCompetition) return;

    const newBarAt = new Date(latestBar.time * 1000);
    const isNewBar = !currentCompetition.lastProcessedBarAt || currentCompetition.lastProcessedBarAt.getTime() !== newBarAt.getTime();
    const definitions = new Map(STRATEGY_DEFINITIONS.map((d) => [d.key, d]));
    const openTrades = await tx.strategyTrade.findMany({
      where: { agentId: { in: currentCompetition.agents.map((a) => a.id) }, status: 'OPEN' },
    });
    const openByAgent = new Map(openTrades.map((t) => [t.agentId, t]));
    const today = istDateKey(now);

    const evaluations = new Map<string, ReturnType<typeof evaluateStrategySignals>>();
    for (const market of markets) {
      const signals = evaluateStrategySignals({ candles: market.candles, config: DEFAULT_STRATEGY_CONFIG, timeframeMinutes: 5 });
      evaluations.set(market.symbol, signals);
    }

    for (const originalAgent of currentCompetition.agents) {
      const agent = originalAgent.sessionDate === today ? originalAgent : { ...originalAgent, sessionDate: today, dailyRealizedPnL: new Prisma.Decimal(0), entriesToday: 0, isPaused: false };
      const strategyKey = agent.key as StrategyKey;
      const existingTrade = openByAgent.get(agent.id) || null;

      const heldMarket = existingTrade
        ? (marketByPair.get(existingTrade.symbol) || marketBySymbol.get(existingTrade.symbol.split('/')[0] as any) || markets[0])
        : null;
      const livePrice = heldMarket?.price || markets[0].price;

      let candidate: { market: typeof markets[number]; output: any; side: 'LONG' | 'SHORT' } | null = null;
      if (!existingTrade) {
        for (const market of markets) {
          const output = evaluations.get(market.symbol)![strategyKey];
          if (output.signal !== 'LONG' && output.signal !== 'SHORT') continue;
          if (output.confidence < STRATEGY_MIN_CONFIDENCE) continue;
          const proposed = { market, output, side: output.signal as 'LONG' | 'SHORT' };
          if (!candidate || proposed.output.confidence > candidate.output.confidence) candidate = proposed;
        }
      }

      const activeOutput = existingTrade ? evaluations.get(heldMarket?.symbol || markets[0].symbol)![strategyKey] : candidate?.output || null;
      let logOutput = activeOutput || STRATEGY_MODULES.find((m) => m.key === strategyKey)!.evaluate({ candles: markets[0].candles, config: DEFAULT_STRATEGY_CONFIG });

      let cash = Number(agent.cashBalance), realized = Number(agent.realizedPnL), dailyRealized = Number(agent.dailyRealizedPnL);
      let paused = agent.isPaused, openTrade = existingTrade, newEntry = false, didCloseTrade = false;
      let nextAction: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let nextReason = logOutput.reason.join(' ');

      if (openTrade && heldMarket) {
        const entryPrice = Number(openTrade.entryPrice);
        const stop = Number(openTrade.stopLossPrice);
        const target = Number(openTrade.takeProfitPrice);
        const currentMktPrice = livePrice;
        let exitReason: string | null = null;

        const isLong = !openTrade.entryReason.includes('SHORT');
        if (isLong) {
          if (currentMktPrice <= stop) exitReason = 'Crypto Stop-Loss triggered';
          else if (currentMktPrice >= target) exitReason = 'Crypto Take-Profit reached';
          else if (isNewBar && (logOutput.signal === 'EXIT' || logOutput.signal === 'SHORT')) exitReason = logOutput.reason.join(' ');
        } else {
          if (currentMktPrice >= stop) exitReason = 'Crypto Short Stop-Loss triggered';
          else if (currentMktPrice <= target) exitReason = 'Crypto Short Take-Profit reached';
          else if (isNewBar && (logOutput.signal === 'EXIT' || logOutput.signal === 'LONG')) exitReason = logOutput.reason.join(' ');
        }

        const openPnl = isLong
          ? (currentMktPrice - entryPrice) * openTrade.quantity - Number(openTrade.entryFees)
          : (entryPrice - currentMktPrice) * openTrade.quantity - Number(openTrade.entryFees);

        if (dailyRealized + openPnl <= -Number(agent.initialCapital) * DAILY_LOSS_LIMIT) {
          exitReason = '24/7 Daily Loss Limit (2%) reached';
          paused = true;
        }

        if (exitReason) {
          const exitPrice = roundPrice(isLong ? currentMktPrice * (1 - SLIPPAGE_RATE) : currentMktPrice * (1 + SLIPPAGE_RATE));
          const exitFee = roundPrice(exitPrice * openTrade.quantity * 0.0005);
          const pnl = isLong
            ? (exitPrice - entryPrice) * openTrade.quantity - Number(openTrade.entryFees) - exitFee
            : (entryPrice - exitPrice) * openTrade.quantity - Number(openTrade.entryFees) - exitFee;

          cash += isLong
            ? (exitPrice * openTrade.quantity - exitFee)
            : (Number(openTrade.entryPrice) * openTrade.quantity + pnl - exitFee);
          realized += pnl;
          dailyRealized += pnl;

          await tx.strategyTrade.update({
            where: { id: openTrade.id },
            data: { status: 'CLOSED', currentPrice: money(currentMktPrice), exitPrice: money(exitPrice), exitFees: money(exitFee), realizedPnL: money(pnl), exitReason, closedAt: now },
          });
          openTrade = null;
          didCloseTrade = true;
          nextAction = 'SELL';
          nextReason = exitReason;
          logOutput = { ...logOutput, signal: 'EXIT', entry_price: null, stop_loss: null, target: null, risk_reward: null, reason: [exitReason] };
        } else {
          await tx.strategyTrade.update({
            where: { id: openTrade.id },
            data: { currentPrice: money(currentMktPrice) },
          });
        }
      }

      if (paused && !openTrade) {
        nextAction = 'HOLD';
        nextReason = 'Paused: 2% daily loss limit reached in 24/7 crypto arena.';
      }

      if (!openTrade && !didCloseTrade && !paused && isNewBar && candidate && candidate.output.confidence >= STRATEGY_MIN_CONFIDENCE) {
        const fillPrice = roundPrice(candidate.side === 'LONG' ? candidate.market.price * (1 + SLIPPAGE_RATE) : candidate.market.price * (1 - SLIPPAGE_RATE));
        const stopPct = 0.02;
        const targetPct = 0.04;
        const stopLossPrice = roundPrice(candidate.side === 'LONG' ? fillPrice * (1 - stopPct) : fillPrice * (1 + stopPct));
        const takeProfitPrice = roundPrice(candidate.side === 'LONG' ? fillPrice * (1 + targetPct) : fillPrice * (1 - targetPct));

        const riskBudget = cash * RISK_PER_TRADE;
        const maxNotional = cash * MAX_EXPOSURE;
        const riskDistance = Math.abs(fillPrice - stopLossPrice);

        const rawUnits = Math.min(maxNotional / fillPrice, riskBudget / riskDistance);
        let quantity = Math.max(1, Math.floor(rawUnits));
        if (candidate.market.symbol === 'BTC') quantity = Math.max(1, Math.min(2, Math.floor(rawUnits)));
        else if (candidate.market.symbol === 'ETH') quantity = Math.max(1, Math.min(50, Math.floor(rawUnits)));
        else if (candidate.market.symbol === 'SOL') quantity = Math.max(10, Math.min(1000, Math.floor(rawUnits)));

        const notional = fillPrice * quantity;
        const entryFee = roundPrice(notional * 0.0005);

        if (cash >= notional + entryFee) {
          const newCash = cash - notional - entryFee;
          const markedEquity = newCash + notional;
          const peak = Math.max(Number(agent.peakEquity), markedEquity);
          const drawdown = Math.max(Number(agent.maxDrawdown), peak - markedEquity);
          const tradeSymbol = `${candidate.market.symbol}/USDT`;

          const output = {
            ...candidate.output,
            signal: candidate.side,
            entry_price: fillPrice,
            stop_loss: stopLossPrice,
            target: takeProfitPrice,
            risk_reward: 2.0,
            reason: [...candidate.output.reason, `Crypto ${candidate.side} ${quantity} ${candidate.market.symbol} @ $${fillPrice.toFixed(2)} USDT`],
            underlying: tradeSymbol,
          };

          await tx.strategyTrade.create({
            data: {
              agentId: agent.id,
              symbol: tradeSymbol,
              quantity,
              entryPrice: money(fillPrice),
              currentPrice: money(fillPrice),
              stopLossPrice: money(stopLossPrice),
              takeProfitPrice: money(takeProfitPrice),
              entryFees: money(entryFee),
              entryReason: output.reason.join(' '),
              openedAt: now,
            },
          });

          cash = newCash;
          newEntry = true;
          nextAction = candidate.side === 'LONG' ? 'BUY' : 'SELL';
          nextReason = `Entered ${candidate.side} ${quantity} ${candidate.market.symbol}/USDT @ $${fillPrice.toFixed(2)}.`;
          logOutput = output;

          await tx.strategyAgent.update({
            where: { id: agent.id },
            data: { cashBalance: money(cash), sessionDate: today, entriesToday: { increment: 1 }, isPaused: paused, lastAction: nextAction, lastReason: nextReason, lastSignalAt: now, peakEquity: money(peak), maxDrawdown: money(drawdown) },
          });
        }
      }

      if (!newEntry) {
        const openValue = openTrade ? (Number(openTrade.currentPrice) * openTrade.quantity) : 0;
        const equity = cash + openValue;
        const peak = Math.max(Number(agent.peakEquity), equity);
        const drawdown = Math.max(Number(agent.maxDrawdown), peak - equity);
        await tx.strategyAgent.update({
          where: { id: agent.id },
          data: { cashBalance: money(cash), realizedPnL: money(realized), dailyRealizedPnL: money(dailyRealized), sessionDate: today, isPaused: paused, lastAction: nextAction, lastReason: nextReason, ...(isNewBar ? { lastSignalAt: now } : {}), peakEquity: money(peak), maxDrawdown: money(drawdown) },
        });
      }

      if (isNewBar) {
        const signalOutput = { ...logOutput, timestamp: new Date(latestBar.time * 1000).toISOString() };
        await tx.strategySignal.create({
          data: {
            agentId: agent.id,
            action: signalOutput.signal as unknown as import('@prisma/client').StrategySignalAction,
            reason: signalOutput.reason.join(' '),
            referencePrice: money(candidate?.market.price || heldMarket?.price || markets[0].price),
            output: signalOutput as unknown as Prisma.InputJsonValue,
            createdAt: newBarAt,
          },
        });
      }

      const refreshedOpen = openTrade || (newEntry ? await tx.strategyTrade.findFirst({ where: { agentId: agent.id, status: 'OPEN' }, orderBy: { openedAt: 'desc' } }) : null);
      const equity = cash + (refreshedOpen ? Number(refreshedOpen.currentPrice) * refreshedOpen.quantity : 0);
      await tx.strategyAgentSnapshot.create({
        data: {
          agentId: agent.id,
          equity: money(equity),
          cashBalance: money(cash),
          totalPnL: money(equity - Number(agent.initialCapital)),
          dailyPnL: money(dailyRealized + (refreshedOpen ? (Number(refreshedOpen.currentPrice) - Number(refreshedOpen.entryPrice)) * refreshedOpen.quantity - Number(refreshedOpen.entryFees) : 0)),
        },
      });
    }

    await tx.strategyCompetition.update({
      where: { id: competitionId },
      data: {
        status: 'RUNNING',
        latestPrice: money(markets[0].price),
        latestPriceAt: markets[0].lastTradeAt,
        lastProcessedBarAt: isNewBar ? newBarAt : currentCompetition.lastProcessedBarAt,
        lastTickAt: now,
        tickLeaseUntil: null,
        lastError: null,
      },
    });
  });
}

async function tickIndianCompetition(userId: string, competitionId: string) {
  const now = new Date();
  const marketStatus = getIndianMarketStatus(now);
  if (!marketStatus.isOpen) {
    await updateWaiting(competitionId, 'WAITING_FOR_MARKET', marketStatus.status === 'PRE_OPEN'
      ? 'Pre-open is in progress. Strategy entries wait for regular trading at 09:15 IST.'
      : `Waiting for the regular session (${marketStatus.message.toLowerCase()}).`);
    return;
  }

  const markets = await getYahooMarketSnapshots();
  const marketBySymbol = new Map(markets.map((market) => [market.symbol, market]));
  for (const market of markets) {
    const quoteAge = now.getTime() - market.lastTradeAt.getTime();
    const lastBar = market.candles.at(-1)!;
    const barAge = now.getTime() - lastBar.time * 1000;
    if (quoteAge < -15_000 || quoteAge > MAX_QUOTE_AGE_MS) throw new Error(`Yahoo's ${market.symbol} index quote is stale. Waiting for fresh underlying data.`);
    if (barAge < -15_000 || barAge > timeframeMinutes() * 60_000 + MAX_BAR_AGE_MS) throw new Error(`The latest ${timeframeMinutes()}-minute ${market.symbol} candle is stale. Waiting for fresh candles.`);
  }

  const chains = new Map<StrategyMarketSymbol, Awaited<ReturnType<typeof getLiveOptionChain>>>();
  for (const market of markets) chains.set(market.symbol, await getLiveOptionChain(market.symbol));
  const latestBar = markets[0].candles.at(-1)!;

  await prisma.$transaction(async (tx) => {
    const currentCompetition = await tx.strategyCompetition.findFirst({
      where: { id: competitionId, userId, status: { in: ['WAITING_FOR_MARKET', 'WAITING_FOR_LIVE_DATA', 'RUNNING'] } },
      include: { agents: true },
    });
    if (!currentCompetition) return;
    const newBarAt = new Date(latestBar.time * 1000);
    const isNewBar = !currentCompetition.lastProcessedBarAt || currentCompetition.lastProcessedBarAt.getTime() !== newBarAt.getTime();
    const definitions = new Map(STRATEGY_DEFINITIONS.map((definition) => [definition.key, definition]));
    const openTrades = await tx.strategyTrade.findMany({ where: { agentId: { in: currentCompetition.agents.map((agent) => agent.id) }, status: 'OPEN' } });
    const openByAgent = new Map(openTrades.map((trade) => [trade.agentId, trade]));
    const today = istDateKey(now);
    const evaluations = new Map<StrategyMarketSymbol, ReturnType<typeof evaluateStrategySignals>>();
    for (const market of markets) {
      const heldKeys = new Set<StrategyKey>();
      for (const agent of currentCompetition.agents) {
        const trade = openByAgent.get(agent.id);
        if (trade && parseOptionSymbol(trade.symbol)?.market === market.symbol) heldKeys.add(agent.key as StrategyKey);
      }
      const signals = evaluateStrategySignals({ candles: market.candles, config: DEFAULT_STRATEGY_CONFIG, timeframeMinutes: timeframeMinutes() });
      for (const stratModule of STRATEGY_MODULES) {
        const held = heldKeys.has(stratModule.key as StrategyKey);
        if (held) signals[stratModule.key as StrategyKey] = stratModule.evaluate({ candles: market.candles, config: DEFAULT_STRATEGY_CONFIG, timeframeMinutes: timeframeMinutes(), hasPosition: true, positionSide: 'LONG' });
      }
      evaluations.set(market.symbol, signals);
    }

    const marketTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
    const forceFlatten = marketTime >= '15:20:00';
    for (const originalAgent of currentCompetition.agents) {
      const agent = originalAgent.sessionDate === today ? originalAgent : { ...originalAgent, sessionDate: today, dailyRealizedPnL: new Prisma.Decimal(0), entriesToday: 0, isPaused: false };
      const strategyKey = agent.key as StrategyKey;
      const existingTrade = openByAgent.get(agent.id) || null;
      const parsedOpen = existingTrade ? parseOptionSymbol(existingTrade.symbol) : null;
      const heldMarket = parsedOpen ? marketBySymbol.get(parsedOpen.market) : null;
      const heldChain = parsedOpen ? chains.get(parsedOpen.market) : undefined;
      const heldQuote = parsedOpen && heldChain ? getOptionQuoteForOpenTrade(parsedOpen.market, parsedOpen.expiry, parsedOpen.strike, parsedOpen.side, heldChain) : null;

      let candidate: { market: typeof markets[number]; output: (typeof STRATEGY_MODULES)[number] extends never ? never : import('./strategy-types').StrategySignal; side: 'CE' | 'PE' } | null = null;
      if (!existingTrade && isAfterStrategyEntryStart(now)) {
        for (const market of markets) {
          const output = evaluations.get(market.symbol)![strategyKey];
          if (output.signal !== 'LONG' && output.signal !== 'SHORT') continue;
          if (output.confidence < STRATEGY_MIN_CONFIDENCE) continue;
          const proposed = { market, output, side: output.signal === 'LONG' ? 'CE' as const : 'PE' as const };
          if (!candidate || proposed.output.confidence > candidate.output.confidence) candidate = proposed;
        }
      }
      const activeOutput = parsedOpen ? evaluations.get(parsedOpen.market)![strategyKey] : candidate?.output || null;
      let logOutput = activeOutput || STRATEGY_MODULES.find((module) => module.key === strategyKey)!.evaluate({ candles: markets[0].candles, config: DEFAULT_STRATEGY_CONFIG });
      let cash = Number(agent.cashBalance), realized = Number(agent.realizedPnL), dailyRealized = Number(agent.dailyRealizedPnL);
      let paused = agent.isPaused, openTrade = existingTrade, newEntry = false, didCloseTrade = false;
      let nextAction: 'BUY' | 'SELL' | 'HOLD' = 'HOLD';
      let nextReason = logOutput.reason.join(' ');
      const entryFee = ORDER_FEE;
      const exitFee = ORDER_FEE;
      let livePremium = heldQuote?.ltp || Number(existingTrade?.currentPrice || 0);

      if (openTrade && parsedOpen && heldMarket) {
        const entryPrice = Number(openTrade.entryPrice), stop = Number(openTrade.stopLossPrice), target = Number(openTrade.takeProfitPrice);
        const sideSignal = parsedOpen.side === 'CE' ? 'LONG' : 'SHORT';
        let exitReason: string | null = null;
        if (originalAgent.sessionDate !== today) exitReason = 'Overnight safety close on the first session quote';
        else if (forceFlatten) exitReason = 'Intraday flatten at 15:20 IST';
        else if (heldQuote && livePremium <= stop) exitReason = 'Option premium stop loss reached';
        else if (heldQuote && livePremium >= target) exitReason = 'Option premium target reached';
        else if (isNewBar && (logOutput.signal === 'EXIT' || (logOutput.signal === 'LONG' || logOutput.signal === 'SHORT') && logOutput.signal !== sideSignal)) exitReason = logOutput.reason.join(' ');
        else if (dailyRealized + ((livePremium - entryPrice) * openTrade.quantity - Number(openTrade.entryFees)) <= -Number(agent.initialCapital) * DAILY_LOSS_LIMIT) { exitReason = 'Daily loss limit reached'; paused = true; }

        if (exitReason && heldQuote) {
          const exitPrice = roundPrice(heldQuote.bid * (1 - SLIPPAGE_RATE));
          const pnl = (exitPrice - entryPrice) * openTrade.quantity - Number(openTrade.entryFees) - exitFee;
          cash += exitPrice * openTrade.quantity - exitFee; realized += pnl; dailyRealized += pnl;
          await tx.strategyTrade.update({ where: { id: openTrade.id }, data: { status: 'CLOSED', currentPrice: money(livePremium), exitPrice: money(exitPrice), exitFees: money(exitFee), realizedPnL: money(pnl), exitReason, closedAt: now } });
          openTrade = null; didCloseTrade = true; nextAction = 'SELL'; nextReason = exitReason;
          logOutput = { ...logOutput, signal: 'EXIT', entry_price: null, stop_loss: null, target: null, risk_reward: null, reason: [exitReason] };
        } else {
          if (heldQuote) await tx.strategyTrade.update({ where: { id: openTrade.id }, data: { currentPrice: money(livePremium) } });
          else nextReason = 'Holding: a current two-sided Upstox option quote is unavailable; no stale-price exit or mark is used.';
        }
      }

      const currentOpenLoss = openTrade ? Math.min(0, (livePremium - Number(openTrade.entryPrice)) * openTrade.quantity - Number(openTrade.entryFees)) : 0;
      if (dailyRealized + currentOpenLoss <= -Number(agent.initialCapital) * DAILY_LOSS_LIMIT) paused = true;
      if (paused && !openTrade) { nextAction = 'HOLD'; nextReason = 'Paused: the 2% daily loss limit was reached. Resets next trading session.'; }

      if (!openTrade && !didCloseTrade && !paused && isNewBar && candidate && isAfterStrategyEntryStart(now) && candidate.output.confidence >= STRATEGY_MIN_CONFIDENCE) {
        const selected = await selectLiveOption(candidate.market.symbol, candidate.side, candidate.market.price);
        const ltp = selected.ltp;
        const fillPrice = roundPrice(selected.ask * (1 + SLIPPAGE_RATE));
        const stopPct = Number(process.env.STRATEGY_OPTION_STOP_LOSS_PCT || 0.25);
        const targetPct = Number(process.env.STRATEGY_OPTION_TARGET_PCT || 0.40);
        const riskDistance = fillPrice * stopPct;
        const currentEquity = cash, riskBudget = currentEquity * RISK_PER_TRADE, maxNotional = currentEquity * MAX_EXPOSURE;
        const lots = Math.max(0, Math.min(Math.floor(riskBudget / (riskDistance * selected.lotSize)), Math.floor(maxNotional / (fillPrice * selected.lotSize)), Math.floor((cash - entryFee) / (fillPrice * selected.lotSize))));
        const quantity = lots * selected.lotSize;
        if (quantity > 0) {
          const newCash = cash - fillPrice * quantity - entryFee;
          const markedEquity = newCash + ltp * quantity;
          const peak = Math.max(Number(agent.peakEquity), markedEquity), drawdown = Math.max(Number(agent.maxDrawdown), peak - markedEquity);
          const instrumentSymbol = `${selected.symbol}_${selected.expiry}_${selected.strike}_${selected.optionType}`;
          const output = { ...candidate.output, signal: candidate.output.signal, entry_price: fillPrice, stop_loss: roundPrice(fillPrice * (1 - stopPct)), target: roundPrice(fillPrice * (1 + targetPct)), risk_reward: Number((targetPct / stopPct).toFixed(2)), reason: [...candidate.output.reason, `Paper option ${instrumentSymbol}; lot size ${selected.lotSize}; underlying ${candidate.market.price.toFixed(2)}; live ask ${selected.ask.toFixed(2)}.`], underlying: candidate.market.symbol, expiry: selected.expiry, strike: selected.strike, option_type: selected.optionType, instrument_key: selected.instrumentKey, quote: { bid: selected.bid, ask: selected.ask, ltp, spread_pct: selected.spreadPct, volume: selected.volume } };
          await tx.strategyTrade.create({ data: { agentId: agent.id, symbol: instrumentSymbol, quantity, entryPrice: money(fillPrice), currentPrice: money(ltp), stopLossPrice: money(fillPrice * (1 - stopPct)), takeProfitPrice: money(fillPrice * (1 + targetPct)), entryFees: money(entryFee), entryReason: output.reason.join(' '), openedAt: now } });
          cash = newCash; newEntry = true; nextAction = 'BUY'; nextReason = `Bought ${lots} lot(s) of ${instrumentSymbol}.`;
          logOutput = output as unknown as typeof logOutput;
          await tx.strategyAgent.update({ where: { id: agent.id }, data: { cashBalance: money(cash), sessionDate: today, entriesToday: { increment: 1 }, isPaused: paused, lastAction: nextAction, lastReason: nextReason, lastSignalAt: now, peakEquity: money(peak), maxDrawdown: money(drawdown) } });
        } else { nextAction = 'HOLD'; nextReason = 'One lot exceeds the configured risk, exposure, or available-cash limit; no option order simulated.'; logOutput = { ...candidate.output, signal: 'NO_TRADE', entry_price: null, stop_loss: null, target: null, risk_reward: null, reason: [nextReason] }; }
      }

      if (!newEntry) {
        const openValue = openTrade ? livePremium * openTrade.quantity : 0;
        const equity = cash + openValue, peak = Math.max(Number(agent.peakEquity), equity), drawdown = Math.max(Number(agent.maxDrawdown), peak - equity);
        await tx.strategyAgent.update({ where: { id: agent.id }, data: { cashBalance: money(cash), realizedPnL: money(realized), dailyRealizedPnL: money(dailyRealized), sessionDate: today, isPaused: paused, lastAction: nextAction, lastReason: nextReason, ...(isNewBar ? { lastSignalAt: now } : {}), peakEquity: money(peak), maxDrawdown: money(drawdown) } });
      }

      if (isNewBar) {
        const signalOutput = { ...logOutput, timestamp: new Date(latestBar.time * 1000).toISOString() };
        await tx.strategySignal.create({ data: { agentId: agent.id, action: signalOutput.signal as unknown as import('@prisma/client').StrategySignalAction, reason: signalOutput.reason.join(' '), referencePrice: money(candidate?.market.price || heldMarket?.price || markets[0].price), output: signalOutput as unknown as Prisma.InputJsonValue, createdAt: newBarAt } });
      }
      const refreshedOpen = openTrade || (newEntry ? await tx.strategyTrade.findFirst({ where: { agentId: agent.id, status: 'OPEN' }, orderBy: { openedAt: 'desc' } }) : null);
      const equity = cash + (refreshedOpen ? Number(refreshedOpen.currentPrice) * refreshedOpen.quantity : 0);
      await tx.strategyAgentSnapshot.create({ data: { agentId: agent.id, equity: money(equity), cashBalance: money(cash), totalPnL: money(equity - Number(agent.initialCapital)), dailyPnL: money(dailyRealized + (refreshedOpen ? (Number(refreshedOpen.currentPrice) - Number(refreshedOpen.entryPrice)) * refreshedOpen.quantity - Number(refreshedOpen.entryFees) : 0)) } });
    }

    await tx.strategyCompetition.update({ where: { id: competitionId }, data: { status: 'RUNNING', latestPrice: money(markets[0].price), latestPriceAt: markets[0].lastTradeAt, lastProcessedBarAt: isNewBar ? newBarAt : currentCompetition.lastProcessedBarAt, lastTickAt: now, tickLeaseUntil: null, lastError: null } });
  });
}

export async function stopCompetition(userId: string, competitionId: string) {
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const competition = await tx.strategyCompetition.findFirst({ where: { id: competitionId, userId, status: { not: 'STOPPED' } }, include: { agents: true } });
    if (!competition) return false;
    const isCrypto = competition.marketType === 'CRYPTO';
    const openTrades = await tx.strategyTrade.findMany({ where: { agentId: { in: competition.agents.map((agent) => agent.id) }, status: 'OPEN' } });
    for (const trade of openTrades) {
      const price = Number(trade.currentPrice);
      const isLong = !trade.entryReason?.includes('SHORT');
      const exitPrice = roundPrice(isLong ? price * (1 - SLIPPAGE_RATE) : price * (1 + SLIPPAGE_RATE));
      const fees = isCrypto ? roundPrice(exitPrice * trade.quantity * 0.0005) : ORDER_FEE;
      const pnl = isLong
        ? (exitPrice - Number(trade.entryPrice)) * trade.quantity - Number(trade.entryFees) - fees
        : (Number(trade.entryPrice) - exitPrice) * trade.quantity - Number(trade.entryFees) - fees;
      const agent = competition.agents.find((item) => item.id === trade.agentId)!;
      await tx.strategyTrade.update({ where: { id: trade.id }, data: { status: 'CLOSED', exitPrice: money(exitPrice), exitFees: money(fees), realizedPnL: money(pnl), exitReason: 'Session stopped at last verified quote', closedAt: now } });
      const returnCapital = isLong ? (exitPrice * trade.quantity - fees) : (Number(trade.entryPrice) * trade.quantity + pnl - fees);
      await tx.strategyAgent.update({ where: { id: agent.id }, data: { cashBalance: money(Number(agent.cashBalance) + returnCapital), realizedPnL: money(Number(agent.realizedPnL) + pnl), dailyRealizedPnL: money(Number(agent.dailyRealizedPnL) + pnl), lastAction: 'SELL', lastReason: 'Closed at the last verified quote when the session was stopped.', lastSignalAt: now } });
      await tx.strategySignal.create({ data: { agentId: agent.id, action: 'EXIT' as unknown as import('@prisma/client').StrategySignalAction, reason: 'Closed at the last verified quote when the session was stopped.', referencePrice: trade.currentPrice, output: { strategy: agent.key, market_regime: 'UNKNOWN', signal: 'EXIT', confidence: 0, entry_price: null, stop_loss: null, target: null, risk_reward: null, reason: ['Closed at the last verified quote when the session was stopped.'], timestamp: now.toISOString() } } });
    }
    await tx.strategyCompetition.update({ where: { id: competition.id }, data: { status: 'STOPPED', stoppedAt: now, tickLeaseUntil: null, lastError: 'Session stopped. Any open paper positions were closed at the last verified quote.' } });
    return true;
  });
}
