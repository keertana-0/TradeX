'use client';

import { useCallback, useEffect, useState } from 'react';
import { 
  AlertTriangle, ArrowDownRight, ArrowUpRight, Bot, CircleStop, Crown, Crosshair, 
  Flame, Globe, Medal, Play, RefreshCw, ShieldCheck, Sparkles, Target, Trophy, Zap 
} from 'lucide-react';
import { Navbar } from '@/components/layout/navbar';
import { Sidebar } from '@/components/layout/sidebar';
import { formatINR, formatUSDT } from '@/lib/utils';
import { AgentDetailModal } from '@/components/strategy-agents/agent-detail-modal';
import { AGENT_CONFIGS, getAgentMeta } from '@/lib/strategy-agents/agent-config';
import { AgentPortrait } from '@/components/strategy-agents/agent-portrait';

type SignalOutput = { strategy: string; market_regime: 'BULLISH' | 'BEARISH' | 'SIDEWAYS' | 'UNKNOWN'; signal: 'LONG' | 'SHORT' | 'EXIT' | 'NO_TRADE'; confidence: number; liveConfidence?: number; liveAnalysisAt?: string; scanningSymbol?: string; entry_price: number | null; stop_loss: number | null; target: number | null; risk_reward: number | null; reason: string[]; timestamp: string; underlying?: string; strike?: number; option_type?: 'CE' | 'PE'; expiry?: string };
type Signal = { id: string; action: 'BUY' | 'SELL' | 'HOLD' | 'LONG' | 'SHORT' | 'EXIT' | 'NO_TRADE'; reason: string; referencePrice: number; createdAt: string; output: SignalOutput | null };
type Agent = {
  id: string; key: string; name: string; description: string; currency?: string; initialCapital: number; cashBalance: number;
  realizedPnL: number; dailyRealizedPnL: number; maxDrawdown: number; entriesToday: number; isPaused: boolean;
  lastAction: 'BUY' | 'SELL' | 'HOLD'; lastReason: string; equity: number; totalPnL: number; dailyPnL: number;
  openTrade: null | { symbol: string; quantity: number; entryPrice: number; currentPrice: number; stopLossPrice: number; takeProfitPrice: number; unrealizedPnL: number; updatedAt?: string };
  recentSignals: Signal[];
  tradesLast24hCount?: number;
  rank: number;
};
type Competition = {
  id: string; marketType?: string; currency?: string; status: 'WAITING_FOR_MARKET' | 'WAITING_FOR_LIVE_DATA' | 'RUNNING' | 'STOPPED';
  instrumentKey: string; initialCapital: number; latestPrice: number; latestPriceAt: string | null; lastTickAt: string | null;
  lastError: string | null; startedAt: string; stoppedAt: string | null;
  confidenceThreshold?: number;
  portfolioLeaderboard: Agent[]; dailyProfitLeaderboard: Agent[];
};
type ValidationMetric = { winRate: number; profitFactor: number | null; totalReturnPct: number; maxDrawdownPct: number; averageR: number; sharpeRatio: number; numberOfTrades: number; averageHoldingMinutes: number };
type ValidationReport = { data: { symbol: string; firstTimestamp: string | null; lastTimestamp: string | null; tradingDays: number; candles: number }; methodology?: { entryGate?: string }; strategies: Array<{ strategy: string; periods: { testing: { from: string | null; to: string | null; metrics: ValidationMetric } } }> };
type CryptoBacktestAgent = { key: string; strategy: string; initialBudget: number; finalBalance: number; netPnl: number; returnPct: number; maxDrawdownPct: number; trades: number; wins: number; losses: number; winRate: number; profitFactor: number | null; fees: number; bySymbol: Record<string, number>; recentTrades: Array<{ symbol: string; side: 'LONG' | 'SHORT'; entryTime: string; exitTime: string; entryPrice: number; exitPrice: number; quantity: number; pnl: number; exitReason: string }> };
type CryptoBacktestResponse = { backtest: { timeframe: string; candleCount: number; from: string; to: string; symbols: string[]; methodology: string; results: CryptoBacktestAgent[] }; data: Array<{ symbol: string; candles: number }>; requestedRange: { startDate: string; endDate: string } };
type CryptoBacktestProgress = { phase: 'download' | 'backtest'; percentage: number; message: string };

const activeStatuses = ['WAITING_FOR_MARKET', 'WAITING_FOR_LIVE_DATA', 'RUNNING'];

function formatVal(value: number, currency?: string) {
  if (currency === 'USDT') return formatUSDT(value);
  return formatINR(value);
}

function statusLabel(status?: Competition['status'], isCrypto = false) {
  if (status === 'RUNNING') return isCrypto ? 'Crypto 24/7 agents active' : 'Paper agents active';
  if (status === 'WAITING_FOR_LIVE_DATA') return 'Connecting to live market data';
  if (status === 'WAITING_FOR_MARKET') return 'Waiting for NSE regular session';
  return 'Not started';
}

