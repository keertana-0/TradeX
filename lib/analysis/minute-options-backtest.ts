import { getNseIndexOptionLotSize } from '@/lib/market-data/nse-index-lot-size';
import { DailyHistoricalOptionObservation } from '@/types/daily-options';
import { BacktestConfig, BacktestDailyResult, BacktestMetrics, BacktestResult, BacktestStrikeResult, BacktestTrade } from '@/types/backtest';
import { UpstoxMinuteCandle, UpstoxMinuteContractRequest, UpstoxMinuteOptionSeries } from '@/lib/market-data/upstox-minute-options-provider';

export interface MinuteBacktestPlan {
  date: string;
  signalDate: string;
  spot: number;
  options: { strike: number; expiry: string; side: 'ABOVE' | 'BELOW'; lotSize: number }[];
}

function selectedDailyPlans(config: BacktestConfig, rows: DailyHistoricalOptionObservation[]): MinuteBacktestPlan[] {
  const dates = [...new Set(rows.map((row) => row.date))].sort();
  const byDate = new Map(dates.map((date) => [date, rows.filter((row) => row.date === date)]));
  const days = new Set(config.tradingDays?.length ? config.tradingDays : [1, 2, 3, 4, 5]);
  const requested = dates.slice(1).filter((date) => days.has(new Date(`${date}T00:00:00Z`).getUTCDay()) &&
    (!config.backtestFrom || date >= config.backtestFrom) && (!config.backtestTo || date <= config.backtestTo));
  const plans: MinuteBacktestPlan[] = [];
  for (const date of requested) {
    const signalDate = dates[dates.indexOf(date) - 1];
    const signal = byDate.get(signalDate) || [];
    const session = byDate.get(date) || [];
    const spot = signal[0]?.underlyingPrice;
    if (!spot) continue;
    const contracts = new Map<string, Map<'CE' | 'PE', DailyHistoricalOptionObservation>>();
    for (const row of signal) {
      if (row.expiry < signalDate) continue;
      const key = `${row.expiry}|${row.strike}`;
      const sides = contracts.get(key) || new Map<'CE' | 'PE', DailyHistoricalOptionObservation>();
      sides.set(row.optionType, row); contracts.set(key, sides);
    }
    const candidates = new Map<number, { strike: number; expiry: string; side: 'ABOVE' | 'BELOW'; distance: number }>();
    for (const [key, sides] of contracts) {
      const [expiry, strikeText] = key.split('|');
      const strike = Number(strikeText);
      const ce = sides.get('CE'); const pe = sides.get('PE');
      const nextCe = session.find((row) => row.expiry === expiry && row.strike === strike && row.optionType === 'CE');
      const nextPe = session.find((row) => row.expiry === expiry && row.strike === strike && row.optionType === 'PE');
      if (!ce || !pe || !nextCe || !nextPe || !Number.isFinite(nextCe.open) || !Number.isFinite(nextPe.open) || !nextCe.open || !nextPe.open) continue;
      const side: 'ABOVE' | 'BELOW' | null = strike > spot ? 'ABOVE' : strike < spot ? 'BELOW' : null;
      if (!side) continue;
      const candidate = { strike, expiry, side, distance: Math.abs(strike - spot) };
      const prior = candidates.get(strike);
      if (!prior || expiry < prior.expiry) candidates.set(strike, candidate);
    }
    const values = [...candidates.values()];
    const above = values.filter((item) => item.side === 'ABOVE').sort((a, b) => a.distance - b.distance || a.strike - b.strike);
    const below = values.filter((item) => item.side === 'BELOW').sort((a, b) => a.distance - b.distance || b.strike - a.strike);
    const count = config.strikeCount ?? 2;
    const selected = [...above.slice(0, Math.ceil(count / 2)), ...below.slice(0, Math.floor(count / 2))];
    if (selected.length === count) plans.push({ date, signalDate, spot, options: selected.map(({ strike, expiry, side }) => ({ strike, expiry, side, lotSize: getNseIndexOptionLotSize(config.symbol, expiry) })) });
  }
  return plans;
}

export function getMinuteBacktestContractRequests(config: BacktestConfig, rows: DailyHistoricalOptionObservation[]): UpstoxMinuteContractRequest[] {
  const plans = selectedDailyPlans(config, rows);
  const from = plans[0]?.date; const to = plans.at(-1)?.date;
  if (!from || !to) return [];
  const requests = new Map<string, UpstoxMinuteContractRequest>();
  for (const plan of plans) for (const option of plan.options) for (const optionType of ['CE', 'PE'] as const) {
    const key = `${option.expiry}|${option.strike}|${optionType}`;
    const prior = requests.get(key);
    requests.set(key, { expiry: option.expiry, strike: option.strike, optionType, from: prior && prior.from < plan.date ? prior.from : plan.date, to: prior && prior.to > plan.date ? prior.to : plan.date });
  }
  // Keep the provider request per contract to only the sessions that actually need it.
  return [...requests.values()];
}

