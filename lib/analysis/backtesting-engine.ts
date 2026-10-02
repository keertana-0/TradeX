import { Candle } from '@/types/market';
import { BacktestConfig, BacktestResult, BacktestTrade, BacktestMetrics, RegimePerformance } from '@/types/backtest';
import { getNseIndexOptionLotSize } from '@/lib/market-data/nse-index-lot-size';
import { detectMarketRegime } from './regime-engine';
import { analyzeOptionsSignal } from '../options/options-signal-engine';
import { HistoricalOptionObservation } from '@/types/historical-options';
import { DailyHistoricalOptionObservation } from '@/types/daily-options';

export function runBacktestSimulation(
  candles: Candle[],
  config: BacktestConfig,
  historicalOptions: HistoricalOptionObservation[] = []
): BacktestResult {
  const signalCounts: Record<string, number> = {
    LONG_CALL: 0,
    LONG_PUT: 0,
    VOLATILITY_STRATEGY: 0,
    NO_TRADE: 0,
  };

  if (!candles || candles.length < 25) {
    return {
      status: 'INSUFFICIENT_DATA',
      message: `Historical series contains ${candles?.length || 0} bars. At least 25 bars are required for reliable indicator simulation.`,
      config,
      metrics: {
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        winRate: 0,
        totalPnl: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPct: 0,
        finalCapital: config.startingCapital,
        returnOnCapital: 0,
        averageTradePnl: 0,
      },
      trades: [],
      equityCurve: [{ date: new Date().toISOString(), equity: config.startingCapital }],
      regimePerformance: [],
      signalCounts,
    };
  }
  if (!historicalOptions.length) {
    return { status: 'INSUFFICIENT_DATA', message: 'Historical option data unavailable for the selected period.', config, metrics: { totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, totalPnl: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPct: 0, finalCapital: config.startingCapital, returnOnCapital: 0, averageTradePnl: 0 }, trades: [], equityCurve: [], regimePerformance: [], signalCounts };
  }

  let capital = config.startingCapital;
  let peakCapital = capital;
  let maxDrawdown = 0;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; equity: number }[] = [];
  const regimeStats: Record<string, { trades: number; wins: number; pnl: number }> = {
    BULLISH: { trades: 0, wins: 0, pnl: 0 },
    BEARISH: { trades: 0, wins: 0, pnl: 0 },
    SIDEWAYS: { trades: 0, wins: 0, pnl: 0 },
  };

  const getIsoDate = (bar: Candle) =>
    typeof bar.time === 'number' ? new Date(bar.time * 1000).toISOString() : new Date().toISOString();

  equityCurve.push({ date: getIsoDate(candles[20]), equity: capital });

  // Walk forward from bar 20 through end
  for (let i = 20; i < candles.length - 1; i++) {
    const windowCandles = candles.slice(0, i + 1);
    const currentBar = candles[i];
    const nextBar = candles[i + 1];
    const nextDate = getIsoDate(nextBar);

    const regime = detectMarketRegime(windowCandles);
    const spot = currentBar.close;
    const step = config.symbol.toUpperCase().includes('BANK') ? 100 : 50;
    const atmStrike = Math.round(spot / step) * step;

    const sessionRows = historicalOptions.filter((row) => row.timestamp.slice(0, 10) === getIsoDate(currentBar).slice(0, 10));
    if (!sessionRows.length) continue;
    const mockChain = {
      underlyingSymbol: config.symbol,
      underlyingPrice: spot,
      timestamp: nextDate,
      selectedExpiry: nextDate,
      expiryDates: [nextDate],
      highestVolumeStrikeCE: { strike: atmStrike, volume: 50000 },
      highestVolumeStrikePE: { strike: atmStrike, volume: 45000 },
      pcr: { volumePcr: 1.0, oiPcr: 1.0 },
      dataSource: 'Backtest Engine',
      isDelayed: false,
      strikes: Array.from(new Set(sessionRows.map((row) => row.strike))).map((strike) => {
        const row = sessionRows.filter((item) => item.strike === strike);
        const leg = (type: 'CE' | 'PE') => { const item = row.find((candidate) => candidate.optionType === type); return item ? { ltp: item.ltp, change: 0, volume: item.volume || 0, oi: item.oi || 0, changeOi: item.changeOi || 0, iv: item.iv, bid: item.bid, ask: item.ask } : null; };
        return { strikePrice: strike, ce: leg('CE'), pe: leg('PE') };
      }),
    };

    const signal = analyzeOptionsSignal(regime, mockChain, spot);
    signalCounts[signal.signal] = (signalCounts[signal.signal] || 0) + 1;

    // Check strategy entry condition
    let shouldTrade = false;
    let optType: 'CE' | 'PE' = 'CE';

    if (config.strategy === 'REGIME_MOMENTUM') {
      if (signal.signal === 'LONG_CALL') {
        shouldTrade = true;
        optType = 'CE';
      } else if (signal.signal === 'LONG_PUT') {
        shouldTrade = true;
        optType = 'PE';
      }
    } else if (config.strategy === 'LONG_CALL_BREAKOUT' && signal.signal === 'LONG_CALL') {
      shouldTrade = true;
      optType = 'CE';
    } else if (config.strategy === 'LONG_PUT_BREAKDOWN' && signal.signal === 'LONG_PUT') {
      shouldTrade = true;
      optType = 'PE';
    }

    if (shouldTrade) {
      const entryRow = sessionRows.find((row) => row.strike === signal.strike && row.optionType === optType);
      const nextDateRows = historicalOptions.filter((row) => row.timestamp.slice(0, 10) === getIsoDate(nextBar).slice(0, 10) && row.strike === signal.strike && row.optionType === optType && row.expiry === entryRow?.expiry);
      if (!entryRow || !nextDateRows.length) continue;
      const entryPrice = entryRow.ltp + config.slippagePerUnit;
      const nextSpot = nextBar.close;
      const exitPrice = Math.max(0.5, nextDateRows[0].ltp - config.slippagePerUnit);
      const units = config.lotSize;
      const grossPnl = (exitPrice - entryPrice) * units;
      const netPnl = Number((grossPnl - (config.costPerTrade * 2)).toFixed(2));
      const returnPct = Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2));

      capital += netPnl;
      if (capital > peakCapital) peakCapital = capital;
      const currentDrawdown = peakCapital - capital;
      if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

      const trade: BacktestTrade = {
        id: `BT-${trades.length + 1}`,
        date: getIsoDate(currentBar),
        symbol: config.symbol,
        action: 'BUY',
        strike: atmStrike,
        optionType: optType,
        entryPrice: Number(entryPrice.toFixed(2)),
        exitPrice: Number(exitPrice.toFixed(2)),
        pnl: netPnl,
        returnPct,
        regime: regime.regime,
        reason: signal.reasons[0] || `${regime.regime} signal triggered`,
      };

      trades.push(trade);

      if (regimeStats[regime.regime]) {
        regimeStats[regime.regime].trades += 1;
        if (netPnl > 0) regimeStats[regime.regime].wins += 1;
        regimeStats[regime.regime].pnl += netPnl;
      }
    }

    equityCurve.push({ date: nextDate, equity: Number(capital.toFixed(2)) });
  }

  const winningTrades = trades.filter((t) => t.pnl > 0).length;
  const losingTrades = trades.filter((t) => t.pnl <= 0).length;
  const totalPnl = Number((capital - config.startingCapital).toFixed(2));
  const winRate = trades.length > 0 ? Number(((winningTrades / trades.length) * 100).toFixed(1)) : 0;
  
  const grossProfit = trades.filter((t) => t.pnl > 0).reduce((acc, t) => acc + t.pnl, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnl < 0).reduce((acc, t) => acc + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit > 0 ? 99 : 0;

  const maxDrawdownPct = peakCapital > 0 ? Number(((maxDrawdown / peakCapital) * 100).toFixed(1)) : 0;
  const returnOnCapital = Number(((totalPnl / config.startingCapital) * 100).toFixed(2));
  const averageTradePnl = trades.length > 0 ? Number((totalPnl / trades.length).toFixed(2)) : 0;

  const metrics: BacktestMetrics = {
    totalTrades: trades.length,
    winningTrades,
    losingTrades,
    winRate,
    totalPnl,
    profitFactor,
    maxDrawdown: Number(maxDrawdown.toFixed(2)),
    maxDrawdownPct,
    finalCapital: Number(capital.toFixed(2)),
    returnOnCapital,
    averageTradePnl,
  };

  const regimePerformance: RegimePerformance[] = Object.entries(regimeStats)
    .filter(([_, stats]) => stats.trades > 0)
    .map(([regime, stats]) => ({
      regime,
      trades: stats.trades,
      winRate: Number(((stats.wins / stats.trades) * 100).toFixed(1)),
      pnl: Number(stats.pnl.toFixed(2)),
    }));

  return {
    status: 'SUCCESS',
    config,
    metrics,
    trades: trades.reverse(), // most recent first
    equityCurve,
    regimePerformance,
    signalCounts,
  };
}