function localDateInput(daysOffset = 0) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function Leaderboard({ 
  title, 
  agents, 
  metric, 
  currency,
  onSelect,
  isSessionLeaderboard,
}: { 
  title: string; 
  agents: Agent[]; 
  metric: 'equity' | 'dailyPnL'; 
  currency?: string;
  onSelect?: (agentId: string) => void;
  isSessionLeaderboard?: boolean;
}) {
  const highest = Math.max(1, ...agents.map((agent) => metric === 'equity' ? agent.equity : agent.dailyPnL));
  const rankStyle = ['border-amber-300/30 bg-amber-300/10 text-amber-200', 'border-slate-300/25 bg-slate-300/10 text-slate-200', 'border-orange-400/25 bg-orange-400/10 text-orange-200'];
  return <section className="game-panel overflow-hidden">
    <div className="flex items-center gap-3 border-b border-white/[0.06] px-5 py-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-fuchsia-300/20 bg-fuchsia-400/10 text-fuchsia-200"><Trophy className="h-5 w-5" /></span>
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">{title}</h2>
        <p className="mt-1 text-[10px] text-slate-500">
          {metric === 'equity' 
            ? `Portfolio balance · cash + open positions (${currency || 'INR'})` 
            : `Active/Closed trades in last 24 hrs (${currency || 'INR'})`}
        </p>
      </div>
      <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[9px] font-bold tracking-widest text-slate-400">
        {isSessionLeaderboard ? '24H ACTIVE ONLY' : 'LIVE RANK'}
      </span>
    </div>
    <ol className="space-y-2 p-3 sm:p-4">
      {agents.map((agent) => {
        const meta = getAgentMeta(agent.key || agent.name);
        const value = metric === 'equity' ? agent.totalPnL : agent.dailyPnL;
        const score = metric === 'equity' ? agent.equity : agent.dailyPnL;
        const bar = score > 0 ? Math.max(7, Math.min(100, score / highest * 100)) : 4;
        const medalClass = rankStyle[agent.rank - 1] || 'border-white/[0.08] bg-white/[0.025] text-slate-500';
        return <li 
          key={agent.id} 
          onClick={() => onSelect?.(agent.id)}
          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(agent.id); } }}
          role="button"
          tabIndex={0}
          className={`leader-row group cursor-pointer transition-all hover:border-violet-400/50 hover:bg-white/[0.04] ${agent.rank <= 3 ? `leader-row-podium leader-row-rank-${agent.rank}` : ''}`}
          title="Click to view real-time chart, live trade terms & conditions"
        >
          <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border font-mono text-xs font-black ${medalClass}`}>
            {agent.rank === 1 ? <Crown className="h-4 w-4" /> : agent.rank <= 3 ? <Medal className="h-4 w-4" /> : String(agent.rank).padStart(2, '0')}
          </span>
          <AgentPortrait image={meta.image} name={meta.fullName} className="leader-portrait" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate text-xs font-bold text-slate-100 group-hover:text-cyan-200 transition-colors">{meta.fullName}</span>
              {agent.isPaused && <span className="rounded border border-amber-400/20 bg-amber-400/10 px-1.5 py-0.5 text-[8px] font-black tracking-wider text-amber-200">RISK LOCK</span>}
              {agent.openTrade && <span className="rounded border border-cyan-400/20 bg-cyan-400/10 px-1.5 py-0.5 text-[8px] font-black tracking-wider text-cyan-200 animate-pulse">IN TRADE</span>}
            </div>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-white/[0.06]">
              <div className={`score-bar h-full rounded-full ${value < 0 ? 'bg-gradient-to-r from-rose-500 to-orange-300' : 'bg-gradient-to-r from-violet-500 via-fuchsia-400 to-cyan-300'}`} style={{ width: `${bar}%` }} />
            </div>
            {isSessionLeaderboard && <span className="mt-1 block text-[8px] font-mono text-slate-500">{agent.tradesLast24hCount ?? 0} trades · 24h</span>}
          </div>
          <div className="min-w-[110px] text-right">
            <div className="font-mono text-xs font-bold text-white">{formatVal(metric === 'equity' ? agent.equity : agent.dailyPnL, currency)}</div>
            <div className={`mt-0.5 flex items-center justify-end gap-0.5 font-mono text-[9px] ${value >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>
              {value >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
              {value > 0 ? '+' : ''}{formatVal(value, currency)} P&L
            </div>
          </div>
        </li>;
      })}
      {!agents.length && (
        <li className="rounded-xl border border-dashed border-white/10 p-5 text-center text-xs text-slate-400">
          {isSessionLeaderboard 
            ? 'No agents took trades or are in position in the last 24 hours. As soon as market setups trigger, active traders will be ranked here.' 
            : 'No rankings yet. Start the arena to create the ten portfolios.'}
        </li>
      )}
    </ol>
  </section>;
}

