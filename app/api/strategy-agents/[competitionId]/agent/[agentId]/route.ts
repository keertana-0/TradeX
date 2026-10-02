import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionUser } from '@/lib/auth/session';
import { getCryptoMarketSnapshots } from '@/lib/market-data/crypto-provider';
import { getYahooMarketSnapshots } from '@/lib/strategy-agents/market-data';
import { analyzeStrategyConditions } from '@/lib/strategy-agents/telemetry';
import type { Candle } from '@/types/market';

export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { competitionId: string; agentId: string } }
) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { competitionId, agentId } = params;

  try {
    const competition = await prisma.strategyCompetition.findFirst({
      where: { id: competitionId, userId: user.userId },
      include: {
        agents: {
          where: { id: agentId },
          include: {
            trades: { where: { status: 'OPEN' }, take: 1, orderBy: { openedAt: 'desc' } },
            signals: { take: 5, orderBy: { createdAt: 'desc' } },
          },
        },
      },
    });

    if (!competition || !competition.agents[0]) {
      return NextResponse.json({ error: 'Strategy agent not found.' }, { status: 404 });
    }

    const agent = competition.agents[0];
    const isCrypto = competition.marketType === 'CRYPTO';
    const currency = agent.currency || (isCrypto ? 'USDT' : 'INR');
    const openTrade = agent.trades[0] || null;

    let candles: Candle[] = [];
    let currentPrice = Number(competition.latestPrice || 0);
    let assetSymbol = isCrypto ? 'BTC/USDT' : 'NIFTY50';

    // 1. Fetch real-time candles
    if (isCrypto) {
      const cryptoSnaps = await getCryptoMarketSnapshots().catch(() => []);
      const tradeAsset = openTrade?.symbol?.split('/')[0] || 'BTC';
      const snap = cryptoSnaps.find((s) => s.symbol === tradeAsset) || cryptoSnaps[0];
      if (snap) {
        candles = snap.candles;
        currentPrice = snap.price;
        assetSymbol = `${snap.symbol}/USDT`;
      }
    } else {
      const yahooSnaps = await getYahooMarketSnapshots().catch(() => []);
      const snap = yahooSnaps[0];
      if (snap) {
        candles = snap.candles;
        currentPrice = snap.price;
        assetSymbol = snap.symbol;
      }
    }

    // 2. Telemetry when IN A TRADE
    if (openTrade) {
      const entryPrice = Number(openTrade.entryPrice);
      const stopLossPrice = Number(openTrade.stopLossPrice);
      const takeProfitPrice = Number(openTrade.takeProfitPrice);
      const quantity = openTrade.quantity;
      const isLong = !openTrade.entryReason.includes('SHORT');

      const livePrice = currentPrice;
      const unrealizedPnL = isLong
        ? (livePrice - entryPrice) * quantity - Number(openTrade.entryFees)
        : (entryPrice - livePrice) * quantity - Number(openTrade.entryFees);
      const investedAmount = entryPrice * quantity;
      const unrealizedPnLPct = investedAmount > 0 ? (unrealizedPnL / investedAmount) * 100 : 0;

      const slDistance = Math.abs(livePrice - stopLossPrice);
      const slDistancePct = entryPrice > 0 ? (slDistance / entryPrice) * 100 : 0;
      const tpDistance = Math.abs(takeProfitPrice - livePrice);
      const tpDistancePct = entryPrice > 0 ? (tpDistance / entryPrice) * 100 : 0;

      const drawingLevels = [
        { type: 'ENTRY', price: entryPrice, label: `Entry: ${entryPrice.toFixed(2)}`, color: '#38bdf8' },
        { type: 'STOP_LOSS', price: stopLossPrice, label: `SL: ${stopLossPrice.toFixed(2)} (-${slDistancePct.toFixed(1)}%)`, color: '#f43f5e' },
        { type: 'TAKE_PROFIT', price: takeProfitPrice, label: `TP: ${takeProfitPrice.toFixed(2)} (+${tpDistancePct.toFixed(1)}%)`, color: '#10b981' },
        { type: 'CURRENT', price: livePrice, label: `Live: ${livePrice.toFixed(2)}`, color: '#a855f7' },
      ];

      return NextResponse.json({
        agent: {
          id: agent.id,
          key: agent.key,
          name: agent.name,
          description: agent.description,
          currency,
          initialCapital: Number(agent.initialCapital),
          cashBalance: Number(agent.cashBalance),
          realizedPnL: Number(agent.realizedPnL),
          dailyRealizedPnL: Number(agent.dailyRealizedPnL),
          entriesToday: agent.entriesToday,
          isPaused: agent.isPaused,
        },
        inTrade: true,
        tradeDetails: {
          id: openTrade.id,
          symbol: openTrade.symbol,
          side: isLong ? 'LONG' : 'SHORT',
          quantity,
          entryPrice,
          currentPrice: livePrice,
          stopLossPrice,
          takeProfitPrice,
          slDistance,
          slDistancePct,
          tpDistance,
          tpDistancePct,
          investedAmount,
          balanceLeft: Number(agent.cashBalance),
          unrealizedPnL,
          unrealizedPnLPct,
          riskReward: slDistance > 0 ? (tpDistance / slDistance).toFixed(2) : '2.00',
          entryReason: openTrade.entryReason,
          openedAt: openTrade.openedAt,
        },
        drawingLevels,
        candles,
        assetSymbol,
      });
    }

    // 3. Telemetry when NOT IN A TRADE (Checklist of Met vs Needed)
    const conditionReport = analyzeStrategyConditions(
      agent.key,
      agent.name,
      assetSymbol,
      candles
    );

    const drawingLevels = [
      { type: 'RESISTANCE', price: conditionReport.resistancePrice, label: `Resistance: ${conditionReport.resistancePrice.toFixed(2)}`, color: '#f43f5e' },
      { type: 'SUPPORT', price: conditionReport.supportPrice, label: `Support: ${conditionReport.supportPrice.toFixed(2)}`, color: '#10b981' },
      { type: 'CURRENT', price: currentPrice, label: `Price: ${currentPrice.toFixed(2)}`, color: '#38bdf8' },
    ];

    if (conditionReport.ema20) {
      drawingLevels.push({ type: 'EMA20', price: conditionReport.ema20, label: `EMA 20: ${conditionReport.ema20.toFixed(2)}`, color: '#f59e0b' });
    }

    return NextResponse.json({
      agent: {
        id: agent.id,
        key: agent.key,
        name: agent.name,
        description: agent.description,
        currency,
        initialCapital: Number(agent.initialCapital),
        cashBalance: Number(agent.cashBalance),
        realizedPnL: Number(agent.realizedPnL),
        dailyRealizedPnL: Number(agent.dailyRealizedPnL),
        entriesToday: agent.entriesToday,
        isPaused: agent.isPaused,
      },
      inTrade: false,
      conditionReport,
      drawingLevels,
      candles,
      assetSymbol,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to retrieve agent telemetry.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