/**
 * Intraday long strangle simulation: for each session, enter CE and PE at the
 * configured time on strikes surrounding spot and close both legs at exit time.
 * Every price is read from timestamped historical option observations.
 */
export function runIntradayBacktest(
  config: BacktestConfig,
  historicalOptions: HistoricalOptionObservation[]
): BacktestResult {
  const strikeCount = config.strikeCount ?? 2;
  const basePerSide = config.initialPerSideInvestment ?? 100_000;
  const entryTime = config.entryTime ?? '09:30';
  const exitTime = config.exitTime ?? '15:15';
  const initialCapital = basePerSide * 2 * strikeCount;
  const emptyMetrics: BacktestMetrics = {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
    totalPnl: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPct: 0,
    finalCapital: initialCapital, returnOnCapital: 0, averageTradePnl: 0,
  };
  const insufficient = (message: string): BacktestResult => ({
    status: 'INSUFFICIENT_DATA', message, config, metrics: emptyMetrics,
    trades: [], equityCurve: [], regimePerformance: [], signalCounts: {},
    dailyResults: [], strikeResults: [],
    reinvestment: { reinvestmentRate: 0.5, initialPerSideInvestment: basePerSide, finalPerSideInvestment: basePerSide, totalReinvested: 0 },
  });

  if (strikeCount < 2 || !Number.isInteger(strikeCount)) return insufficient('Choose at least two strikes so the backtest can enter above and below spot.');
  if (!/^\d{2}:\d{2}$/.test(entryTime) || !/^\d{2}:\d{2}$/.test(exitTime) || entryTime >= exitTime) {
    return insufficient('Enter valid session times, with exit time later than entry time.');
  }
  if (!historicalOptions.length) return insufficient('Upload timestamped CE/PE historical option prices for the selected index and dates.');

  const exchangeDate = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
  const targetInstant = (date: string, time: string) => Date.parse(`${date}T${time}:00+05:30`);
  const dates = [...new Set(historicalOptions.map((row) => exchangeDate(row.timestamp)))].sort();
  const trades: BacktestTrade[] = [];
  const dailyResults: NonNullable<BacktestResult['dailyResults']> = [];
  const strikeAcc = new Map<number, { sides: Set<'ABOVE' | 'BELOW'>; days: Set<string>; cePnl: number; pePnl: number; daily: Map<string, number> }>();
  const initialCapitalForMetrics = initialCapital;
  let capital = initialCapital;
  let peak = capital;
  let maxDrawdown = 0;
  let sideBudget = basePerSide;
  let totalReinvested = 0;
  const maxQuoteGapMs = 5 * 60_000;

  for (const date of dates) {
    const rows = historicalOptions.filter((row) => exchangeDate(row.timestamp) === date);
    const selectSnapshot = (time: string) => {
      const target = targetInstant(date, time);
      const groups = new Map<string, HistoricalOptionObservation[]>();
      for (const row of rows) {
        const rowTime = Date.parse(row.timestamp);
        const gap = target - rowTime;
        if (gap < 0 || gap > maxQuoteGapMs) continue;
        const list = groups.get(row.timestamp) || [];
        list.push(row);
        groups.set(row.timestamp, list);
      }
      const completePairs = (snapshot: HistoricalOptionObservation[]) => {
        const keys = new Set(snapshot.map((row) => `${row.expiry}|${row.strike}|${row.optionType}`));
        return [...keys].filter((key) => key.endsWith('|CE') && keys.has(`${key.slice(0, -2)}PE`)).length;
      };
      return [...groups.entries()]
        .map(([timestamp, snapshot]) => ({ timestamp, snapshot, pairs: completePairs(snapshot), gap: Math.abs(Date.parse(timestamp) - target) }))
        .filter((item) => item.pairs > 0)
        .sort((a, b) => a.gap - b.gap || b.pairs - a.pairs)[0]?.snapshot || [];
    };
    const entryRows = selectSnapshot(entryTime);
    const exitRows = selectSnapshot(exitTime);
    const emptyDay = { date, pnl: 0, cePnl: 0, pePnl: 0, strikesEntered: [] as number[], capital, reinvested: 0, investmentPerSideNextDay: sideBudget };
    if (!entryRows.length || !exitRows.length) {
      dailyResults.push(emptyDay);
      continue;
    }
    const entrySpot = entryRows.reduce((sum, row) => sum + row.underlyingPrice, 0) / entryRows.length;
    const strikeKeys = new Set(entryRows.filter((row) => row.optionType === 'CE').map((row) => `${row.expiry}|${row.strike}`));
    const exitKeys = new Set(exitRows.map((row) => `${row.expiry}|${row.strike}|${row.optionType}`));
    const candidates = [...strikeKeys].map((key) => {
      const [expiry, strikeText] = key.split('|');
      const strike = Number(strikeText);
      const ce = entryRows.find((row) => row.expiry === expiry && row.strike === strike && row.optionType === 'CE');
      const pe = entryRows.find((row) => row.expiry === expiry && row.strike === strike && row.optionType === 'PE');
      const exitCe = exitRows.find((row) => row.expiry === expiry && row.strike === strike && row.optionType === 'CE');
      const exitPe = exitRows.find((row) => row.expiry === expiry && row.strike === strike && row.optionType === 'PE');
      if (!ce || !pe || !exitCe || !exitPe || !exitKeys.has(`${expiry}|${strike}|CE`) || !exitKeys.has(`${expiry}|${strike}|PE`)) return null;
      if (ce.ltp <= 0 || pe.ltp <= 0 || exitCe.ltp < 0 || exitPe.ltp < 0) return null;
      const canBuy = (premium: number) => Math.floor(sideBudget / ((premium + config.slippagePerUnit) * config.lotSize)) > 0;
      if (!canBuy(ce.ltp) || !canBuy(pe.ltp)) return null;
      const side: 'ABOVE' | 'BELOW' | null = strike > entrySpot ? 'ABOVE' : strike < entrySpot ? 'BELOW' : null;
      return side ? { strike, side, expiry, ce, pe, exitCe, exitPe, distance: Math.abs(strike - entrySpot) } : null;
    }).filter((row): row is NonNullable<typeof row> => row !== null);
    const nearestExpiryByStrike = new Map<number, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const current = nearestExpiryByStrike.get(candidate.strike);
      const candidateExpiry = Date.parse(candidate.expiry);
      const currentExpiry = current ? Date.parse(current.expiry) : Infinity;
      const nearer = Number.isFinite(candidateExpiry) && Number.isFinite(currentExpiry)
        ? candidateExpiry < currentExpiry
        : !current || candidate.expiry < current.expiry;
      if (!current || nearer) nearestExpiryByStrike.set(candidate.strike, candidate);
    }
    const uniqueCandidates = [...nearestExpiryByStrike.values()];
    const above = uniqueCandidates.filter((row) => row.side === 'ABOVE').sort((a, b) => a.distance - b.distance);
    const below = uniqueCandidates.filter((row) => row.side === 'BELOW').sort((a, b) => a.distance - b.distance);
    const aboveCount = Math.ceil(strikeCount / 2);
    const belowCount = Math.floor(strikeCount / 2);
    const selected = [...above.slice(0, aboveCount), ...below.slice(0, belowCount)];
    if (selected.length !== strikeCount) {
      dailyResults.push(emptyDay);
      continue;
    }

    let dayPnl = 0;
    let dayCePnl = 0;
    let dayPePnl = 0;
    for (const option of selected) {
      const legRows = [
        { type: 'CE' as const, entry: option.ce.ltp, exit: option.exitCe.ltp },
        { type: 'PE' as const, entry: option.pe.ltp, exit: option.exitPe.ltp },
      ];
      let strikePnl = 0;
      let strikeCePnl = 0;
      let strikePePnl = 0;
      for (const leg of legRows) {
        const adjustedEntry = leg.entry + config.slippagePerUnit;
        const adjustedExit = Math.max(0.01, leg.exit - config.slippagePerUnit);
        const lotValue = adjustedEntry * config.lotSize;
        const quantity = lotValue > 0 ? Math.floor(sideBudget / lotValue) * config.lotSize : 0;
        if (!quantity) continue;
        const pnl = Number(((adjustedExit - adjustedEntry) * quantity - 2 * config.costPerTrade).toFixed(2));
        const trade: BacktestTrade = {
          id: `BT-${trades.length + 1}`, date: `${date}T${exitTime}:00+05:30`, symbol: config.symbol,
          action: 'BUY', strike: option.strike, optionType: leg.type,
          entryPrice: Number(adjustedEntry.toFixed(2)), exitPrice: Number(adjustedExit.toFixed(2)),
          pnl, returnPct: Number((pnl / (adjustedEntry * quantity) * 100).toFixed(2)),
          regime: 'INTRADAY_STRANGLE', reason: `${option.side} spot strike; ${entryTime} entry / ${exitTime} exit`,
        };
        trades.push(trade);
        strikePnl += pnl;
        dayPnl += pnl;
        if (leg.type === 'CE') { dayCePnl += pnl; strikeCePnl += pnl; }
        else { dayPePnl += pnl; strikePePnl += pnl; }
      }
      const acc = strikeAcc.get(option.strike) || { sides: new Set<'ABOVE' | 'BELOW'>(), days: new Set<string>(), cePnl: 0, pePnl: 0, daily: new Map<string, number>() };
      acc.sides.add(option.side);
      acc.days.add(date);
      acc.cePnl += strikeCePnl;
      acc.pePnl += strikePePnl;
      acc.daily.set(date, (acc.daily.get(date) || 0) + strikePnl);
      strikeAcc.set(option.strike, acc);
    }
    capital = Number((capital + dayPnl).toFixed(2));
    peak = Math.max(peak, capital);
    maxDrawdown = Math.max(maxDrawdown, peak - capital);
    const reinvested = dayPnl > 0 ? Number((dayPnl * 0.5).toFixed(2)) : 0;
    totalReinvested += reinvested;
    const nextDaySideBudget = sideBudget + reinvested / strikeCount / 2;
    dailyResults.push({ date, pnl: Number(dayPnl.toFixed(2)), cePnl: Number(dayCePnl.toFixed(2)), pePnl: Number(dayPePnl.toFixed(2)), strikesEntered: selected.map((row) => row.strike).sort((a, b) => a - b), capital, reinvested, investmentPerSideNextDay: Number(nextDaySideBudget.toFixed(2)) });
    sideBudget = nextDaySideBudget;
  }

  if (!trades.length) return insufficient('No complete CE/PE strike pairs were available at both selected times. Upload intraday data with both sides for strikes above and below spot (within 5 minutes of each time).');
  const winners = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const totalPnl = Number((capital - initialCapitalForMetrics).toFixed(2));
  const metrics: BacktestMetrics = {
    totalTrades: trades.length, winningTrades: winners, losingTrades: trades.length - winners,
    winRate: Number((winners / trades.length * 100).toFixed(1)), totalPnl,
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit ? 99 : 0,
    maxDrawdown: Number(maxDrawdown.toFixed(2)), maxDrawdownPct: peak ? Number((maxDrawdown / peak * 100).toFixed(1)) : 0,
    finalCapital: capital, returnOnCapital: Number((totalPnl / initialCapitalForMetrics * 100).toFixed(2)),
    averageTradePnl: Number((totalPnl / trades.length).toFixed(2)),
  };
  const strikeResults = [...strikeAcc.entries()].sort((a, b) => a[0] - b[0]).map(([strike, acc]) => ({
    strike, side: (acc.sides.has('ABOVE') && acc.sides.has('BELOW') ? 'BOTH' : acc.sides.has('ABOVE') ? 'ABOVE' : 'BELOW') as 'ABOVE' | 'BELOW' | 'BOTH', days: acc.days.size,
    cePnl: Number(acc.cePnl.toFixed(2)), pePnl: Number(acc.pePnl.toFixed(2)),
    totalPnl: Number((acc.cePnl + acc.pePnl).toFixed(2)),
    dailyPnl: dates.map((date) => ({ date, pnl: Number((acc.daily.get(date) || 0).toFixed(2)) })),
  }));
  return {
    status: 'SUCCESS', config, metrics, trades: trades.reverse(),
    equityCurve: dailyResults.map((row) => ({ date: row.date, equity: row.capital })),
    regimePerformance: [], signalCounts: {}, dailyResults, strikeResults,
    reinvestment: { reinvestmentRate: 0.5, initialPerSideInvestment: basePerSide, finalPerSideInvestment: Number(sideBudget.toFixed(2)), totalReinvested: Number(totalReinvested.toFixed(2)) },
  };
}