function AgentCard({ agent, index, currency, confidenceThreshold = 0.65, onSelect }: { agent: Agent; index: number; currency?: string; confidenceThreshold?: number; onSelect?: (agentId: string) => void }) {
  const call = agent.recentSignals[0]?.output;
  const color = agent.openTrade ? 'cyan' : call?.signal === 'LONG' ? 'emerald' : call?.signal === 'SHORT' ? 'rose' : 'violet';
  const signalBadge = agent.isPaused ? 'RISK LOCK' : agent.openTrade ? 'POSITION LIVE' : currency === 'USDT' ? `ANALYZING ${call?.scanningSymbol || 'BTC · ETH · SOL'}` : 'SCANNING';
  const confidence = Math.min(100, Math.max(0, ((call?.liveConfidence ?? call?.confidence) || 0) * 100));
  const meta = getAgentMeta(agent.key || agent.name);
  return <article 
    onClick={() => onSelect?.(agent.id)}
    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect?.(agent.id); } }}
    role="button"
    tabIndex={0}
    className={`agent-card agent-card-${color} cursor-pointer transition-all hover:border-violet-400/60 hover:shadow-2xl hover:scale-[1.01] active:scale-[0.99]`} 
    style={{ animationDelay: `${index * 65}ms` }}
    title="Click to view real-time chart, live trade terms & conditions"
  >
    <div className="agent-card-sheen" />
    <div className="relative flex items-start gap-3">
      <AgentPortrait image={meta.image} name={meta.fullName} className="agent-avatar" /><i className="agent-rank">#{String(agent.rank).padStart(2, '0')}</i>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-[8px] font-black uppercase tracking-[0.2em] text-slate-500">STRATEGY UNIT</p>
            <h3 className="mt-1 text-sm font-extrabold leading-5 text-white group-hover:text-cyan-200 transition-colors">{meta.codename}</h3>
            <p className="text-[10px] font-semibold text-violet-200">({meta.strategyName})</p>
          </div>
          <span className="signal-chip">{signalBadge}</span>
        </div>
        <p className="mt-1.5 line-clamp-2 min-h-8 text-[10px] leading-4 text-slate-400">{agent.description}</p>
      </div>
    </div>
    {agent.openTrade && (
      <div className="contract-chip animate-pulse">
        <Zap className="h-3.5 w-3.5 shrink-0 text-cyan-300" />
        <span className="truncate">{agent.openTrade.symbol}</span>
        <span className="ml-auto font-mono">{agent.openTrade.quantity} units</span>
      </div>
    )}
    {agent.openTrade && (
      <div className="mt-2 grid grid-cols-2 gap-2 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.035] px-2.5 py-2 font-mono text-[9px]">
        <span className="text-slate-400">MARK <b className="ml-1 text-slate-100">{formatVal(agent.openTrade.currentPrice, currency)}</b></span>
        <span className="text-right text-slate-400">NET OPEN P&amp;L <b className={`ml-1 ${agent.openTrade.unrealizedPnL >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{agent.openTrade.unrealizedPnL > 0 ? '+' : ''}{formatVal(agent.openTrade.unrealizedPnL, currency)}</b></span>
        <span className="col-span-2 text-right text-[8px] text-slate-500">Mark updated {agent.openTrade.updatedAt ? new Date(agent.openTrade.updatedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'on latest engine tick'} · includes estimated fees</span>
      </div>
    )}
    <div className="mt-4 grid grid-cols-2 gap-2">
      <div className="agent-stat"><span>PORTFOLIO ({currency || 'INR'})</span><strong>{formatVal(agent.equity, currency)}</strong></div>
      <div className="agent-stat"><span>SESSION P&L</span><strong className={agent.dailyPnL >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{agent.dailyPnL > 0 ? '+' : ''}{formatVal(agent.dailyPnL, currency)}</strong></div>
    </div>
    <div className="mt-3 flex items-center justify-between text-[9px] font-bold uppercase tracking-wider text-slate-500">
      <span>{call?.market_regime || 'REGIME UNKNOWN'}</span>
      <span title={`Live strategy-rule progress, not a win probability.${call?.liveAnalysisAt ? ` Last refreshed ${new Date(call.liveAnalysisAt).toLocaleTimeString()}.` : ''}`}>LIVE RULE SCORE <b className="ml-1 font-mono text-slate-200">{confidence.toFixed(0)}%</b></span>
    </div>
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-black/30">
      <div className="confidence-bar" style={{ width: `${confidence}%` }} />
    </div>
    <div className="mt-1 flex justify-end text-[8px] font-mono tracking-wider text-slate-500">ENTRY GATE · {(confidenceThreshold * 100).toFixed(0)}%</div>
    {agent.openTrade && (
      <div className="mt-3 flex justify-between rounded-lg border border-cyan-300/20 bg-cyan-300/[0.06] px-2.5 py-2 text-[9px] text-slate-300 font-mono">
        <span>SL <b className="ml-1 text-rose-300">{formatVal(agent.openTrade.stopLossPrice, currency)}</b></span>
        <span>TP <b className="ml-1 text-emerald-300">{formatVal(agent.openTrade.takeProfitPrice, currency)}</b></span>
      </div>
    )}
    <div className="mt-3 flex items-start gap-2 border-t border-white/[0.06] pt-2.5 text-[9px] leading-4 text-slate-400">
      <span className="mt-0.5 text-violet-300"><Sparkles className="h-3 w-3" /></span>
      <p className="line-clamp-2">{call?.reason.join(' ') || agent.lastReason}{currency === 'USDT' && !agent.openTrade ? ` · Evaluating ${call?.scanningSymbol || 'BTC · ETH · SOL'} each engine tick` : ''}{call?.liveAnalysisAt ? ` · Updated ${new Date(call.liveAnalysisAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` : ''}</p>
    </div>
    <div className="mt-2.5 pt-2 border-t border-white/[0.08] flex items-center justify-between text-[10px] font-bold text-cyan-300/90 group-hover:text-cyan-200">
      <span className="flex items-center gap-1.5">
        <Crosshair className="h-3.5 w-3.5 text-cyan-400" />
        {agent.openTrade ? 'View Live Chart, SL/TP & Telemetry' : 'Inspect Conditions Met vs Needed'}
      </span>
      <span>→</span>
    </div>
  </article>;
}

export default function StrategyAgentsPage() {
  const [marketMode, setMarketMode] = useState<'INDIAN' | 'CRYPTO'>('CRYPTO');
  const [competition, setCompetition] = useState<Competition | null>(null);
  const [validationReport, setValidationReport] = useState<ValidationReport | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [backtestStartDate, setBacktestStartDate] = useState(() => localDateInput(-6));
  const [backtestEndDate, setBacktestEndDate] = useState(() => localDateInput());
  const [backtestBudgets, setBacktestBudgets] = useState<Record<string, string>>(() => Object.fromEntries(Object.values(AGENT_CONFIGS).map((agent) => [agent.key, '1000'])));
  const [backtestRunning, setBacktestRunning] = useState(false);
  const [backtestProgress, setBacktestProgress] = useState<CryptoBacktestProgress | null>(null);
  const [backtestError, setBacktestError] = useState('');
  const [cryptoBacktest, setCryptoBacktest] = useState<CryptoBacktestResponse | null>(null);

  const fetchCompetition = useCallback(async (mode = marketMode) => {
    try {
      const response = await fetch(`/api/strategy-agents?mode=${mode}`, { cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load strategy session.');
      setCompetition(payload.competition);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load strategy session.');
    } finally {
      setLoading(false);
    }
  }, [marketMode]);

  const handleModeSwitch = (newMode: 'INDIAN' | 'CRYPTO') => {
    setMarketMode(newMode);
    setSelectedAgentId(null);
    setLoading(true);
    fetchCompetition(newMode);
  };

  const runTick = useCallback(async (id: string) => {
    try {
      const response = await fetch(`/api/strategy-agents/${id}/tick`, { method: 'POST', cache: 'no-store' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Live market update failed.');
      if (payload.competition) setCompetition(payload.competition);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Live market update failed.');
    }
  }, []);

  useEffect(() => { fetchCompetition(); }, [fetchCompetition]);
  useEffect(() => { fetch('/api/strategy-agents/backtest', { cache: 'no-store' }).then(response => response.json()).then(payload => setValidationReport(payload.report || null)).catch(() => setValidationReport(null)); }, []);

  const competitionId = competition?.id;
  const competitionStatus = competition?.status;
  const tickInterval = competition?.marketType === 'CRYPTO' ? 3_000 : 15_000;
  useEffect(() => {
    if (!competitionId || !competitionStatus || !activeStatuses.includes(competitionStatus)) return;
    runTick(competitionId);
    const timer = setInterval(() => runTick(competitionId), tickInterval);
    return () => clearInterval(timer);
  }, [competitionId, competitionStatus, runTick, tickInterval]);

  const start = async () => {
    setWorking(true); setError('');
    try {
      const response = await fetch('/api/strategy-agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: marketMode }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not start strategy agents.');
      setCompetition(payload.competition);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start strategy agents.');
    } finally { setWorking(false); }
  };

  const stop = async () => {
    if (!competition) return;
    setWorking(true); setError('');
    try {
      const response = await fetch(`/api/strategy-agents/${competition.id}/stop`, { method: 'POST' });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not stop strategy agents.');
      setCompetition(payload.competition);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not stop strategy agents.');
    } finally { setWorking(false); }
  };

  const runCryptoBacktest = async () => {
    setBacktestRunning(true);
    setBacktestProgress({ phase: 'download', percentage: 0, message: 'Starting 1-minute candle downloads…' });
    setBacktestError('');
    setCryptoBacktest(null);
    try {
      const response = await fetch('/api/strategy-agents/crypto-backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ startDate: backtestStartDate, endDate: backtestEndDate, budgets: Object.fromEntries(Object.entries(backtestBudgets).map(([key, value]) => [key, Number(value)])) }),
      });
      if (!response.ok) {
        const payload = await response.json();
        throw new Error(payload.error || 'Crypto backtest failed.');
      }
      if (!response.body) throw new Error('Progress stream is unavailable for this backtest.');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let resultReceived = false;
      const processEvent = (event: string) => {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data) return;
        const message = JSON.parse(data) as { type: string; phase?: 'download' | 'backtest'; percentage?: number; message?: string; payload?: CryptoBacktestResponse };
        if (message.type === 'progress' && message.phase && message.message) {
          setBacktestProgress({ phase: message.phase, percentage: Math.max(0, Math.min(100, message.percentage ?? 0)), message: message.message });
        } else if (message.type === 'result' && message.payload) {
          setCryptoBacktest(message.payload);
          setBacktestProgress({ phase: 'backtest', percentage: 100, message: 'Backtest complete.' });
          resultReceived = true;
        } else if (message.type === 'error') {
          throw new Error(message.message || 'Crypto backtest failed.');
        }
      };
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let boundary = buffer.search(/\r?\n\r?\n/);
        while (boundary >= 0) {
          const event = buffer.slice(0, boundary);
          const delimiter = buffer.slice(boundary).match(/^\r?\n\r?\n/)?.[0].length || 2;
          buffer = buffer.slice(boundary + delimiter);
          processEvent(event);
          boundary = buffer.search(/\r?\n\r?\n/);
        }
        if (done) break;
      }
      if (buffer.trim()) processEvent(buffer);
      if (!resultReceived) throw new Error('The backtest stream ended before results were received.');
    } catch (reason) {
      setBacktestError(reason instanceof Error ? reason.message : 'Crypto backtest failed.');
    } finally {
      setBacktestRunning(false);
    }
  };

  const active = !!competition && activeStatuses.includes(competition.status);
  const isCrypto = marketMode === 'CRYPTO';
  const currency = competition?.currency || (isCrypto ? 'USDT' : 'INR');
  const leagueCapital = competition ? competition.initialCapital * competition.portfolioLeaderboard.length : 0;

  return (
    <div className="arena-page flex min-h-screen flex-col font-sans text-slate-100">
      <Navbar />
      <div className="flex flex-1">
        <div className="hidden shrink-0 lg:block">
          <Sidebar />
        </div>
        <main className="arena-shell mx-auto w-full max-w-7xl flex-1 space-y-5 p-4 sm:p-5 lg:space-y-6 lg:p-7">
          {/* Market Mode Switcher Banner */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#0c101d] p-3 shadow-xl backdrop-blur-md">
            <div className="flex items-center gap-2.5">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-300">
                <Globe className="h-4 w-4" />
              </span>
              <div>
                <span className="block text-[10px] font-black uppercase tracking-[0.2em] text-slate-400">Arena Market Mode</span>
                <span className="text-xs font-semibold text-slate-200">
                  {isCrypto ? '24/7 Global Crypto (Binance & Yahoo Feed)' : 'Indian Equity & Derivatives (NSE/BSE)'}
                </span>
              </div>
            </div>
            <div className="flex rounded-xl border border-white/10 bg-black/50 p-1">
              <button
                onClick={() => handleModeSwitch('INDIAN')}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
                  !isCrypto ? 'bg-gradient-to-r from-amber-500 to-orange-600 text-white shadow-lg' : 'text-slate-400 hover:text-white'
                }`}
              >
                <span>🇮🇳</span> Indian NSE/BSE
              </button>
              <button
                onClick={() => handleModeSwitch('CRYPTO')}
                className={`flex items-center gap-2 rounded-lg px-3.5 py-1.5 text-xs font-bold transition-all ${
                  isCrypto ? 'bg-gradient-to-r from-cyan-400 to-blue-600 text-white shadow-lg shadow-cyan-500/25' : 'text-slate-400 hover:text-white'
                }`}
              >
                <span>🌐</span> Crypto 24/7 (BTC · ETH · SOL)
              </button>
            </div>
          </div>

          <nav className="arena-subnav" aria-label="Arena navigation">
            <a href="#arena-home" className="arena-subnav-active">Arena</a>
            <a href="#strategy-units">Strategy Units</a>
            <a href="#leaderboards">Leaderboard</a>
            <a href="/backtest">Analytics</a>
            <a href="/portfolio">Portfolio</a>
          </nav>

          <header id="arena-home" className="arena-hero">
            <div className="arena-landscape" aria-hidden="true"><span className="arena-mountain arena-mountain-back" /><span className="arena-mountain arena-mountain-front" /><span className="arena-city" /></div>
            <div className="arena-hero-grid" />
            <div className="relative z-10 flex flex-wrap items-end justify-between gap-5">
              <div className="max-w-3xl">
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <span className="arena-kicker"><Flame className="h-3.5 w-3.5" /> LIVE STRATEGY ARENA</span>
                  <span className="arena-mode">
                    <span className="arena-live-dot" /> {isCrypto ? '24/7 CRYPTO LEAGUE · 1,000 USDT / AGENT' : 'NSE/BSE PAPER LEAGUE · 10L INR / AGENT'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
                  <h1 className="arena-title">TRADEX <span>{isCrypto ? 'CRYPTO 24/7' : 'INDIA ARENA'}</span></h1>
                  {isCrypto && <div className="flex flex-wrap items-end gap-2 rounded-xl border border-cyan-300/15 bg-slate-950/60 p-2.5">
                    <label className="grid gap-1 text-[8px] font-black uppercase tracking-widest text-slate-400">Start date · UTC<input type="date" value={backtestStartDate} max={backtestEndDate || localDateInput()} onChange={(event) => setBacktestStartDate(event.target.value)} className="h-8 rounded-md border border-white/10 bg-[#101625] px-2 text-[11px] font-semibold text-white [color-scheme:dark]" /></label>
                    <label className="grid gap-1 text-[8px] font-black uppercase tracking-widest text-slate-400">End date · UTC<input type="date" value={backtestEndDate} min={backtestStartDate} max={localDateInput()} onChange={(event) => setBacktestEndDate(event.target.value)} className="h-8 rounded-md border border-white/10 bg-[#101625] px-2 text-[11px] font-semibold text-white [color-scheme:dark]" /></label>
                    <button type="button" onClick={runCryptoBacktest} disabled={backtestRunning} className="arena-button arena-button-start h-8 px-3 text-[9px] disabled:cursor-wait disabled:opacity-60"><Target className="h-3.5 w-3.5" />{backtestRunning ? 'DOWNLOADING & RUNNING…' : 'RUN BACKTEST'}</button>
                    <span className="basis-full text-[9px] text-slate-500">Up to 730 days of 1-minute data · long ranges may take several minutes</span>
                  </div>}
                </div>
                <p className="mt-2 max-w-2xl text-xs leading-5 text-slate-300/80 sm:text-sm">
                  {isCrypto
                    ? 'Ten autonomous units scanning Bitcoin (BTC), Ethereum (ETH), and Solana (SOL) 24/7/365. Live market data from Binance & Yahoo Finance. Each unit starts with 1,000 USDT in its isolated paper wallet.'
                    : 'Ten strategy units scanning NIFTY, BANKNIFTY, and SENSEX. Choosing liquid near-ATM options when signals align. Each unit holds ₹10,00,000 INR in its isolated paper wallet.'}
                </p>
                {isCrypto && <details open className="mt-3 rounded-xl border border-white/10 bg-slate-950/45 p-3">
                  <summary className="cursor-pointer text-[10px] font-black uppercase tracking-widest text-cyan-100">Starting budget for each agent · USDT <span className="ml-1 font-normal normal-case tracking-normal text-slate-500">(defaults to 1,000 each)</span></summary>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-5">
                    {Object.values(AGENT_CONFIGS).map((agent) => <label key={agent.key} className="grid gap-1 text-[8px] font-bold uppercase tracking-wide text-slate-400"><span className="truncate" title={agent.fullName}>{agent.fullName}</span><input type="number" min="1" max="1000000000" step="0.01" inputMode="decimal" value={backtestBudgets[agent.key] || ''} onChange={(event) => setBacktestBudgets((current) => ({ ...current, [agent.key]: event.target.value }))} className="h-8 rounded-md border border-white/10 bg-[#101625] px-2 font-mono text-[11px] text-white" /></label>)}
                  </div>
                </details>}
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-[9px] font-bold uppercase tracking-[0.16em] text-slate-400">
                  <span className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full ${competition?.status === 'RUNNING' ? 'arena-live-dot' : 'bg-amber-300'}`} />
                    {statusLabel(competition?.status, isCrypto)}
                  </span>
                  <span className="hidden h-3 w-px bg-white/15 sm:block" />
                  <span>{isCrypto ? 'NON-STOP 24/7 EVALUATION · ZERO MARKET LOCK' : 'SESSION STARTS AUTOMATICALLY ON PAGE OPEN'}</span>
                </div>
              </div>
              <div className="relative z-10 flex w-full gap-2 sm:w-auto">
                {active ? (
                  <button disabled={working} onClick={stop} className="arena-button arena-button-stop">
                    <CircleStop className="h-4 w-4" />{working ? 'STOPPING…' : 'END SESSION'}
                  </button>
                ) : (
                  <button disabled={working || loading} onClick={start} className="arena-button arena-button-start">
                    <Play className="h-4 w-4 fill-white" />{working ? 'SPAWNING…' : 'START ARENA'}
                  </button>
                )}
                <button onClick={() => fetchCompetition()} className="arena-icon-button" aria-label="Refresh leaderboard">
                  <RefreshCw className="h-4 w-4" />
                </button>
              </div>
            </div>
            <div className="arena-hero-footer">
              <span><Zap className="h-3.5 w-3.5 text-cyan-300" /> NO SIGNAL, NO TRADE</span>
              <span>{isCrypto ? '24/7 NON-STOP' : '09:15 IST OPEN'}</span>
              <span>RISK RULES ACTIVE</span>
            </div>
          </header>

          {isCrypto && (backtestRunning || backtestError || cryptoBacktest) && <section className="game-panel overflow-hidden border-cyan-300/15">
            <div className="border-b border-white/[0.06] px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div><div className="flex items-center gap-2"><Target className="h-4 w-4 text-cyan-200" /><h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">Crypto Backtest · 1m Execution / 5m Signals</h2></div><p className="mt-1 text-[10px] text-slate-400">Each strategy runs independently with its own starting USDT budget and no leverage above 1×.</p></div>
                {backtestRunning && <span className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-cyan-200"><RefreshCw className="h-3.5 w-3.5 animate-spin" /> {backtestProgress?.phase === 'backtest' ? 'BACKTESTING STRATEGIES' : 'DOWNLOADING CANDLES'}</span>}
              </div>
              {backtestRunning && <div className="mt-4">
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px]"><span className="text-slate-300">{backtestProgress?.message || 'Preparing backtest…'}</span><span className="font-mono font-bold text-cyan-200">{Math.floor(backtestProgress?.percentage || 0)}%</span></div>
                <div className="h-2 overflow-hidden rounded-full border border-cyan-300/15 bg-black/40"><div className="h-full rounded-full bg-gradient-to-r from-cyan-400 via-blue-400 to-fuchsia-400 shadow-[0_0_14px_rgba(34,211,238,0.65)] transition-[width] duration-300" style={{ width: `${backtestProgress?.percentage || 0}%` }} /></div>
              </div>}
            </div>
            {backtestError && <div className="m-4 rounded-xl border border-rose-400/20 bg-rose-500/[0.07] p-3 text-xs text-rose-200">{backtestError}</div>}
            {cryptoBacktest && <>
              <div className="flex flex-wrap gap-x-5 gap-y-2 border-b border-white/[0.06] px-5 py-3 text-[10px] text-slate-300">
                <span>Requested UTC range: <b className="font-mono text-white">{cryptoBacktest.requestedRange.startDate} to {cryptoBacktest.requestedRange.endDate}</b></span>
                <span>Aligned 1m candles: <b className="font-mono text-white">{cryptoBacktest.backtest.candleCount.toLocaleString()}</b></span>
                {cryptoBacktest.data.map((item) => <span key={item.symbol}>{item.symbol}: <b className="font-mono text-white">{item.candles.toLocaleString()}</b></span>)}
              </div>
              <p className="px-5 pt-3 text-[10px] leading-5 text-slate-500">{cryptoBacktest.backtest.methodology}</p>
              <div className="overflow-x-auto p-3 sm:p-4">
                <table className="w-full min-w-[1200px] text-left text-[10px]">
                  <thead className="text-[8px] uppercase tracking-widest text-slate-500"><tr><th className="px-2 py-2">Strategy</th><th className="px-2 py-2 text-right">Budget</th><th className="px-2 py-2 text-right">Final Balance</th><th className="px-2 py-2 text-right">Net P&amp;L</th><th className="px-2 py-2 text-right">Return</th><th className="px-2 py-2 text-right">Trades</th><th className="px-2 py-2 text-right">Win Rate</th><th className="px-2 py-2 text-right">Profit Factor</th><th className="px-2 py-2 text-right">Max DD</th><th className="px-2 py-2 text-right">Fees</th><th className="px-2 py-2">Trades by pair</th><th className="px-2 py-2">Recent fills</th></tr></thead>
                  <tbody className="divide-y divide-white/[0.05]">{cryptoBacktest.backtest.results.map((result) => <tr key={result.key} className="text-slate-300">
                    <td className="px-2 py-2.5 font-bold text-white">{getAgentMeta(result.key).fullName}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{formatUSDT(result.initialBudget)}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{formatUSDT(result.finalBalance)}</td>
                    <td className={`px-2 py-2.5 text-right font-mono ${result.netPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{result.netPnl > 0 ? '+' : ''}{formatUSDT(result.netPnl)}</td>
                    <td className={`px-2 py-2.5 text-right font-mono ${result.returnPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{result.returnPct > 0 ? '+' : ''}{result.returnPct.toFixed(2)}%</td>
                    <td className="px-2 py-2.5 text-right font-mono">{result.trades}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{result.trades ? `${result.winRate}%` : '—'}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{result.profitFactor ?? (result.trades ? '∞' : '—')}</td>
                    <td className="px-2 py-2.5 text-right font-mono">{result.maxDrawdownPct.toFixed(2)}%</td>
                    <td className="px-2 py-2.5 text-right font-mono">{formatUSDT(result.fees)}</td>
                    <td className="px-2 py-2.5 font-mono text-[9px]">BTC {result.bySymbol.BTC} · ETH {result.bySymbol.ETH} · SOL {result.bySymbol.SOL}</td>
                    <td className="px-2 py-2.5">{result.recentTrades.length ? <details><summary className="cursor-pointer text-cyan-200">View {result.recentTrades.length}</summary><div className="absolute z-20 mt-1 max-h-52 w-80 overflow-auto rounded-lg border border-white/10 bg-[#0c101d] p-2 shadow-xl">{result.recentTrades.map((trade, index) => <div key={`${trade.entryTime}-${index}`} className="border-b border-white/[0.05] py-1.5 text-[9px]"><b className="text-white">{trade.symbol}</b> · <span className={trade.side === 'LONG' ? 'text-emerald-300' : 'text-rose-300'}>{trade.side}</span> · {new Date(trade.entryTime).toLocaleString()} · P&amp;L <span className={trade.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{formatUSDT(trade.pnl)}</span><div className="text-slate-500">{trade.exitReason} · qty {trade.quantity}</div></div>)}</div></details> : <span className="text-slate-600">No trades</span>}</td>
                  </tr>)}</tbody>
                </table>
              </div>
            </>}
          </section>}

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="arena-hud-card hud-violet"><span className="hud-icon"><Crosshair className="h-4 w-4" /></span><div><span className="hud-label">ARENA STATUS</span><strong>{statusLabel(competition?.status, isCrypto)}</strong></div><span className="hud-corner">01</span></div>
            <div className="arena-hud-card hud-cyan"><span className="hud-icon"><Target className="h-4 w-4" /></span><div><span className="hud-label">MARKETS TRACKED</span><strong>{isCrypto ? 'BTC · ETH · SOL (24/7)' : 'NIFTY · BANKNIFTY · SENSEX'}</strong></div><span className="hud-corner">03</span></div>
            <div className="arena-hud-card hud-emerald"><span className="hud-icon"><Trophy className="h-4 w-4" /></span><div><span className="hud-label">LEAGUE CAPITAL</span><strong>{formatVal(leagueCapital, currency)} <small>assigned across agents</small></strong></div><span className="hud-corner">10</span></div>
            <div className="arena-hud-card hud-amber"><span className="hud-icon"><Flame className="h-4 w-4" /></span><div><span className="hud-label">LAST SYNC</span><strong title={competition?.latestPriceAt || competition?.lastTickAt || undefined}>{competition?.latestPriceAt || competition?.lastTickAt ? new Date(competition.latestPriceAt || competition.lastTickAt!).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' }) + ' IST' : 'WAITING FOR FEED'}</strong></div><span className="hud-corner"><span className="arena-live-dot" /></span></div>
          </div>

          <div className="arena-info-strip">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-cyan-200" />
            <div>
              <strong>INTERACTIVE ARENA.</strong> Click on any agent card or leaderboard row below to inspect its <strong>real-time candlestick chart</strong>, visual <strong>SL / TP drawing levels</strong>, <strong>invested amount</strong>, <strong>balance left</strong>, or the detailed checklist of <strong>conditions met vs needed</strong>.
            </div>
            <span className="hidden shrink-0 rounded-lg border border-cyan-300/15 bg-cyan-300/[0.06] px-2.5 py-1.5 text-[9px] font-black tracking-widest text-cyan-100 sm:block">CLICK TO INSPECT</span>
          </div>

          {competition?.lastError && active && <div className="arena-alert"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><span>{competition.lastError}</span></div>}
          {error && <div className="arena-alert arena-alert-error"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
          {loading && <div className="game-panel animate-pulse p-8 text-center text-sm text-slate-400"><Sparkles className="mx-auto mb-3 h-6 w-6 text-violet-300" />Loading your {isCrypto ? 'crypto' : 'Indian'} strategy units…</div>}
          
          {!isCrypto && validationReport && (
            <section className="game-panel overflow-hidden">
              <div className="border-b border-white/[0.06] px-5 py-4">
                <div className="flex items-center gap-2"><Target className="h-4 w-4 text-amber-200" /><h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">Training Grounds · Validation</h2></div>
                <p className="mt-1 text-[11px] text-amber-200/80">NIFTY spot proxy only; not option validation. {validationReport.methodology?.entryGate || 'Entries require at least a 65% rule score from 09:20 IST.'} Test period {validationReport.strategies[0]?.periods.testing.from || '—'} to {validationReport.strategies[0]?.periods.testing.to || '—'} · {validationReport.data.tradingDays} sessions · {validationReport.data.candles.toLocaleString()} candles.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-xs">
                  <thead className="bg-black/20 text-[9px] uppercase tracking-wider text-slate-500">
                    <tr><th className="px-3 py-2.5">Strategy</th><th className="px-3 py-2.5 text-right">Trades</th><th className="px-3 py-2.5 text-right">Win rate</th><th className="px-3 py-2.5 text-right">Profit factor</th><th className="px-3 py-2.5 text-right">Test return</th><th className="px-3 py-2.5 text-right">Max drawdown</th><th className="px-3 py-2.5 text-right">Average R</th><th className="px-3 py-2.5 text-right">Sharpe</th><th className="px-3 py-2.5 text-right">Hold (min)</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {validationReport.strategies.map(strategy => {
                      const m = strategy.periods.testing.metrics;
                      return <tr key={strategy.strategy} className="text-slate-300">
                        <td className="px-3 py-2.5 font-semibold text-white">{strategy.strategy}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.numberOfTrades}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.numberOfTrades ? `${m.winRate}%` : '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.profitFactor ?? '—'}</td>
                        <td className={`px-3 py-2.5 text-right font-mono ${m.totalReturnPct >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{m.numberOfTrades ? `${m.totalReturnPct}%` : '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.numberOfTrades ? `${m.maxDrawdownPct}%` : '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.numberOfTrades ? m.averageR : '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.numberOfTrades ? m.sharpeRatio : '—'}</td>
                        <td className="px-3 py-2.5 text-right font-mono">{m.numberOfTrades ? m.averageHoldingMinutes : '—'}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {competition && (
            <>
              <div id="leaderboards" className="grid gap-4 xl:grid-cols-2">
                <Leaderboard 
                  title="Portfolio Balance Leaderboard" 
                  agents={competition.portfolioLeaderboard} 
                  metric="equity" 
                  currency={currency} 
                  onSelect={(id) => setSelectedAgentId(id)}
                />
                <Leaderboard 
                  title="24h Session Profit Leaderboard" 
                  agents={competition.dailyProfitLeaderboard} 
                  metric="dailyPnL" 
                  currency={currency} 
                  onSelect={(id) => setSelectedAgentId(id)}
                  isSessionLeaderboard={true}
                />
              </div>

              <section id="strategy-units" className="game-panel overflow-hidden">
                <div className="flex flex-wrap items-end justify-between gap-3 border-b border-white/[0.06] px-5 py-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <Bot className="h-4 w-4 text-violet-200" />
                      <h2 className="text-sm font-black uppercase tracking-[0.12em] text-white">The Strategy Roster ({currency})</h2>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-500">
                      Ten autonomous units · {isCrypto ? 'BTC/USDT, ETH/USDT, SOL/USDT' : 'NIFTY, BANKNIFTY, SENSEX'} · {formatVal(competition.initialCapital, currency)} per unit · Click card to inspect
                    </p>
                  </div>
                  <span className="rounded-full border border-violet-300/15 bg-violet-300/[0.06] px-2.5 py-1 text-[9px] font-black tracking-widest text-violet-100">
                    {competition.portfolioLeaderboard.length} / 10 UNITS
                  </span>
                </div>
                <div className="agent-grid p-3 sm:p-4">
                  {competition.portfolioLeaderboard.map((agent, index) => (
                    <AgentCard 
                      key={agent.id} 
                      agent={agent} 
                      index={index} 
                      currency={currency} 
                      confidenceThreshold={competition.confidenceThreshold}
                      onSelect={(id) => setSelectedAgentId(id)}
                    />
                  ))}
                </div>
              </section>
            </>
          )}

          {!loading && !competition && (
            <div className="rounded-xl border border-border bg-[#0e1320] p-8 text-center">
              <Bot className="mx-auto h-8 w-8 text-slate-600" />
              <p className="mt-3 text-sm text-slate-300">No {isCrypto ? 'crypto' : 'Indian'} strategy session yet</p>
              <p className="mt-1 text-xs text-slate-500">Start the arena to create ten separately funded paper portfolios in {isCrypto ? 'USDT' : 'INR'}.</p>
            </div>
          )}
        </main>
      </div>

      {/* Interactive Agent Telemetry Modal */}
      {selectedAgentId && competition && (
        <AgentDetailModal
          key={`${competition.id}:${selectedAgentId}`}
          competitionId={competition.id}
          agentId={selectedAgentId}
          rank={competition.portfolioLeaderboard.find((agent) => agent.id === selectedAgentId)?.rank}
          onClose={() => setSelectedAgentId(null)}
        />
      )}
    </div>
  );
}
