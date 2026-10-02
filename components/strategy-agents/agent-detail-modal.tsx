'use client';

import React, { useEffect, useState } from 'react';
import { 
  X, Bot, ShieldCheck, TrendingUp, TrendingDown, Target, 
  CheckCircle2, Clock, AlertCircle, ArrowUpRight, ArrowDownRight, 
  Zap, DollarSign, Wallet, Layers, Award, Sparkles, RefreshCw
} from 'lucide-react';
import { CandlestickChart } from '@/components/charts/candlestick-chart';
import { formatINR, formatUSDT } from '@/lib/utils';
import type { Candle, CandleInterval } from '@/types/market';

interface DrawingLevel {
  type: string;
  price: number;
  label: string;
  color: string;
}

interface AgentTelemetryPayload {
  agent: {
    id: string;
    key: string;
    name: string;
    description: string;
    currency: string;
    initialCapital: number;
    cashBalance: number;
    realizedPnL: number;
    dailyRealizedPnL: number;
    entriesToday: number;
    isPaused: boolean;
  };
  inTrade: boolean;
  tradeDetails?: {
    id: string;
    symbol: string;
    side: 'LONG' | 'SHORT';
    quantity: number;
    entryPrice: number;
    currentPrice: number;
    stopLossPrice: number;
    takeProfitPrice: number;
    slDistance: number;
    slDistancePct: number;
    tpDistance: number;
    tpDistancePct: number;
    investedAmount: number;
    balanceLeft: number;
    unrealizedPnL: number;
    unrealizedPnLPct: number;
    riskReward: string;
    entryReason: string;
    openedAt: string;
  };
  conditionReport?: {
    strategyKey: string;
    strategyName: string;
    symbol: string;
    currentPrice: number;
    marketRegime: string;
    confidence: number;
    confidenceThreshold: number;
    conditionsMet: Array<{ label: string; detail: string; status: 'MET' }>;
    conditionsNeeded: Array<{ label: string; detail: string; status: 'PENDING' }>;
    supportPrice: number;
    resistancePrice: number;
    ema20: number | null;
    ema50: number | null;
    rsi14: number | null;
    atr14: number | null;
    thesis: string;
  };
  drawingLevels: DrawingLevel[];
  candles: Candle[];
  assetSymbol: string;
}

interface AgentDetailModalProps {
  competitionId: string;
  agentId: string;
  onClose: () => void;
}