/**
 * Daily OHLC options simulation. Strike and expiry selection uses only the
 * prior session's close. Entries use the next session's recorded open and
 * exits use that session's recorded close; daily bars are never presented as
 * intraday quotes.
 */
export async function runDailyOptionsBacktest(
  config: BacktestConfig,
  historicalOptions: DailyHistoricalOptionObservation[],
  onProgress?: (update: { date: string; equity: number; pnl: number; completed: number; total: number }) => void | Promise<void>,
): Promise<BacktestResult> {
  const strikeCount = config.strikeCount ?? 2;
  const perSideInitial = config.initialPerSideInvestment ?? 100_000;
  const initialCapital = perSideInitial * strikeCount * 2;
  const emptyMetrics: BacktestMetrics = {
    totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
    totalPnl: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPct: 0,
    finalCapital: initialCapital, returnOnCapital: 0, averageTradePnl: 0,
  };
  const insufficient = (message: string): BacktestResult => ({
    status: 'INSUFFICIENT_DATA', message, config, metrics: emptyMetrics,
    trades: [], equityCurve: [], regimePerformance: [], signalCounts: {},
    dailyResults: [], strikeResults: [],
    reinvestment: { reinvestmentRate: 0.5, initialPerSideInvestment: perSideInitial, finalPerSideInvestment: perSideInitial, totalReinvested: 0 },
  });

  if (!Number.isInteger(strikeCount) || strikeCount < 2 || strikeCount > 40) return insufficient('Choose between 2 and 40 strikes for a daily options backtest.');
  if (!Number.isFinite(config.lotSize) || config.lotSize <= 0 || !Number.isFinite(config.slippagePerUnit) || config.slippagePerUnit < 0 || !Number.isFinite(config.costPerTrade) || config.costPerTrade < 0 || !Number.isFinite(perSideInitial) || perSideInitial <= 0) {
    return insufficient('Lot size and investment must be positive; costs and slippage cannot be negative.');
  }
  if (!historicalOptions.length) return insufficient('Jugaad returned no daily historical option observations for the selected symbol and dates.');
  const observations = historicalOptions.filter((row) =>
    /^\d{4}-\d{2}-\d{2}$/.test(row.date) && row.underlyingPrice > 0 && row.strike > 0 && row.close > 0 &&
    ['CE', 'PE'].includes(row.optionType) && /^\d{4}-\d{2}-\d{2}$/.test(row.expiry)
  ).slice().sort((a, b) => a.date.localeCompare(b.date) || a.expiry.localeCompare(b.expiry) || a.strike - b.strike || a.optionType.localeCompare(b.optionType));
  if (!observations.length) return insufficient('Jugaad data did not contain valid daily option prices for this request.');

  const dates = [...new Set(observations.map((row) => row.date))];
  if (dates.length < 2) return insufficient('At least two historical option sessions are required to price a next-session open-to-close trade.');
  const byDate = new Map<string, DailyHistoricalOptionObservation[]>();
  for (const row of observations) byDate.set(row.date, [...(byDate.get(row.date) || []), row]);
  const trades: BacktestTrade[] = [];
  const tradingDays = new Set(config.tradingDays?.length ? config.tradingDays : [1, 2, 3, 4, 5]);
  const tradeDates = dates.slice(1).filter((date) =>
    tradingDays.has(new Date(`${date}T00:00:00Z`).getUTCDay()) &&
    (!config.backtestFrom || date >= config.backtestFrom) &&
    (!config.backtestTo || date <= config.backtestTo)
  );
  if (!tradeDates.length) return insufficient('No complete exchange daily option prices are available for a selected entry day in the requested range. Today’s trade can only be backtested after the exchange publishes its final end-of-day report.');
  const dailyResults: NonNullable<BacktestResult['dailyResults']> = [];
  const strikeAcc = new Map<number, { side: 'ABOVE' | 'BELOW'; days: Set<string>; cePnl: number; pePnl: number; daily: Map<string, number> }>();
  let capital = initialCapital;
  let peak = capital;
  let maxDrawdown = 0;
  let sideBudget = perSideInitial;
  let totalReinvested = 0;

  for (let i = 0; i < tradeDates.length; i += 1) {
    const tradeDate = tradeDates[i];
    const signalDate = dates[dates.indexOf(tradeDate) - 1];
    const dailySideBudget = Math.min(sideBudget, Math.max(0, capital) / (strikeCount * 2));
    const entryRows = byDate.get(signalDate) || [];
    const exitRows = byDate.get(tradeDate) || [];
    const spot = entryRows[0]?.underlyingPrice;
    const emptyDay = { date: tradeDate, note: '', pnl: 0, cePnl: 0, pePnl: 0, strikesEntered: [] as number[], capital, reinvested: 0, investmentPerSideNextDay: dailySideBudget };
    const publishProgress = async (equity: number, pnl: number) => { await onProgress?.({ date: tradeDate, equity, pnl, completed: i + 1, total: tradeDates.length }); };
    if (!spot || !exitRows.length) {
      emptyDay.note = !spot ? 'Prior-session underlying close is missing.' : 'No option bars were returned for this session.';
      dailyResults.push(emptyDay); await publishProgress(capital, 0); continue;
    }

    const contractMap = new Map<string, Map<'CE' | 'PE', DailyHistoricalOptionObservation>>();
    for (const row of entryRows) {
      if (row.expiry < signalDate) continue;
      const key = `${row.expiry}|${row.strike}`;
      const sides = contractMap.get(key) || new Map<'CE' | 'PE', DailyHistoricalOptionObservation>();
      sides.set(row.optionType, row);
      contractMap.set(key, sides);
    }
    const nextContractMap = new Map<string, Map<'CE' | 'PE', DailyHistoricalOptionObservation>>();
    for (const row of exitRows) {
      const key = `${row.expiry}|${row.strike}`;
      const sides = nextContractMap.get(key) || new Map<'CE' | 'PE', DailyHistoricalOptionObservation>();
      sides.set(row.optionType, row);
      nextContractMap.set(key, sides);
    }

    const nearestByStrike = new Map<number, { strike: number; expiry: string; lotSize: number; side: 'ABOVE' | 'BELOW'; ceOpen: number; peOpen: number; ceLow: number; peLow: number; ceClose: number; peClose: number; distance: number }>();
    for (const [key, sides] of contractMap) {
      const [expiry, strikeText] = key.split('|');
      const strike = Number(strikeText);
      const ce = sides.get('CE'); const pe = sides.get('PE');
      const nextSides = nextContractMap.get(key);
      const nextCe = nextSides?.get('CE'); const nextPe = nextSides?.get('PE');
      if (!ce || !pe || !nextCe || !nextPe || !Number.isFinite(nextCe.open) || !Number.isFinite(nextPe.open) || !nextCe.open || !nextPe.open || nextCe.close <= 0 || nextPe.close <= 0) continue;
      const lotSize = getNseIndexOptionLotSize(config.symbol, expiry);
      const canAfford = (price: number) => Math.floor(dailySideBudget / ((price + config.slippagePerUnit) * lotSize)) > 0;
      if (!canAfford(nextCe.open) || !canAfford(nextPe.open)) continue;
      const side: 'ABOVE' | 'BELOW' | null = strike > spot ? 'ABOVE' : strike < spot ? 'BELOW' : null;
      if (!side) continue;
      if (![nextCe.low, nextPe.low].every((price) => Number.isFinite(price) && Number(price) > 0)) continue;
      const candidate = { strike, expiry, lotSize, side, ceOpen: nextCe.open, peOpen: nextPe.open, ceLow: nextCe.low!, peLow: nextPe.low!, ceClose: nextCe.close, peClose: nextPe.close, distance: Math.abs(strike - spot) };
      const existing = nearestByStrike.get(strike);
      if (!existing || candidate.expiry < existing.expiry) nearestByStrike.set(strike, candidate);
    }
    const candidates = [...nearestByStrike.values()];
    const above = candidates.filter((row) => row.side === 'ABOVE').sort((a, b) => a.distance - b.distance || a.strike - b.strike);
    const below = candidates.filter((row) => row.side === 'BELOW').sort((a, b) => a.distance - b.distance || b.strike - a.strike);
    const aboveCount = Math.ceil(strikeCount / 2);
    const selected = [...above.slice(0, aboveCount), ...below.slice(0, Math.floor(strikeCount / 2))];
    if (selected.length !== strikeCount) {
      emptyDay.note = `Only ${selected.length} of ${strikeCount} requested strikes had complete, affordable CE/PE bars for both signal and entry sessions.`;
      dailyResults.push(emptyDay); await publishProgress(capital, 0); continue;
    }

    let dayPnl = 0; let cePnl = 0; let pePnl = 0;
    for (const option of selected) {
      let strikePnl = 0; let strikeCePnl = 0; let strikePePnl = 0;
      const legs = [
        { type: 'CE' as const, entry: option.ceOpen, open: option.ceOpen, low: option.ceLow, close: option.ceClose },
        { type: 'PE' as const, entry: option.peOpen, open: option.peOpen, low: option.peLow, close: option.peClose },
      ].map((leg) => {
        const adjustedEntry = leg.entry + config.slippagePerUnit;
        const lots = Math.floor(dailySideBudget / (adjustedEntry * option.lotSize));
        const quantity = lots * option.lotSize;
        return { ...leg, adjustedEntry, lots, quantity, stopPrice: adjustedEntry * 0.5, stopHit: leg.low <= adjustedEntry * 0.5 };
      }).filter((leg) => leg.quantity > 0);
      const anyStopHit = legs.some((leg) => leg.stopHit);
      const combinedInvestment = legs.reduce((sum, leg) => sum + leg.adjustedEntry * leg.quantity, 0);
      const combinedCloseValue = legs.reduce((sum, leg) => sum + Math.max(0.01, leg.close - config.slippagePerUnit) * leg.quantity, 0);
      // Expert Picks exits a complete CE/PE group when its combined value exceeds
      // twice its investment. If a leg stop fires, that stop has priority.
      const combinedProfitTargetHit = legs.length === 2 && !anyStopHit && combinedCloseValue > combinedInvestment * 2;
      for (const leg of legs) {
        let rawExit = leg.close;
        let exitRule = '3:45 PM time exit (daily close proxy)';
        if (leg.stopHit) {
          rawExit = leg.open <= leg.stopPrice ? leg.open : leg.stopPrice;
          exitRule = '50% per-leg loss stop (daily low; gap-aware fill proxy)';
        } else if (combinedProfitTargetHit) {
          exitRule = 'combined CE + PE profit target';
        }
        const adjustedExit = Math.max(0.01, rawExit - config.slippagePerUnit);
        const investedAmount = leg.adjustedEntry * leg.quantity;
        const grossPnl = (adjustedExit - leg.adjustedEntry) * leg.quantity;
        const charges = 2 * config.costPerTrade;
        const pnl = Number((grossPnl - charges).toFixed(2));
        trades.push({ id: `BT-${trades.length + 1}`, date: tradeDate, symbol: config.symbol, action: 'BUY', strike: option.strike, optionType: leg.type, entryPrice: Number(leg.adjustedEntry.toFixed(2)), exitPrice: Number(adjustedExit.toFixed(2)), allocatedBudget: Number(dailySideBudget.toFixed(2)), investedAmount: Number(investedAmount.toFixed(2)), grossPnl: Number(grossPnl.toFixed(2)), charges: Number(charges.toFixed(2)), pnl, returnPct: Number((pnl / investedAmount * 100).toFixed(2)), regime: 'DAILY_STRANGLE', reason: `Selected from ${signalDate} close; entered at ${tradeDate} open; ${exitRule}`, lotSize: option.lotSize, lots: leg.lots, quantity: leg.quantity });
        strikePnl += pnl; dayPnl += pnl;
        if (leg.type === 'CE') { strikeCePnl += pnl; cePnl += pnl; } else { strikePePnl += pnl; pePnl += pnl; }
      }
      const acc = strikeAcc.get(option.strike) || { side: option.side, days: new Set<string>(), cePnl: 0, pePnl: 0, daily: new Map<string, number>() };
      acc.days.add(tradeDate); acc.cePnl += strikeCePnl; acc.pePnl += strikePePnl;
      acc.daily.set(tradeDate, (acc.daily.get(tradeDate) || 0) + strikePnl);
      strikeAcc.set(option.strike, acc);
    }
    capital = Number((capital + dayPnl).toFixed(2));
    peak = Math.max(peak, capital); maxDrawdown = Math.max(maxDrawdown, peak - capital);
    const reinvested = dayPnl > 0 ? Number((dayPnl * 0.5).toFixed(2)) : 0;
    totalReinvested += reinvested;
    sideBudget += reinvested / strikeCount / 2;
    const nextDayBudgetPerLeg = Math.min(sideBudget, Math.max(0, capital) / (strikeCount * 2));
    dailyResults.push({ date: tradeDate, pnl: Number(dayPnl.toFixed(2)), cePnl: Number(cePnl.toFixed(2)), pePnl: Number(pePnl.toFixed(2)), strikesEntered: selected.map((row) => row.strike).sort((a, b) => a - b), capital, reinvested, investmentPerSideNextDay: Number(nextDayBudgetPerLeg.toFixed(2)) });
    await publishProgress(capital, Number(dayPnl.toFixed(2)));
  }

  if (!trades.length) return insufficient('No complete daily CE/PE contracts were available on consecutive sessions for strikes above and below spot.');
  const winners = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const totalPnl = Number((capital - initialCapital).toFixed(2));
  const metrics: BacktestMetrics = {
    totalTrades: trades.length, winningTrades: winners, losingTrades: trades.length - winners,
    winRate: Number((winners / trades.length * 100).toFixed(1)), totalPnl,
    profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit ? 99 : 0,
    maxDrawdown: Number(maxDrawdown.toFixed(2)), maxDrawdownPct: peak ? Number((maxDrawdown / peak * 100).toFixed(1)) : 0,
    finalCapital: capital, returnOnCapital: Number((totalPnl / initialCapital * 100).toFixed(2)), averageTradePnl: Number((totalPnl / trades.length).toFixed(2)),
  };
  const strikeResults = [...strikeAcc.entries()].sort((a, b) => a[0] - b[0]).map(([strike, acc]) => ({
    strike, side: acc.side, days: acc.days.size, cePnl: Number(acc.cePnl.toFixed(2)), pePnl: Number(acc.pePnl.toFixed(2)),
    totalPnl: Number((acc.cePnl + acc.pePnl).toFixed(2)),
    dailyPnl: dailyResults.map((row) => ({ date: row.date, pnl: Number((acc.daily.get(row.date) || 0).toFixed(2)) })),
  }));
  return {
    status: 'SUCCESS', message: 'Daily backtest applies Expert Picks exits: a 50% stop on each option leg, a combined CE/PE profit target, and a 3:45 PM time exit. Daily OHLC only approximates intraday execution: stops use the session low with a gap-aware fill proxy, while target and time exits use the session close.',
    config, metrics, trades: trades.reverse(), equityCurve: dailyResults.map((row) => ({ date: row.date, equity: row.capital })),
    regimePerformance: [], signalCounts: {}, dailyResults, strikeResults,
    reinvestment: { reinvestmentRate: 0.5, initialPerSideInvestment: perSideInitial, finalPerSideInvestment: Number(sideBudget.toFixed(2)), totalReinvested: Number(totalReinvested.toFixed(2)) },
  };
}
