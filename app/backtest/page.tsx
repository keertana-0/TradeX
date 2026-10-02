'use client';

import React, { useMemo, useState } from 'react';
import { Navbar } from '@/components/layout/navbar';
import { Sidebar } from '@/components/layout/sidebar';
import { BacktestResult } from '@/types/backtest';
import { formatINR } from '@/lib/utils';
import { AlertCircle, BarChart3, Play } from 'lucide-react';

const INDEXES = [
  { value: 'NIFTY50', label: 'NIFTY' },
  { value: 'BANKNIFTY', label: 'Bank Nifty' },
  { value: 'SENSEX', label: 'SENSEX' },
];
const WEEKDAYS = [
  { value: 1, label: 'Monday' }, { value: 2, label: 'Tuesday' }, { value: 3, label: 'Wednesday' },
  { value: 4, label: 'Thursday' }, { value: 5, label: 'Friday' },
];

function LineChart({ title, points, color = '#34d399', zeroBaseline = true }: { title: string; points: { label: string; value: number }[]; color?: string; zeroBaseline?: boolean }) {
  const width = 720;
  const height = 190;
  const left = 54;
  const right = 14;
  const top = 16;
  const bottom = 32;
  const values = points.map((point) => point.value);
  const minValue = zeroBaseline ? Math.min(0, ...values) : Math.min(...values);
  const maxValue = zeroBaseline ? Math.max(0, ...values) : Math.max(...values);
  const spread = maxValue - minValue || 1;
  const x = (index: number) => left + (points.length < 2 ? 0 : index * (width - left - right) / (points.length - 1));
  const y = (value: number) => top + (maxValue - value) * (height - top - bottom) / spread;
  const zeroY = y(0);
  const path = points.map((point, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(' ');
  const labelIndices = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])];

  return (
    <section className="rounded-xl border border-border bg-[#0e1320] p-4">
      <h3 className="mb-2 text-sm font-semibold text-white">{title}</h3>
      {points.length ? (
        <svg viewBox={`0 0 ${width} ${height}`} className="h-48 w-full" role="img" aria-label={title}>
          <line x1={left} y1={top} x2={left} y2={height - bottom} stroke="#475569" />
          <line x1={left} y1={zeroY} x2={width - right} y2={zeroY} stroke="#64748b" strokeDasharray="4 4" />
          <line x1={left} y1={height - bottom} x2={width - right} y2={height - bottom} stroke="#475569" />
          <text x={left - 7} y={top + 4} fill="#94a3b8" fontSize="10" textAnchor="end">{formatINR(maxValue)}</text>
          <text x={left - 7} y={height - bottom + 4} fill="#94a3b8" fontSize="10" textAnchor="end">{formatINR(minValue)}</text>
          {points.length > 1 && <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
          {points.map((point, index) => <circle key={`${point.label}-${index}`} cx={x(index)} cy={y(point.value)} r="3" fill={color}><title>{point.label}: {formatINR(point.value)}</title></circle>)}
          {labelIndices.map((index) => <text key={index} x={x(index)} y={height - 9} fill="#94a3b8" fontSize="10" textAnchor={index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle'}>{points[index]?.label}</text>)}
        </svg>
      ) : <p className="py-10 text-center text-xs text-slate-500">No daily prices available.</p>}
    </section>
  );
}

export default function BacktestPage() {
  const [symbol, setSymbol] = useState('NIFTY50');
  const [strikeCount, setStrikeCount] = useState(4);
  const [tradingDays, setTradingDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [initialPerSideInvestment, setInitialPerSideInvestment] = useState(100000);
  const [slippage, setSlippage] = useState(0.5);
  const [costPerTrade, setCostPerTrade] = useState(20);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [liveEquity, setLiveEquity] = useState<{ label: string; value: number }[]>([]);
  const [progressMessage, setProgressMessage] = useState('');

  const dailyPoints = useMemo(() => (result?.dailyResults || []).map((row) => ({ label: row.date.slice(5), value: row.pnl })), [result]);

  const handleRunBacktest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!from || !to || from > to) {
      setError('Choose a valid start and end date.');
      return;
    }
    if (strikeCount < 2 || !Number.isInteger(strikeCount)) {
      setError('Enter at least two strikes so positions can be selected above and below spot.');
      return;
    }
    if (!tradingDays.length) {
      setError('Select at least one trading weekday from Monday to Friday.');
      return;
    }
    setLoading(true);
    setError(null);
    setResult(null);
    setLiveEquity([{ label: 'Start', value: initialPerSideInvestment * strikeCount * 2 }]);
    setProgressMessage('Connecting to Jugaad…');
    try {
      const response = await fetch('/api/backtest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, strikeCount, tradingDays, initialPerSideInvestment, slippagePerUnit: slippage, costPerTrade, from, to }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.details || payload?.error || `Backtest failed (${response.status}).`);
      }
      if (!response.body) throw new Error('Backtest stream was unavailable.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completedResult: BacktestResult | null = null;
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const events = buffer.split('\n\n');
        buffer = events.pop() || '';
        for (const event of events) {
          const line = event.split('\n').find((item) => item.startsWith('data: '));
          if (!line) continue;
          const payload = JSON.parse(line.slice(6));
          if (payload.type === 'status') setProgressMessage(payload.message);
          if (payload.type === 'progress') {
            setLiveEquity((previous) => [...previous, { label: payload.date, value: payload.equity }]);
            setProgressMessage(`Processed ${payload.completed} of ${payload.total} sessions · ${formatINR(payload.equity)} equity`);
          }
          if (payload.type === 'error') throw new Error(payload.error || 'Unable to run the backtest.');
          if (payload.type === 'result') completedResult = payload.result as BacktestResult;
        }
        if (done) break;
      }
      if (!completedResult?.metrics || !Array.isArray(completedResult.trades)) throw new Error('Backtest returned an invalid result.');
      setResult(completedResult);
      if (completedResult.status === 'INSUFFICIENT_DATA') setError(completedResult.message || 'Jugaad did not return enough daily option data for these settings.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to run backtest.');
    } finally {
      setLoading(false);
    }
  };

  const totalPnl = result?.metrics.totalPnl ?? 0;

  return (
    <div className="min-h-screen bg-[#070a12] text-slate-100 flex flex-col font-sans">
      <Navbar />
      <div className="flex flex-1">
        <Sidebar />
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-6">
          <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10 text-indigo-400"><BarChart3 className="h-4 w-4" /></div>
                <h1 className="text-2xl font-bold tracking-tight text-white">Daily Options Backtest</h1>
              </div>
              <p className="mt-1 text-xs text-slate-400">Jugaad supplies daily option candles. The backtest applies prior-close strike selection, 50% per-leg stops, the paired CE/PE profit target, and the session-close exit using daily OHLC data.</p>
            </div>
          </header>

          {error && <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"><AlertCircle className="mt-0.5 h-4 w-4 shrink-0" /><span>{error}</span></div>}

          <form onSubmit={handleRunBacktest} className="space-y-5">
            <section className="rounded-xl border border-border bg-[#0e1320] p-5 shadow-lg">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">Backtest inputs</h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <label className="text-xs text-slate-400">Index
                  <select value={symbol} onChange={(event) => setSymbol(event.target.value)} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none">
                    {INDEXES.map((index) => <option key={index.value} value={index.value}>{index.label}</option>)}
                  </select>
                </label>
                <label className="text-xs text-slate-400">Number of strikes (total)
                  <input type="number" min={2} max={40} step={1} required value={strikeCount} onChange={(event) => setStrikeCount(Number(event.target.value))} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 font-mono text-sm text-white" />
                </label>
                <label className="text-xs text-slate-400">From date
                  <input type="date" required value={from} onChange={(event) => setFrom(event.target.value)} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white" />
                </label>
                <label className="text-xs text-slate-400">To date
                  <input type="date" required value={to} onChange={(event) => setTo(event.target.value)} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white" />
                </label>
                <label className="text-xs text-slate-400">Investment per CE / PE leg, per strike (₹)
                  <input type="number" min={1000} step={1000} value={initialPerSideInvestment} onChange={(event) => setInitialPerSideInvestment(Number(event.target.value))} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 font-mono text-sm text-white" />
                </label>
                <label className="text-xs text-slate-400">Slippage per unit (₹)
                  <input type="number" min={0} step="0.05" value={slippage} onChange={(event) => setSlippage(Number(event.target.value))} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 font-mono text-sm text-white" />
                </label>
                <label className="text-xs text-slate-400">Cost per leg / order (₹)
                  <input type="number" min={0} step={1} value={costPerTrade} onChange={(event) => setCostPerTrade(Number(event.target.value))} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 font-mono text-sm text-white" />
                </label>
              </div>
              <fieldset className="mt-4">
                <legend className="mb-2 text-xs text-slate-400">Trading days</legend>
                <div className="flex flex-wrap gap-2">
                  {WEEKDAYS.map((day) => <label key={day.value} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-border bg-slate-900 px-3 py-2 text-xs text-slate-200">
                    <input type="checkbox" checked={tradingDays.includes(day.value)} onChange={(event) => setTradingDays((current) => event.target.checked ? [...current, day.value].sort() : current.filter((value) => value !== day.value))} className="accent-indigo-500" />
                    {day.label}
                  </label>)}
                </div>
              </fieldset>
              <div className="mt-4 rounded-lg border border-indigo-500/20 bg-indigo-500/5 p-3 text-xs leading-5 text-indigo-100">
                <strong>Strike selection:</strong> the total count is split around spot (odd counts add one above); the nearest available strikes are chosen on both sides. Each selected strike buys both CE and PE. The budget is {formatINR(initialPerSideInvestment)} per CE/PE leg at each strike, so configured starting capital is {formatINR(initialPerSideInvestment * strikeCount * 2)} ({strikeCount} strikes × 2 legs). Daily OHLC applies each leg&apos;s 50% stop using the session low and a gap-aware fill proxy; the paired CE/PE target and 3:45 PM exit use the daily close. After a profitable day, 50% of net P&amp;L is reinvested across the configured strikes and CE/PE legs. Daily bars cannot determine the exact trigger time or verify the ₹2,10,000 intraday portfolio target.
              </div>
            </section>

            <section className="rounded-xl border border-border bg-[#0e1320] p-5 shadow-lg">
              <h2 className="text-sm font-semibold text-white">Automated historical data</h2>
              <p className="mt-1 text-xs leading-5 text-slate-400">Jugaad retrieves historical NSE daily option prices automatically; SENSEX uses the BSE daily source. Cleaned daily OHLC data is used for backtesting. Daily candles cannot simulate minute-by-minute portfolio exits.</p>
              {result?.coverage && <p className="mt-2 text-xs text-cyan-300">{result.dataSource} · {result.coverage.observedSessions} sessions returned · {result.coverage.failedDateCount} dates unavailable</p>}
              {result?.dataQuality && <div className="mt-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">
                <strong>Data quality before analysis:</strong> {result.dataQuality.acceptedRows.toLocaleString()} of {result.dataQuality.rawCandidateRows.toLocaleString()} option rows accepted · {result.dataQuality.rejectedRows.toLocaleString()} rejected
                {result.dataQuality.rejectedRows > 0 && <span className="ml-1 text-slate-400">({Object.entries(result.dataQuality.rejectionCounts).map(([reason, count]) => `${reason.replaceAll('_', ' ')}: ${count}`).join(' · ')})</span>}
              </div>}
            </section>

            <div className="flex justify-end">
              <button type="submit" disabled={loading} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-500 disabled:opacity-50">
                {loading ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white" />Running backtest…</> : <><Play className="h-4 w-4 fill-white" />Run Backtest</>}
              </button>
            </div>
          </form>

          {loading && <section className="rounded-xl border border-cyan-500/30 bg-[#0e1320] p-5"><div className="mb-3 flex items-center justify-between gap-3"><h2 className="text-sm font-semibold text-white">Live portfolio equity</h2><span className="text-xs text-cyan-300">{progressMessage}</span></div><LineChart title="Portfolio value as sessions are processed" points={liveEquity} color="#22d3ee" zeroBaseline={false} /></section>}

          {result && (
            <div className="space-y-6">
              {result.status === 'INSUFFICIENT_DATA' && <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">{result.message}</div>}
              <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
                {[
                  ['Net P&L', `${totalPnl >= 0 ? '+' : ''}${formatINR(totalPnl)}`, totalPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'],
                  ['Return on capital', `${result.metrics.returnOnCapital}%`, 'text-cyan-300'],
                  ['CE + PE trades', String(result.metrics.totalTrades), 'text-white'],
                  ['Win rate', `${result.metrics.winRate}%`, 'text-white'],
                  ['Max drawdown', `-${formatINR(result.metrics.maxDrawdown)}`, 'text-amber-400'],
                  ['Ending capital', formatINR(result.metrics.finalCapital), 'text-white'],
                ].map(([label, value, tone]) => <div key={label} className="rounded-xl border border-border bg-[#0e1320] p-4"><span className="mb-1 block text-[11px] text-slate-400">{label}</span><div className={`font-mono text-lg font-bold ${tone}`}>{value}</div></div>)}
              </section>

              {result.dailyResults?.length ? <>
                <section className="grid gap-4 lg:grid-cols-2">
                  <LineChart title="Daily total P&L" points={dailyPoints} color={totalPnl >= 0 ? '#34d399' : '#fb7185'} />
                  <div className="rounded-xl border border-border bg-[#0e1320] p-4">
                    <h3 className="mb-3 text-sm font-semibold text-white">Reinvestment ledger</h3>
                    <div className="grid grid-cols-2 gap-3 text-xs">
                      <div className="rounded-lg bg-slate-900 p-3"><span className="text-slate-400">Total reinvested</span><strong className="mt-1 block font-mono text-emerald-300">{formatINR(result.reinvestment?.totalReinvested || 0)}</strong></div>
                      <div className="rounded-lg bg-slate-900 p-3"><span className="text-slate-400">Final per side / strike</span><strong className="mt-1 block font-mono text-cyan-300">{formatINR(result.reinvestment?.finalPerSideInvestment || initialPerSideInvestment)}</strong></div>
                    </div>
                    <p className="mt-3 text-xs leading-5 text-slate-400">Only positive daily net P&amp;L is reinvested. Half is allocated across all configured strikes and split equally across CE and PE on the following day.</p>
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-[#0e1320] p-5">
                  <h2 className="mb-3 text-sm font-semibold text-white">Daily results</h2>
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full min-w-[840px] text-left text-xs font-mono">
                      <thead className="sticky top-0 border-b border-border bg-slate-900 text-slate-400"><tr><th className="p-2.5">Date</th><th className="p-2.5">Strikes entered (above / below spot)</th><th className="p-2.5">Entry availability</th><th className="p-2.5 text-right">Aggregate CE P&amp;L</th><th className="p-2.5 text-right">Aggregate PE P&amp;L</th><th className="p-2.5 text-right">Net P&amp;L</th><th className="p-2.5 text-right">50% reinvested</th><th className="p-2.5 text-right">Next-session budget per leg / strike</th></tr></thead>
                      <tbody className="divide-y divide-border/40 text-slate-300">{result.dailyResults.map((day) => <tr key={day.date}><td className="p-2.5">{day.date}</td><td className="p-2.5">{day.strikesEntered.length ? day.strikesEntered.join(', ') : 'No entries'}</td><td className="max-w-[360px] p-2.5 text-slate-400">{day.note || `${day.strikesEntered.length} complete strikes entered`}</td><td className="p-2.5 text-right">{formatINR(day.cePnl)}</td><td className="p-2.5 text-right">{formatINR(day.pePnl)}</td><td className={`p-2.5 text-right font-bold ${day.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{formatINR(day.pnl)}</td><td className="p-2.5 text-right">{formatINR(day.reinvested)}</td><td className="p-2.5 text-right">{formatINR(day.investmentPerSideNextDay)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </section>

                <section className="rounded-xl border border-border bg-[#0e1320] p-5">
                  <h2 className="mb-1 text-sm font-semibold text-white">Daily P&amp;L by strike</h2>
                  <p className="mb-3 text-xs text-slate-400">Each cell combines that strike&apos;s CE and PE P&amp;L for the date.</p>
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full min-w-max text-left text-xs font-mono">
                      <thead className="sticky top-0 border-b border-border bg-slate-900 text-slate-400"><tr><th className="sticky left-0 bg-slate-900 p-2.5">Date</th>{(result.strikeResults || []).map((strike) => <th key={strike.strike} className="whitespace-nowrap p-2.5 text-right">{strike.strike} ({strike.side.toLowerCase()})</th>)}<th className="p-2.5 text-right">Day total</th></tr></thead>
                      <tbody className="divide-y divide-border/40 text-slate-300">{result.dailyResults.map((day) => <tr key={day.date}><td className="sticky left-0 bg-[#0e1320] p-2.5">{day.date}</td>{(result.strikeResults || []).map((strike) => { const daily = strike.dailyPnl.find((point) => point.date === day.date)?.pnl || 0; return <td key={strike.strike} className={`whitespace-nowrap p-2.5 text-right ${daily >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{formatINR(daily)}</td>; })}<td className={`p-2.5 text-right font-bold ${day.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{formatINR(day.pnl)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </section>

                <section className="space-y-3">
                  <div><h2 className="text-sm font-semibold text-white">P&amp;L by strike</h2><p className="mt-1 text-xs text-slate-400">Each chart shows the combined CE + PE daily P&amp;L for that selected strike.</p></div>
                  <div className="grid gap-4 xl:grid-cols-2">{(result.strikeResults || []).map((strike) => <LineChart key={strike.strike} title={`${strike.strike} · ${strike.side} spot · CE ${formatINR(strike.cePnl)} · PE ${formatINR(strike.pePnl)} · Total ${formatINR(strike.totalPnl)}`} points={strike.dailyPnl.map((point) => ({ label: point.date.slice(5), value: point.pnl }))} color={strike.totalPnl >= 0 ? '#22d3ee' : '#fb7185'} />)}</div>
                </section>

                <section className="rounded-xl border border-border bg-[#0e1320] p-5">
                  <h2 className="mb-1 text-sm font-semibold text-white">Detailed trade calculations</h2>
                  <p className="mb-3 text-xs text-slate-400">One row per CE or PE leg. Invested amount = adjusted entry price × quantity; net P&amp;L = (adjusted exit − adjusted entry) × quantity − round-trip charges. Daily CE/PE totals sum these net leg P&amp;Ls.</p>
                  <div className="max-h-[360px] overflow-auto">
                    <table className="w-full min-w-[1550px] text-left text-xs font-mono">
                      <thead className="sticky top-0 border-b border-border bg-slate-900 text-slate-400"><tr><th className="p-2.5">Date</th><th className="p-2.5">Strike</th><th className="p-2.5">Side</th><th className="p-2.5">Lots × lot size (qty)</th><th className="p-2.5 text-right">Budget per leg</th><th className="p-2.5 text-right">Invested amount</th><th className="p-2.5 text-right">Entry → exit price</th><th className="p-2.5 text-right">Gross P&amp;L</th><th className="p-2.5 text-right">Charges</th><th className="p-2.5 text-right">Net P&amp;L</th><th className="p-2.5 text-right">Return</th><th className="p-2.5">Exit rule</th></tr></thead>
                      <tbody className="divide-y divide-border/40 text-slate-300">{result.trades.map((trade) => <tr key={trade.id}><td className="p-2.5">{trade.date.slice(0, 10)}</td><td className="p-2.5">{trade.strike}</td><td className="p-2.5">{trade.optionType}</td><td className="p-2.5">{trade.lots ?? '—'} × {trade.lotSize ?? '—'} ({trade.quantity ?? '—'})</td><td className="p-2.5 text-right">{formatINR(trade.allocatedBudget ?? 0)}</td><td className="p-2.5 text-right">{formatINR(trade.investedAmount ?? trade.entryPrice * (trade.quantity ?? 0))}</td><td className="p-2.5 text-right">₹{trade.entryPrice} → ₹{trade.exitPrice}</td><td className="p-2.5 text-right">{formatINR(trade.grossPnl ?? trade.pnl)}</td><td className="p-2.5 text-right">{formatINR(trade.charges ?? 0)}</td><td className={`p-2.5 text-right font-bold ${trade.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{formatINR(trade.pnl)}</td><td className="p-2.5 text-right">{trade.returnPct}%</td><td className="p-2.5" title={trade.reason}>{trade.reason.split('; ').at(-1)}</td></tr>)}</tbody>
                    </table>
                  </div>
                </section>
              </> : null}
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