export function AgentDetailModal({ competitionId, agentId, onClose }: AgentDetailModalProps) {
  const [data, setData] = useState<AgentTelemetryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [interval, setInterval] = useState<CandleInterval>('5m');

  const fetchTelemetry = async () => {
    try {
      const res = await fetch(`/api/strategy-agents/${competitionId}/agent/${agentId}`, { cache: 'no-store' });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload.error || 'Failed to load telemetry.');
      setData(payload);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error loading details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTelemetry();
    const timer = window.setInterval(fetchTelemetry, 10_000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [competitionId, agentId]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const currency = data?.agent.currency || 'INR';
  const formatMoney = (val: number) => {
    if (currency === 'USDT') return formatUSDT(val);
    return formatINR(val);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-5 bg-black/80 backdrop-blur-md overflow-y-auto animate-in fade-in duration-200">
      <div 
        className="relative w-full max-w-5xl rounded-3xl border border-white/10 bg-[#0a0e19] shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-white/[0.08] px-6 py-4 bg-[#0d1222]">
          <div className="flex items-center gap-3">
            <span className="flex h-11 w-11 items-center justify-center rounded-2xl border border-violet-400/30 bg-violet-500/10 text-violet-300 shadow-inner">
              <Bot className="h-6 w-6" />
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-black text-white tracking-wide">
                  {data?.agent.name || 'Strategy Unit Telemetry'}
                </h2>
                {data && (
                  <span className={`px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider border ${
                    data.inTrade 
                      ? 'bg-cyan-500/10 text-cyan-300 border-cyan-400/30 animate-pulse'
                      : 'bg-violet-500/10 text-violet-300 border-violet-400/30'
                  }`}>
                    {data.inTrade ? `IN POSITION · ${data.tradeDetails?.side}` : 'SCANNING FOR ENTRY'}
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{data?.agent.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={fetchTelemetry}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
              title="Refresh Telemetry"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-xl text-slate-400 hover:text-white hover:bg-white/[0.06] transition-colors"
              title="Close modal"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Modal Content */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6 custom-scrollbar">
          {loading && !data && (
            <div className="py-20 text-center text-slate-400 animate-pulse">
              <Sparkles className="mx-auto h-8 w-8 text-violet-300 mb-3" />
              Loading real-time market telemetry & strategy analysis...
            </div>
          )}

          {error && (
            <div className="p-4 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-300 text-xs flex items-center gap-2">
              <AlertCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          {data && (
            <>
              {/* Telemetry Overview Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="p-3.5 rounded-2xl border border-white/[0.06] bg-[#0f1527]">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Assigned Capital</span>
                  <strong className="text-sm sm:text-base font-extrabold text-white mt-1 block font-mono">
                    {formatMoney(data.agent.initialCapital)}
                  </strong>
                  <span className="text-[10px] text-slate-500">Isolated 10 Lakh {currency}</span>
                </div>

                <div className="p-3.5 rounded-2xl border border-white/[0.06] bg-[#0f1527]">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Available Cash</span>
                  <strong className="text-sm sm:text-base font-extrabold text-emerald-300 mt-1 block font-mono">
                    {formatMoney(data.agent.cashBalance)}
                  </strong>
                  <span className="text-[10px] text-slate-500">Unallocated liquidity</span>
                </div>

                <div className="p-3.5 rounded-2xl border border-white/[0.06] bg-[#0f1527]">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Realized P&L</span>
                  <strong className={`text-sm sm:text-base font-extrabold mt-1 block font-mono ${
                    data.agent.realizedPnL >= 0 ? 'text-emerald-300' : 'text-rose-400'
                  }`}>
                    {data.agent.realizedPnL >= 0 ? '+' : ''}{formatMoney(data.agent.realizedPnL)}
                  </strong>
                  <span className="text-[10px] text-slate-500">{data.agent.entriesToday} trades today</span>
                </div>

                <div className="p-3.5 rounded-2xl border border-white/[0.06] bg-[#0f1527]">
                  <span className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">Risk Lock Status</span>
                  <strong className="text-sm sm:text-base font-extrabold text-slate-200 mt-1 block">
                    {data.agent.isPaused ? '🔒 LOCKED (2% Max)' : '🟢 NORMAL OPERATION'}
                  </strong>
                  <span className="text-[10px] text-slate-500">2% max daily protection</span>
                </div>
              </div>

              {/* LIVE TRADE TERMS (When in a Trade) */}
              {data.inTrade && data.tradeDetails && (
                <div className="rounded-3xl border border-cyan-500/30 bg-gradient-to-b from-cyan-950/20 to-[#0c1222] p-5 sm:p-6 shadow-xl space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-cyan-500/20 pb-3">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-400/20 text-cyan-300">
                        <Zap className="h-4 w-4" />
                      </span>
                      <h3 className="text-sm font-black text-white uppercase tracking-wider">
                        Live Trade Execution Terms · {data.tradeDetails.symbol}
                      </h3>
                    </div>
                    <span className="px-3 py-1 rounded-full text-xs font-mono font-bold bg-cyan-400/10 text-cyan-200 border border-cyan-400/30">
                      Side: {data.tradeDetails.side} ({data.tradeDetails.quantity} units)
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="p-3 rounded-xl bg-black/40 border border-cyan-500/20">
                      <span className="block text-[10px] font-bold uppercase text-slate-400">Invested Capital</span>
                      <strong className="text-sm sm:text-base font-mono font-bold text-cyan-200 mt-0.5 block">
                        {formatMoney(data.tradeDetails.investedAmount)}
                      </strong>
                      <span className="text-[9px] text-slate-500">Locked in trade</span>
                    </div>

                    <div className="p-3 rounded-xl bg-black/40 border border-cyan-500/20">
                      <span className="block text-[10px] font-bold uppercase text-slate-400">Balance Left</span>
                      <strong className="text-sm sm:text-base font-mono font-bold text-emerald-300 mt-0.5 block">
                        {formatMoney(data.tradeDetails.balanceLeft)}
                      </strong>
                      <span className="text-[9px] text-slate-500">Unallocated buffer</span>
                    </div>

                    <div className="p-3 rounded-xl bg-black/40 border border-rose-500/30">
                      <span className="block text-[10px] font-bold uppercase text-rose-300">Stop Loss (SL)</span>
                      <strong className="text-sm sm:text-base font-mono font-bold text-rose-300 mt-0.5 block">
                        {formatMoney(data.tradeDetails.stopLossPrice)}
                      </strong>
                      <span className="text-[9px] text-rose-400/80">-{data.tradeDetails.slDistancePct.toFixed(1)}% threshold</span>
                    </div>

                    <div className="p-3 rounded-xl bg-black/40 border border-emerald-500/30">
                      <span className="block text-[10px] font-bold uppercase text-emerald-300">Take Profit (TP)</span>
                      <strong className="text-sm sm:text-base font-mono font-bold text-emerald-300 mt-0.5 block">
                        {formatMoney(data.tradeDetails.takeProfitPrice)}
                      </strong>
                      <span className="text-[9px] text-emerald-400/80">+{data.tradeDetails.tpDistancePct.toFixed(1)}% target</span>
                    </div>
                  </div>

                  {/* Unrealized PnL & Explanation */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div className="p-3.5 rounded-xl bg-black/50 border border-white/10 flex flex-col justify-center">
                      <span className="text-[10px] font-bold uppercase text-slate-400">Unrealized P&L</span>
                      <div className="flex items-center gap-1.5 mt-1">
                        {data.tradeDetails.unrealizedPnL >= 0 ? (
                          <ArrowUpRight className="h-5 w-5 text-emerald-400" />
                        ) : (
                          <ArrowDownRight className="h-5 w-5 text-rose-400" />
                        )}
                        <span className={`text-lg font-mono font-black ${
                          data.tradeDetails.unrealizedPnL >= 0 ? 'text-emerald-300' : 'text-rose-400'
                        }`}>
                          {data.tradeDetails.unrealizedPnL >= 0 ? '+' : ''}{formatMoney(data.tradeDetails.unrealizedPnL)}
                        </span>
                        <span className="text-xs font-mono text-slate-400">
                          ({data.tradeDetails.unrealizedPnLPct.toFixed(2)}%)
                        </span>
                      </div>
                      <span className="text-[9px] text-slate-500 mt-1">Risk/Reward: 1 : {data.tradeDetails.riskReward}</span>
                    </div>

                    <div className="sm:col-span-2 p-3.5 rounded-xl bg-black/50 border border-white/10">
                      <span className="text-[10px] font-black uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-cyan-300" /> Entry Analysis & Strategy Thesis
                      </span>
                      <p className="text-xs text-slate-300 leading-5 mt-1.5 font-sans">
                        {data.tradeDetails.entryReason}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* CONDITIONS MET & CONDITIONS NEEDED (When NOT in a Trade) */}
              {!data.inTrade && data.conditionReport && (
                <div className="space-y-4">
                  <div className="p-4 rounded-2xl border border-white/10 bg-[#0e1424]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Market Regime</span>
                        <h4 className="text-sm font-bold text-white mt-0.5 flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${
                            data.conditionReport.marketRegime === 'BULLISH' ? 'bg-emerald-400' :
                            data.conditionReport.marketRegime === 'BEARISH' ? 'bg-rose-400' : 'bg-amber-400'
                          }`} />
                          {data.conditionReport.marketRegime} ({data.assetSymbol})
                        </h4>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Algorithm Confidence</span>
                        <div className="flex items-center gap-2 mt-0.5">
                          <span className="font-mono text-xs font-bold text-white">
                            {(data.conditionReport.confidence * 100).toFixed(0)}%
                          </span>
                          <span className="text-[10px] text-slate-500">/ 65% gate</span>
                        </div>
                      </div>
                    </div>
                    {/* Confidence Progress Bar */}
                    <div className="mt-2.5 h-2 rounded-full bg-black/50 overflow-hidden relative">
                      <div 
                        className={`h-full rounded-full transition-all duration-500 ${
                          data.conditionReport.confidence >= 0.65 
                            ? 'bg-gradient-to-r from-emerald-500 to-cyan-400' 
                            : 'bg-gradient-to-r from-amber-500 to-violet-400'
                        }`}
                        style={{ width: `${Math.min(100, data.conditionReport.confidence * 100)}%` }}
                      />
                      <div 
                        className="absolute top-0 bottom-0 w-0.5 bg-white shadow"
                        style={{ left: '65%' }}
                        title="Execution Gate (65%)"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Column 1: Conditions Met */}
                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-950/10 p-4 space-y-3">
                      <div className="flex items-center gap-2 text-emerald-300 font-bold text-xs uppercase tracking-wider border-b border-emerald-500/10 pb-2">
                        <CheckCircle2 className="h-4 w-4" />
                        Conditions Met ({data.conditionReport.conditionsMet.length})
                      </div>
                      <ul className="space-y-2.5">
                        {data.conditionReport.conditionsMet.map((c, i) => (
                          <li key={i} className="flex items-start gap-2.5 text-xs text-slate-200">
                            <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                            <div>
                              <strong className="text-white block font-semibold">{c.label}</strong>
                              <span className="text-[11px] text-slate-400 leading-4 block mt-0.5">{c.detail}</span>
                            </div>
                          </li>
                        ))}
                        {!data.conditionReport.conditionsMet.length && (
                          <li className="text-xs text-slate-500 italic">No primary conditions confirmed on current bar.</li>
                        )}
                      </ul>
                    </div>

                    {/* Column 2: Conditions Needed */}
                    <div className="rounded-2xl border border-amber-500/20 bg-amber-950/10 p-4 space-y-3">
                      <div className="flex items-center gap-2 text-amber-300 font-bold text-xs uppercase tracking-wider border-b border-amber-500/10 pb-2">
                        <Clock className="h-4 w-4" />
                        Conditions Needed to Meet ({data.conditionReport.conditionsNeeded.length})
                      </div>
                      <ul className="space-y-2.5">
                        {data.conditionReport.conditionsNeeded.map((c, i) => (
                          <li key={i} className="flex items-start gap-2.5 text-xs text-slate-200">
                            <span className="mt-0.5 h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
                            <div>
                              <strong className="text-white block font-semibold">{c.label}</strong>
                              <span className="text-[11px] text-slate-400 leading-4 block mt-0.5">{c.detail}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* CHART & DRAWING LEVELS OVERLAY */}
              <div className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Layers className="h-4 w-4 text-violet-400" />
                    <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300">
                      Real-Time Analysis Chart · {data.assetSymbol}
                    </h3>
                  </div>

                  {/* Active Visual Drawing Legend */}
                  <div className="flex flex-wrap items-center gap-2 text-[10px] font-mono">
                    {data.drawingLevels.map((lvl, idx) => (
                      <span 
                        key={idx} 
                        className="px-2 py-0.5 rounded-md border bg-black/40 flex items-center gap-1.5"
                        style={{ borderColor: `${lvl.color}40`, color: lvl.color }}
                      >
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: lvl.color }} />
                        {lvl.label}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl overflow-hidden border border-white/10 shadow-2xl">
                  <CandlestickChart
                    candles={data.candles}
                    symbol={data.assetSymbol}
                    interval={interval}
                    onIntervalChange={setInterval}
                    drawingLevels={data.drawingLevels}
                    livePrice={data.inTrade ? data.tradeDetails?.currentPrice : data.conditionReport?.currentPrice}
                    currency={currency}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
