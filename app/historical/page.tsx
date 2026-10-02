'use client';

import { useEffect, useMemo, useState } from 'react';
import { Navbar } from '@/components/layout/navbar';
import { Sidebar } from '@/components/layout/sidebar';
import { CandlestickChart } from '@/components/charts/candlestick-chart';
import type { Candle, CandleInterval } from '@/types/market';
import { BarChart3, Database } from 'lucide-react';

type Payload = { expiries?: string[]; strikes?: number[]; strike?: number; dates?: string[]; date?: string; candles?: Candle[]; error?: string };
const intervals: CandleInterval[] = ['1m', '5m', '15m', '1h', '1D'];

function bucketCandles(candles: Candle[], interval: CandleInterval): Candle[] {
  const minutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
  const grouped = new Map<string, Candle>();
  for (const candle of candles) {
    const date = new Date(candle.time * 1000 + 330 * 60 * 1000);
    const session = `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}`;
    const minuteOfSession = date.getUTCHours() * 60 + date.getUTCMinutes();
    const key = interval === '1D'
      ? session
      : `${session}-${Math.floor(minuteOfSession / (minutes[interval] || 1))}`;
    const previous = grouped.get(key);
    if (!previous) grouped.set(key, { ...candle });
    else grouped.set(key, { ...previous, high: Math.max(previous.high, candle.high), low: Math.min(previous.low, candle.low), close: candle.close, volume: previous.volume + candle.volume });
  }
  return [...grouped.values()];
}

export default function HistoricalPage() {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [kind, setKind] = useState<'spot' | 'option'>('spot');
  const [optionType, setOptionType] = useState<'CE' | 'PE'>('CE');
  const [strike, setStrike] = useState('');
  const [date, setDate] = useState('');
  const [strikes, setStrikes] = useState<number[]>([]);
  const [dates, setDates] = useState<string[]>([]);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [interval, setInterval] = useState<CandleInterval>('1m');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/historical-options').then((response) => response.json()).then((payload: Payload) => {
      if (payload.error) throw new Error(payload.error);
      const available = payload.expiries || [];
      setExpiries(available);
      if (available.length) setExpiry(available[available.length - 1]);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : 'Could not load expiry folders.'));
  }, []);

  useEffect(() => {
    if (!expiry) return;
    const params = new URLSearchParams({ expiry, kind, type: optionType });
    if (kind === 'option' && strike) params.set('strike', strike);
    if (date) params.set('date', date);
    let active = true;
    setLoading(true);
    fetch(`/api/historical-options?${params}`).then((response) => response.json()).then((payload: Payload) => {
      if (payload.error) throw new Error(payload.error);
      if (!active) return;
      setStrikes(payload.strikes || []);
      if (payload.strikes?.length && !payload.strikes.includes(Number(strike))) setStrike(String(payload.strike ?? payload.strikes[Math.floor(payload.strikes.length / 2)]));
      setDates(payload.dates || []);
      if (payload.date && payload.date !== date) setDate(payload.date);
      setCandles(payload.candles || []);
      setError('');
    }).catch((reason) => { if (active) setError(reason instanceof Error ? reason.message : 'Could not load historical candles.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [expiry, kind, optionType, strike, date]);

  const visibleCandles = useMemo(() => bucketCandles(candles, interval), [candles, interval]);
  const title = kind === 'spot' ? 'NIFTY Spot' : `NIFTY ${strike} ${optionType}`;

  return <div className="min-h-screen bg-[#070a12] text-slate-100 flex flex-col font-sans"><Navbar /><div className="flex flex-1"><Sidebar /><main className="mx-auto w-full max-w-7xl flex-1 space-y-6 p-6">
    <header className="flex items-start gap-3"><div className="flex h-9 w-9 items-center justify-center rounded-lg border border-indigo-500/20 bg-indigo-500/10 text-indigo-400"><BarChart3 className="h-4 w-4" /></div><div><h1 className="text-2xl font-bold text-white">Historical Options Explorer</h1><p className="mt-1 text-xs text-slate-400">Explore the supplied NIFTY minute OHLC data by expiry, contract, and session.</p></div></header>
    <section className="grid gap-4 rounded-xl border border-border bg-[#0e1320] p-5 sm:grid-cols-2 lg:grid-cols-4">
      <label className="text-xs text-slate-400">Expiry folder<select value={expiry} onChange={(event) => { setExpiry(event.target.value); setDate(''); setStrike(''); }} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white">{expiries.map((value) => <option key={value} value={value}>{value.slice(0, 4)}-{value.slice(4, 6)}-{value.slice(6, 8)}</option>)}</select></label>
      <label className="text-xs text-slate-400">Series<select value={kind} onChange={(event) => { setKind(event.target.value as 'spot' | 'option'); setDate(''); }} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white"><option value="spot">NIFTY spot</option><option value="option">Option contract</option></select></label>
      {kind === 'option' && <><label className="text-xs text-slate-400">Option type<select value={optionType} onChange={(event) => { setOptionType(event.target.value as 'CE' | 'PE'); setStrike(''); setDate(''); }} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white"><option value="CE">Call (CE)</option><option value="PE">Put (PE)</option></select></label><label className="text-xs text-slate-400">Strike<select value={strike} onChange={(event) => { setStrike(event.target.value); setDate(''); }} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white">{strikes.map((value) => <option key={value} value={value}>{value.toLocaleString('en-IN')}</option>)}</select></label></>}
      <label className="text-xs text-slate-400">Session date<select value={date} onChange={(event) => setDate(event.target.value)} className="mt-1.5 w-full rounded-lg border border-border bg-slate-900 px-3 py-2 text-sm text-white">{dates.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    </section>
    {error && <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">{error}</div>}
    {candles.length ? <section className="space-y-3"><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2 text-xs text-slate-400"><Database className="h-4 w-4 text-cyan-400" />{candles.length.toLocaleString()} minute bars · {date} · Historical sample data</div><div className="flex flex-wrap gap-1">{intervals.map((value) => <button key={value} onClick={() => setInterval(value)} className={`rounded-md border px-2.5 py-1 text-xs ${interval === value ? 'border-indigo-500 bg-indigo-600 text-white' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>{value}</button>)}</div></div><CandlestickChart candles={visibleCandles} symbol={title} interval={interval} onIntervalChange={setInterval} isLoading={loading} /></section> : !loading && !error ? <div className="rounded-xl border border-border bg-[#0e1320] p-8 text-center text-sm text-slate-400">No candles are available for this selection.</div> : null}
  </main></div></div>;
}