interface ActiveLeg {
  strike: number; optionType: 'CE' | 'PE'; expiry: string; lotSize: number; lots: number; quantity: number;
  candles: UpstoxMinuteCandle[]; entryPrice: number; entryTimestamp: string; lastPrice: number; lastTimestamp: string; status: 'OPEN' | 'CLOSED';
}

const istDate = (timestamp: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(timestamp));
const istTime = (timestamp: string) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Calcutta', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(timestamp));

export async function runMinuteOptionsBacktest(
  config: BacktestConfig,
  dailyRows: DailyHistoricalOptionObservation[],
  series: UpstoxMinuteOptionSeries[],
  combinedProfitTarget = 210_000,
  onProgress?: (update: { date: string; equity: number; pnl: number; completed: number; total: number }) => void | Promise<void>,
): Promise<BacktestResult> {
  const perLegBudget = config.initialPerSideInvestment ?? 100_000;
  const count = config.strikeCount ?? 4;
  const initialCapital = perLegBudget * count * 2;
  const metricsEmpty: BacktestMetrics = { totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0, totalPnl: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPct: 0, finalCapital: initialCapital, returnOnCapital: 0, averageTradePnl: 0 };
  const insufficient = (message: string): BacktestResult => ({ status: 'INSUFFICIENT_DATA', message, config, metrics: metricsEmpty, trades: [], equityCurve: [], regimePerformance: [], signalCounts: {}, dailyResults: [], strikeResults: [], reinvestment: { reinvestmentRate: 0.5, initialPerSideInvestment: perLegBudget, finalPerSideInvestment: perLegBudget, totalReinvested: 0 } });
  if (!(combinedProfitTarget > 0) || !Number.isFinite(combinedProfitTarget)) return insufficient('Combined portfolio profit target must be greater than zero.');
  const plans = selectedDailyPlans(config, dailyRows);
  if (!plans.length) return insufficient('No complete daily CE/PE contract selections were available to request minute candles.');
  const byContract = new Map(series.map((item) => [`${item.expiry}|${item.strike}|${item.optionType}`, item]));
  const trades: BacktestTrade[] = [];
  const dailyResults: BacktestDailyResult[] = [];
  const strikeStats = new Map<number, { side: 'ABOVE' | 'BELOW'; days: Set<string>; ce: number; pe: number; daily: Map<string, number> }>();
  let capital = initialCapital; let peak = capital; let maxDrawdown = 0; let sideBudget = perLegBudget; let totalReinvested = 0;

  for (let planIndex = 0; planIndex < plans.length; planIndex += 1) {
    const plan = plans[planIndex];
    const dayBudget = Math.min(sideBudget, Math.max(0, capital) / (count * 2));
    const legs = plan.options.flatMap((option) => (['CE', 'PE'] as const).map((optionType) => {
      const source = byContract.get(`${option.expiry}|${option.strike}|${optionType}`);
      const candles = source?.candles.filter((candle) => istDate(candle.timestamp) === plan.date) || [];
      return { ...option, optionType, candles };
    }));
    const candleMaps = legs.map((leg) => new Map(leg.candles.map((candle) => [candle.timestamp, candle])));
    const commonEntryTimes = [...(candleMaps[0]?.keys() || [])].filter((time) => istTime(time) >= '09:15' && istTime(time) <= '09:20' && candleMaps.every((map) => map.has(time))).sort();
    const entryTimestamp = commonEntryTimes[0];
    if (!entryTimestamp) {
      dailyResults.push({ date: plan.date, note: 'No complete synchronized 1-minute CE/PE entry bars between 09:15 and 09:20.', pnl: 0, cePnl: 0, pePnl: 0, strikesEntered: [], capital, reinvested: 0, investmentPerSideNextDay: dayBudget });
      await onProgress?.({ date: plan.date, equity: capital, pnl: 0, completed: planIndex + 1, total: plans.length });
      continue;
    }
    const active: ActiveLeg[] = [];
    for (let i = 0; i < legs.length; i += 1) {
      const leg = legs[i]; const candle = candleMaps[i].get(entryTimestamp)!;
      const entryPrice = candle.open + config.slippagePerUnit;
      const lots = Math.floor(dayBudget / (entryPrice * leg.lotSize));
      if (lots <= 0) continue;
      active.push({ strike: leg.strike, optionType: leg.optionType, expiry: leg.expiry, lotSize: leg.lotSize, lots, quantity: lots * leg.lotSize, candles: leg.candles, entryPrice, entryTimestamp, lastPrice: candle.close, lastTimestamp: entryTimestamp, status: 'OPEN' });
    }
    const completePairs = plan.options.filter((option) => active.some((leg) => leg.strike === option.strike && leg.optionType === 'CE') && active.some((leg) => leg.strike === option.strike && leg.optionType === 'PE'));
    const tradable = active.filter((leg) => completePairs.some((option) => option.strike === leg.strike));
    if (!tradable.length || completePairs.length !== count) {
      dailyResults.push({ date: plan.date, note: `Only ${completePairs.length} of ${count} selected strikes could be entered in whole lots at the minute open.`, pnl: 0, cePnl: 0, pePnl: 0, strikesEntered: [], capital, reinvested: 0, investmentPerSideNextDay: dayBudget });
      await onProgress?.({ date: plan.date, equity: capital, pnl: 0, completed: planIndex + 1, total: plans.length });
      continue;
    }
    const entries = new Map(tradable.map((leg) => [`${leg.strike}|${leg.optionType}`, leg]));
    let realized = 0; let dayPnl = 0; let cePnl = 0; let pePnl = 0; let targetHit = false; let finalTimestamp = entryTimestamp;
    const recordExit = (leg: ActiveLeg, price: number, timestamp: string, exitRule: string) => {
      const exitPrice = Math.max(0.01, price - config.slippagePerUnit);
      const investedAmount = leg.entryPrice * leg.quantity;
      const grossPnl = (exitPrice - leg.entryPrice) * leg.quantity;
      const charges = 2 * config.costPerTrade;
      const pnl = Number((grossPnl - charges).toFixed(2));
      realized += pnl; dayPnl += pnl;
      if (leg.optionType === 'CE') cePnl += pnl; else pePnl += pnl;
      leg.status = 'CLOSED';
      trades.push({ id: `BT-${trades.length + 1}`, date: plan.date, symbol: config.symbol, action: 'BUY', strike: leg.strike, optionType: leg.optionType, entryPrice: Number(leg.entryPrice.toFixed(2)), exitPrice: Number(exitPrice.toFixed(2)), allocatedBudget: Number(dayBudget.toFixed(2)), investedAmount: Number(investedAmount.toFixed(2)), grossPnl: Number(grossPnl.toFixed(2)), charges: Number(charges.toFixed(2)), pnl, returnPct: Number((pnl / investedAmount * 100).toFixed(2)), regime: 'MINUTE_STRANGLE', reason: `Selected from ${plan.signalDate} close; entered ${leg.entryTimestamp}; ${exitRule} at ${timestamp}`, lotSize: leg.lotSize, lots: leg.lots, quantity: leg.quantity });
      const stats = strikeStats.get(leg.strike) || { side: plan.options.find((option) => option.strike === leg.strike)!.side, days: new Set<string>(), ce: 0, pe: 0, daily: new Map<string, number>() };
      stats.days.add(plan.date); if (leg.optionType === 'CE') stats.ce += pnl; else stats.pe += pnl;
      stats.daily.set(plan.date, (stats.daily.get(plan.date) || 0) + pnl); strikeStats.set(leg.strike, stats);
    };
    const minuteTimes = [...new Set(tradable.flatMap((leg) => leg.candles.map((candle) => candle.timestamp)))].filter((time) => time >= entryTimestamp && istTime(time) <= '15:30').sort();
    for (const timestamp of minuteTimes) {
      finalTimestamp = timestamp;
      const bars = new Map(tradable.map((leg) => [leg, leg.candles.find((candle) => candle.timestamp === timestamp)]));
      for (const leg of tradable) {
        if (leg.status !== 'OPEN') continue;
        const candle = bars.get(leg); if (!candle) continue;
        leg.lastPrice = candle.close; leg.lastTimestamp = timestamp;
        if (candle.low <= leg.entryPrice * 0.5) {
          const stop = leg.entryPrice * 0.5;
          recordExit(leg, candle.open <= stop ? candle.open : stop, timestamp, '50% per-leg stop-loss');
        }
      }
      const openLegs = tradable.filter((leg) => leg.status === 'OPEN');
      const hasAllMinutePrices = openLegs.length > 0 && openLegs.every((leg) => bars.get(leg));
      if (hasAllMinutePrices) {
        const openPnl = openLegs.reduce((sum, leg) => sum + (Math.max(0.01, leg.lastPrice - config.slippagePerUnit) - leg.entryPrice) * leg.quantity - 2 * config.costPerTrade, 0);
        if (realized + openPnl > combinedProfitTarget) {
          targetHit = true;
          for (const leg of openLegs) recordExit(leg, bars.get(leg)!.close, timestamp, `portfolio combined profit target ₹${combinedProfitTarget.toLocaleString('en-IN')}`);
          break;
        }
      }
      if (openLegs.length === 0) break;
    }
    if (!targetHit) {
      for (const leg of tradable) {
        if (leg.status !== 'OPEN') continue;
        recordExit(leg, leg.lastPrice, finalTimestamp, '3:30 PM session close / time exit');
      }
    }
    capital = Number((capital + dayPnl).toFixed(2)); peak = Math.max(peak, capital); maxDrawdown = Math.max(maxDrawdown, peak - capital);
    const reinvested = dayPnl > 0 ? Number((dayPnl * 0.5).toFixed(2)) : 0;
    totalReinvested += reinvested; sideBudget += reinvested / count / 2;
    dailyResults.push({ date: plan.date, note: targetHit ? `Portfolio profit target ₹${combinedProfitTarget.toLocaleString('en-IN')} triggered at ${istTime(finalTimestamp)}.` : `${count} complete paired strikes entered; remaining legs closed by stop or session close.`, pnl: Number(dayPnl.toFixed(2)), cePnl: Number(cePnl.toFixed(2)), pePnl: Number(pePnl.toFixed(2)), strikesEntered: completePairs.map((option) => option.strike).sort((a, b) => a - b), capital, reinvested, investmentPerSideNextDay: Number(Math.min(sideBudget, Math.max(0, capital) / (count * 2)).toFixed(2)) });
    await onProgress?.({ date: plan.date, equity: capital, pnl: Number(dayPnl.toFixed(2)), completed: planIndex + 1, total: plans.length });
  }
  if (!trades.length) return insufficient('No complete synchronized 1-minute CE/PE contract bars were available for the selected sessions. Check Upstox access, plan, and historical coverage.');
  const winners = trades.filter((trade) => trade.pnl > 0).length;
  const grossProfit = trades.filter((trade) => trade.pnl > 0).reduce((sum, trade) => sum + trade.pnl, 0);
  const grossLoss = Math.abs(trades.filter((trade) => trade.pnl < 0).reduce((sum, trade) => sum + trade.pnl, 0));
  const totalPnl = Number((capital - initialCapital).toFixed(2));
  const metrics: BacktestMetrics = { totalTrades: trades.length, winningTrades: winners, losingTrades: trades.length - winners, winRate: Number((winners / trades.length * 100).toFixed(1)), totalPnl, profitFactor: grossLoss ? Number((grossProfit / grossLoss).toFixed(2)) : grossProfit ? 99 : 0, maxDrawdown: Number(maxDrawdown.toFixed(2)), maxDrawdownPct: peak ? Number((maxDrawdown / peak * 100).toFixed(1)) : 0, finalCapital: capital, returnOnCapital: Number((totalPnl / initialCapital * 100).toFixed(2)), averageTradePnl: Number((totalPnl / trades.length).toFixed(2)) };
  const strikeResults: BacktestStrikeResult[] = [...strikeStats.entries()].sort((a, b) => a[0] - b[0]).map(([strike, stats]) => ({ strike, side: stats.side, days: stats.days.size, cePnl: Number(stats.ce.toFixed(2)), pePnl: Number(stats.pe.toFixed(2)), totalPnl: Number((stats.ce + stats.pe).toFixed(2)), dailyPnl: dailyResults.map((day) => ({ date: day.date, pnl: Number((stats.daily.get(day.date) || 0).toFixed(2)) })) }));
  return { status: 'SUCCESS', message: `Minute-level backtest exits all open legs when portfolio net P&L first exceeds ₹${combinedProfitTarget.toLocaleString('en-IN')}, with per-leg 50% stops and a 15:30 session close.`, config, metrics, trades: trades.reverse(), equityCurve: dailyResults.map((day) => ({ date: day.date, equity: day.capital })), regimePerformance: [], signalCounts: {}, dailyResults, strikeResults, reinvestment: { reinvestmentRate: 0.5, initialPerSideInvestment: perLegBudget, finalPerSideInvestment: Number(sideBudget.toFixed(2)), totalReinvested: Number(totalReinvested.toFixed(2)) } };
}
