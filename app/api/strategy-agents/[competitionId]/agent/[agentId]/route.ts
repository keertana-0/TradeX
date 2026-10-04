import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { getSessionUser } from '@/lib/auth/session';
import { getCryptoMarketSnapshots } from '@/lib/market-data/crypto-provider';
import { getYahooMarketSnapshots } from '@/lib/strategy-agents/market-data';
import { analyzeStrategyConditions } from '@/lib/strategy-agents/telemetry';
import { calculatePaperUnrealizedPnl } from '@/lib/strategy-agents/crypto-paper-accounting';
import type { Candle, CandleInterval } from '@/types/market';

export const dynamic = 'force-dynamic';

function aggregateCandles(candles: Candle[], intervalSeconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const candle of candles) {
    const bucketTime = Math.floor(candle.time / intervalSeconds) * intervalSeconds;
    const bucket = buckets.get(bucketTime);
    if (bucket) {
      bucket.high = Math.max(bucket.high, candle.high);
      bucket.low = Math.min(bucket.low, candle.low);
      bucket.close = candle.close;
      bucket.volume += candle.volume;
    } else {
      buckets.set(bucketTime, { ...candle, time: bucketTime });
    }
  }
  return [...buckets.values()].sort((a, b) => a.time - b.time);
}

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
            trades: { orderBy: { openedAt: 'desc' } },
            signals: { take: 10, orderBy: { createdAt: 'desc' } },
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
    const openTrade = agent.trades.find((t) => t.status === 'OPEN') || null;

    const tradeHistory = agent.trades.map((t) => ({
      id: t.id,
      symbol: t.symbol,
      status: t.status,
      side: t.entryReason.includes('SHORT') ? 'SHORT' : 'LONG',
      quantity: t.quantity,
      entryPrice: Number(t.entryPrice),
      currentPrice: Number(t.currentPrice),
      exitPrice: t.exitPrice ? Number(t.exitPrice) : null,
      stopLossPrice: Number(t.stopLossPrice),
      takeProfitPrice: Number(t.takeProfitPrice),
      entryFees: Number(t.entryFees),
      exitFees: t.exitFees ? Number(t.exitFees) : null,
      realizedPnL: t.realizedPnL ? Number(t.realizedPnL) : null,
      entryReason: t.entryReason,
      exitReason: t.exitReason,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
    }));

    let candles: Candle[] = [];
    let analysisCandles: Candle[] = [];
    let candlesByInterval: Partial<Record<CandleInterval, Candle[]>> = {};
    let currentPrice = Number(openTrade?.currentPrice ?? competition.latestPrice ?? 0);
    let assetSymbol = openTrade?.symbol || (isCrypto ? 'BTC/USDT' : 'NIFTY50');
    let marketDataStale = isCrypto;
    let marketDataStatus = isCrypto ? 'Waiting for a verified live crypto quote.' : 'Market data status unavailable.';
    let orderFlow: Awaited<ReturnType<typeof getCryptoMarketSnapshots>>[number]['orderFlow'];
    let cryptoSnaps: Awaited<ReturnType<typeof getCryptoMarketSnapshots>> = [];
    let relatedSeries: Record<string, Array<{ time: number; close: number }>> = {};

    // 1. Fetch real-time candles
    if (isCrypto) {
      cryptoSnaps = await getCryptoMarketSnapshots();
      const tradeAsset = openTrade?.symbol?.split('/')[0] || 'BTC';
      const snap = cryptoSnaps.find((s) => s.symbol === tradeAsset) || (!openTrade ? cryptoSnaps[0] : undefined);
      if (snap) {
        analysisCandles = snap.candles;
        candles = snap.liveCandle ? [...snap.candles, snap.liveCandle] : snap.candles;
        candlesByInterval = {
          '5m': candles,
          '15m': snap.candles15m || [],
          '30m': aggregateCandles(snap.candles15m || [], 30 * 60),
          '1h': snap.candles1h || [],
          '1D': snap.candles1d || [],
          '1W': aggregateCandles(snap.candles1d || [], 7 * 24 * 60 * 60),
        };
        currentPrice = snap.price;
        assetSymbol = `${snap.symbol}/USDT`;
        marketDataStale = Boolean(snap.isStale);
        marketDataStatus = snap.source;
        orderFlow = snap.orderFlow;
        relatedSeries = Object.fromEntries(cryptoSnaps.filter((other) => other.symbol !== snap.symbol).map((other) => [other.symbol, other.candles.map(({ time, close }) => ({ time, close }))]));
      } else {
        marketDataStatus = `No ${tradeAsset}/USDT candles are available. Waiting for live data or a saved local history cache.`;
      }
    } else {
      const yahooSnaps = await getYahooMarketSnapshots().catch(() => []);
      const snap = yahooSnaps[0];
      if (snap) {
        candles = snap.candles;
        analysisCandles = snap.candles;
        candlesByInterval = { '5m': snap.candles };
        currentPrice = snap.price;
        assetSymbol = snap.symbol;
        marketDataStale = false;
        marketDataStatus = 'Yahoo Finance market feed';
      }
    }

    if (!analysisCandles.length) analysisCandles = candles;
    const conditionReport = {
      ...analyzeStrategyConditions(
      agent.key,
      agent.name,
      assetSymbol,
      analysisCandles,
      { orderFlow, relatedSeries, supportsPairedExecution: false, hasPosition: Boolean(openTrade), positionSide: openTrade?.entryReason.includes('SHORT') ? 'SHORT' : 'LONG', timeframeMinutes: 5 },
      currentPrice,
      ),
      dataStale: marketDataStale,
      dataSource: marketDataStatus,
    };
    const marketReports = isCrypto
      ? cryptoSnaps.map((market) => ({
          ...analyzeStrategyConditions(
          agent.key,
          agent.name,
          `${market.symbol}/USDT`,
          market.candles,
          {
            orderFlow: market.orderFlow,
            relatedSeries: Object.fromEntries(cryptoSnaps.filter((other) => other.symbol !== market.symbol).map((other) => [other.symbol, other.candles.map(({ time, close }) => ({ time, close }))])),
            supportsPairedExecution: false,
            hasPosition: openTrade?.symbol.split('/')[0] === market.symbol,
            positionSide: openTrade?.symbol.split('/')[0] === market.symbol && openTrade.entryReason.includes('SHORT') ? 'SHORT' : 'LONG',
            timeframeMinutes: 5,
          },
          market.price,
          ),
          dataStale: Boolean(market.isStale),
          dataSource: market.source,
        }))
      : [];
    const allMarketReports = marketReports.length ? marketReports : [conditionReport];

    // 2. Telemetry when IN A TRADE
    if (openTrade) {
      const entryPrice = Number(openTrade.entryPrice);
      const stopLossPrice = Number(openTrade.stopLossPrice);
      const takeProfitPrice = Number(openTrade.takeProfitPrice);
      const quantity = openTrade.quantity;
      const isLong = !openTrade.entryReason.includes('SHORT');

      const livePrice = currentPrice;
      const unrealizedPnL = calculatePaperUnrealizedPnl({
        side: isLong ? 'LONG' : 'SHORT', quantity, entryPrice, markPrice: livePrice,
        entryFee: Number(openTrade.entryFees),
        ...(isCrypto ? { estimatedExitFee: livePrice * quantity * 0.0005 } : {}),
      });
      const investedAmount = entryPrice * quantity;
      const unrealizedPnLPct = investedAmount > 0 ? (unrealizedPnL / investedAmount) * 100 : 0;

      // Risk/reward and threshold percentages describe the planned trade, so
      // measure both levels from the actual fill, not from the moving mark.
      const slDistance = Math.abs(entryPrice - stopLossPrice);
      const slDistancePct = entryPrice > 0 ? (slDistance / entryPrice) * 100 : 0;
      const tpDistance = Math.abs(takeProfitPrice - entryPrice);
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
        conditionReport,
        marketReports: allMarketReports,
        marketDataStale,
        marketDataStatus,
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
          riskReward: slDistance > 0 ? (tpDistance / slDistance).toFixed(2) : '—',
          entryReason: openTrade.entryReason,
          openedAt: openTrade.openedAt,
        },
        drawingLevels,
        candles,
        candlesByInterval,
        assetSymbol,
        tradeHistory,
      });
    }

    // 3. Telemetry when NOT IN A TRADE (Checklist of Met vs Needed)
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
      marketReports: allMarketReports,
      marketDataStale,
      marketDataStatus,
      drawingLevels,
      candles,
      candlesByInterval,
      assetSymbol,
      tradeHistory,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Failed to retrieve agent telemetry.';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
