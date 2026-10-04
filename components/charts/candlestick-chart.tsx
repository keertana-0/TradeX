'use client';

import React, { useState, useMemo } from 'react';
import { Candle, CandleInterval } from '@/types/market';
import { calculateEMA } from '@/lib/analysis/indicators/ema';
import { calculateSupertrend } from '@/lib/analysis/indicators/supertrend';
import { calculateBollingerBands } from '@/lib/analysis/indicators/bollinger';
import { calculateRSI } from '@/lib/analysis/indicators/rsi';
import { calculateMACD } from '@/lib/analysis/indicators/macd';

export interface ChartDrawingLevel {
  type: string;
  price: number;
  label: string;
  color: string;
  lineStyle?: 'solid' | 'dashed';
}

interface CandlestickChartProps {
  candles: Candle[];
  symbol: string;
  interval: CandleInterval;
  onIntervalChange: (interval: CandleInterval) => void;
  isLoading?: boolean;
  drawingLevels?: ChartDrawingLevel[];
  candlesByInterval?: Partial<Record<CandleInterval, Candle[]>>;
  livePrice?: number;
  livePriceIsStale?: boolean;
  dataStatus?: string;
  currency?: string;
}

export function CandlestickChart({
  candles,
  symbol,
  interval,
  onIntervalChange,
  isLoading,
  drawingLevels = [],
  candlesByInterval,
  livePrice,
  livePriceIsStale = false,
  dataStatus,
  currency,
}: CandlestickChartProps) {
  // Indicator toggles
  const [showEma20, setShowEma20] = useState(true);
  const [showEma50, setShowEma50] = useState(true);
  const [showSupertrend, setShowSupertrend] = useState(false);
  const [showBollinger, setShowBollinger] = useState(false);
  const [showRsi, setShowRsi] = useState(false);
  const [showMacd, setShowMacd] = useState(false);

  // Hover state for crosshair
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const intervals: CandleInterval[] = ['5m', '15m', '30m', '1h', '1D', '1W'];
  const availableIntervals = candlesByInterval
    ? intervals.filter((value) => (candlesByInterval[value]?.length || 0) > 0)
    : intervals;
  const chartCandles = candlesByInterval?.[interval] ?? candles;

  // Calculate indicator overlays
  const ema20 = useMemo(() => calculateEMA(chartCandles, 20), [chartCandles]);
  const ema50 = useMemo(() => calculateEMA(chartCandles, 50), [chartCandles]);
  const supertrend = useMemo(() => calculateSupertrend(chartCandles, 10, 3), [chartCandles]);
  const bollinger = useMemo(() => calculateBollingerBands(chartCandles, 20, 2), [chartCandles]);
  const rsi = useMemo(() => calculateRSI(chartCandles, 14), [chartCandles]);
  const macd = useMemo(() => calculateMACD(chartCandles, 12, 26, 9), [chartCandles]);

  // SVG Chart Dimensions
  const width = 850;
  const height = 400;
  const paddingRight = 75; // expanded to fit full price pill badges
  const paddingLeft = 10;
  const paddingTop = 25;
  const paddingBottom = 40;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const visibleCandles = chartCandles.slice(-50); // Show last 50 candles for clean display
  const offset = Math.max(0, chartCandles.length - 50);

  // Price range calculation with inclusion of drawing levels and live price
  const { minPrice, maxPrice, maxVolume } = useMemo(() => {
    if (visibleCandles.length === 0) return { minPrice: 0, maxPrice: 100, maxVolume: 100 };
    let min = Infinity;
    let max = -Infinity;
    let maxVol = 0;

    visibleCandles.forEach((c) => {
      if (c.low < min) min = c.low;
      if (c.high > max) max = c.high;
      if (c.volume > maxVol) maxVol = c.volume;
    });

    // Expand price bounds so drawings (SL, TP, Entry) are fully in-frame
    if (drawingLevels && drawingLevels.length > 0) {
      drawingLevels.forEach((lvl) => {
        if (Number.isFinite(lvl.price) && lvl.price > 0) {
          if (lvl.price < min) min = lvl.price;
          if (lvl.price > max) max = lvl.price;
        }
      });
    }

    if (livePrice && Number.isFinite(livePrice) && livePrice > 0) {
      if (livePrice < min) min = livePrice;
      if (livePrice > max) max = livePrice;
    }

    const buffer = (max - min) * 0.06 || 1;
    return {
      minPrice: min - buffer,
      maxPrice: max + buffer,
      maxVolume: maxVol || 1,
    };
  }, [visibleCandles, drawingLevels, livePrice]);

  const priceRange = maxPrice - minPrice || 1;
  const candleWidth = Math.max(4, (chartWidth / (visibleCandles.length || 1)) * 0.7);
  const candleGap = chartWidth / (visibleCandles.length || 1);

  const getY = (val: number) => {
    return paddingTop + chartHeight - ((val - minPrice) / priceRange) * chartHeight;
  };

  const activeCandle = hoverIndex !== null ? visibleCandles[hoverIndex] : visibleCandles[visibleCandles.length - 1];
  const activeActualIdx = hoverIndex !== null ? offset + hoverIndex : chartCandles.length - 1;
  const currentLivePrice = livePrice || activeCandle?.close || 0;

  return (
    <div className="bg-[#0f172a] border border-border rounded-xl p-4 shadow-xl">
      {/* Top Header: Live Price Ticker & Timeframe Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 border-b border-border pb-3">
        {/* Live Asset Price Ticker */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${livePriceIsStale ? 'bg-amber-400' : 'bg-emerald-400 animate-ping'}`} />
            <span className="font-extrabold text-white text-base tracking-wide font-mono">
              {symbol}
            </span>
          </div>
          <div className="flex items-baseline gap-2 bg-slate-900 border border-slate-800 px-3 py-1 rounded-lg">
              <span className={`text-[10px] font-bold uppercase tracking-wider ${livePriceIsStale ? 'text-amber-300' : 'text-slate-400'}`}>{livePriceIsStale ? 'LAST KNOWN' : 'LIVE'}</span>
            <span className="text-base font-black text-emerald-300 font-mono">
              {currency === 'USDT' || symbol.includes('USDT') || symbol.includes('BTC') || symbol.includes('ETH') || symbol.includes('SOL')
                ? `$${currentLivePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                : `₹${currentLivePrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
            </span>
          </div>
        </div>

        {/* Interval Selector */}
        <div className="flex items-center gap-1 bg-slate-900 p-1 rounded-lg border border-slate-800">
          {availableIntervals.map((int) => (
            <button
              key={int}
              onClick={() => onIntervalChange(int)}
              className={`px-2.5 py-1 text-xs font-semibold rounded ${
                interval === int
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {int}
            </button>
          ))}
        </div>

        {/* Indicator Toggles */}
        <div className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
          <button
            onClick={() => setShowEma20(!showEma20)}
            className={`px-2 py-1 rounded border transition-colors ${
              showEma20
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/50'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            EMA 20
          </button>
          <button
            onClick={() => setShowEma50(!showEma50)}
            className={`px-2 py-1 rounded border transition-colors ${
              showEma50
                ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/50'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            EMA 50
          </button>
          <button
            onClick={() => setShowSupertrend(!showSupertrend)}
            className={`px-2 py-1 rounded border transition-colors ${
              showSupertrend
                ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/50'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            Supertrend
          </button>
          <button
            onClick={() => setShowBollinger(!showBollinger)}
            className={`px-2 py-1 rounded border transition-colors ${
              showBollinger
                ? 'bg-purple-500/20 text-purple-300 border-purple-500/50'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            Bollinger
          </button>
          <button
            onClick={() => setShowRsi(!showRsi)}
            className={`px-2 py-1 rounded border transition-colors ${
              showRsi
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/50'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            RSI
          </button>
          <button
            onClick={() => setShowMacd(!showMacd)}
            className={`px-2 py-1 rounded border transition-colors ${
              showMacd
                ? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/50'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
          >
            MACD
          </button>
        </div>
      </div>

      {/* Candlestick Crosshair / Data HUD */}
      {activeCandle && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mb-2 text-xs font-mono text-slate-400 bg-slate-900/60 p-2 rounded-lg border border-slate-800/80">
          <div>
            <span className="text-slate-500 mr-1">Time:</span>
            <span className="text-slate-200">
              {new Date(activeCandle.time * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
          <div>
            <span className="text-slate-500 mr-1">O:</span>
            <span className="text-slate-200">{activeCandle.open.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500 mr-1">H:</span>
            <span className="text-emerald-400">{activeCandle.high.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500 mr-1">L:</span>
            <span className="text-rose-400">{activeCandle.low.toFixed(2)}</span>
          </div>
          <div>
            <span className="text-slate-500 mr-1">C:</span>
            <span className={activeCandle.close >= activeCandle.open ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
              {activeCandle.close.toFixed(2)}
            </span>
          </div>
          <div>
            <span className="text-slate-500 mr-1">Vol:</span>
            <span className="text-slate-300">{Math.round(activeCandle.volume).toLocaleString()}</span>
          </div>
          {showEma20 && ema20[activeActualIdx] !== null && (
            <span className="text-amber-400">EMA20: {ema20[activeActualIdx]}</span>
          )}
          {showEma50 && ema50[activeActualIdx] !== null && (
            <span className="text-cyan-400">EMA50: {ema50[activeActualIdx]}</span>
          )}
        </div>
      )}

      {/* Main SVG Candlestick Canvas */}
      <div className="relative w-full overflow-hidden select-none">
        {isLoading && (
          <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm flex items-center justify-center z-20">
            <span className="text-sm font-medium text-slate-300 animate-pulse">Loading live market candles...</span>
          </div>
        )}

        {visibleCandles.length === 0 ? (
          <div className="flex h-72 items-center justify-center bg-slate-950/60 px-6 text-center text-sm text-amber-200">
            {dataStatus || 'No candle history is available yet. Waiting for the selected market feed.'}
          </div>
        ) : <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto cursor-crosshair"
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            <linearGradient id="livePriceGlow" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0.8" />
            </linearGradient>
          </defs>

          {/* Price Grid Lines */}
          {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
            const y = paddingTop + chartHeight * ratio;
            const price = maxPrice - ratio * priceRange;
            return (
              <g key={ratio}>
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke="#1e293b"
                  strokeDasharray="4 4"
                />
                <text
                  x={width - paddingRight + 8}
                  y={y + 4}
                  fill="#64748b"
                  fontSize="10"
                  fontFamily="monospace"
                >
                  {price.toFixed(2)}
                </text>
              </g>
            );
          })}

          {/* Volume Histogram (bottom 18% of chart height) */}
          {visibleCandles.map((c, i) => {
            const x = paddingLeft + i * candleGap + candleGap / 2;
            const isBull = c.close >= c.open;
            const volHeight = (c.volume / maxVolume) * (chartHeight * 0.18);
            const y = paddingTop + chartHeight - volHeight;
            return (
              <rect
                key={`vol-${i}`}
                x={x - candleWidth / 2}
                y={y}
                width={candleWidth}
                height={volHeight}
                fill={isBull ? '#064e3b' : '#881337'}
                opacity={0.6}
              />
            );
          })}

          {/* Candlesticks */}
          {visibleCandles.map((c, i) => {
            const x = paddingLeft + i * candleGap + candleGap / 2;
            const isBull = c.close >= c.open;
            const color = isBull ? '#10b981' : '#f43f5e';
            const yHigh = getY(c.high);
            const yLow = getY(c.low);
            const yOpen = getY(c.open);
            const yClose = getY(c.close);
            const bodyY = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));

            return (
              <g
                key={`candle-${i}`}
                onMouseEnter={() => setHoverIndex(i)}
                className="transition-opacity"
              >
                {/* Wick */}
                <line
                  x1={x}
                  y1={yHigh}
                  x2={x}
                  y2={yLow}
                  stroke={color}
                  strokeWidth="1.5"
                />
                {/* Body */}
                <rect
                  x={x - candleWidth / 2}
                  y={bodyY}
                  width={candleWidth}
                  height={bodyHeight}
                  fill={color}
                  rx="1"
                />
              </g>
            );
          })}

          {/* Indicator Overlay: 20 EMA */}
          {showEma20 && (
            <polyline
              fill="none"
              stroke="#f59e0b"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={visibleCandles
                .map((_, i) => {
                  const val = ema20[offset + i];
                  if (val === null) return null;
                  const x = paddingLeft + i * candleGap + candleGap / 2;
                  return `${x},${getY(val)}`;
                })
                .filter(Boolean)
                .join(' ')}
            />
          )}

          {/* Indicator Overlay: 50 EMA */}
          {showEma50 && (
            <polyline
              fill="none"
              stroke="#06b6d4"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={visibleCandles
                .map((_, i) => {
                  const val = ema50[offset + i];
                  if (val === null) return null;
                  const x = paddingLeft + i * candleGap + candleGap / 2;
                  return `${x},${getY(val)}`;
                })
                .filter(Boolean)
                .join(' ')}
            />
          )}

          {/* Indicator Overlay: Bollinger Bands */}
          {showBollinger && (
            <>
              <polyline
                fill="none"
                stroke="#c084fc"
                strokeWidth="1.5"
                strokeDasharray="2 2"
                points={visibleCandles
                  .map((_, i) => {
                    const b = bollinger[offset + i];
                    if (!b || b.upper === null) return null;
                    const x = paddingLeft + i * candleGap + candleGap / 2;
                    return `${x},${getY(b.upper)}`;
                  })
                  .filter(Boolean)
                  .join(' ')}
              />
              <polyline
                fill="none"
                stroke="#c084fc"
                strokeWidth="1.5"
                strokeDasharray="2 2"
                points={visibleCandles
                  .map((_, i) => {
                    const b = bollinger[offset + i];
                    if (!b || b.lower === null) return null;
                    const x = paddingLeft + i * candleGap + candleGap / 2;
                    return `${x},${getY(b.lower)}`;
                  })
                  .filter(Boolean)
                  .join(' ')}
              />
            </>
          )}

          {/* Indicator Overlay: Supertrend */}
          {showSupertrend && (
            <polyline
              fill="none"
              stroke="#10b981"
              strokeWidth="2.5"
              points={visibleCandles
                .map((_, i) => {
                  const st = supertrend[offset + i];
                  if (!st || st.supertrend === null) return null;
                  const x = paddingLeft + i * candleGap + candleGap / 2;
                  return `${x},${getY(st.supertrend)}`;
                })
                .filter(Boolean)
                .join(' ')}
            />
          )}

          {/* ========================================================================= */}
          {/* STRATEGY DRAWINGS (Entry, Stop Loss, Take Profit, Support, Resistance)   */}
          {/* ========================================================================= */}
          {drawingLevels.map((lvl, idx) => {
            const y = getY(lvl.price);
            if (y < paddingTop - 15 || y > paddingTop + chartHeight + 15) return null;
            const isEntry = lvl.type === 'ENTRY';
            const isSL = lvl.type === 'STOP_LOSS';
            const isTP = lvl.type === 'TAKE_PROFIT';
            const strokeDash = isEntry ? undefined : isSL ? '4 3' : isTP ? '6 3' : '3 3';
            const strokeW = isEntry || isSL || isTP ? '2' : '1.5';

            return (
              <g key={`drawing-${idx}`} className="transition-all">
                {/* Horizontal Level Line */}
                <line
                  x1={paddingLeft}
                  y1={y}
                  x2={width - paddingRight}
                  y2={y}
                  stroke={lvl.color}
                  strokeWidth={strokeW}
                  strokeDasharray={strokeDash}
                  opacity={0.9}
                />

                {/* Left Margin Label Pill */}
                <rect
                  x={paddingLeft + 6}
                  y={y - 9}
                  width={Math.max(60, lvl.label.length * 6.5 + 12)}
                  height={18}
                  fill="#0b0f19"
                  stroke={lvl.color}
                  strokeWidth="1.2"
                  rx="4"
                  opacity={0.95}
                />
                <text
                  x={paddingLeft + 12}
                  y={y + 3.5}
                  fill={lvl.color}
                  fontSize="9"
                  fontFamily="monospace"
                  fontWeight="bold"
                >
                  {lvl.label}
                </text>

                {/* Right Axis Price Badge */}
                <rect
                  x={width - paddingRight + 2}
                  y={y - 9}
                  width={70}
                  height={18}
                  fill={lvl.color}
                  rx="3"
                />
                <text
                  x={width - paddingRight + 6}
                  y={y + 3.5}
                  fill="#ffffff"
                  fontSize="9"
                  fontFamily="monospace"
                  fontWeight="black"
                >
                  {lvl.price.toFixed(2)}
                </text>
              </g>
            );
          })}

          {/* ========================================================================= */}
          {/* LIVE PRICE TICKER LINE & AXIS BADGE                                       */}
          {/* ========================================================================= */}
          {currentLivePrice > 0 && (() => {
            const liveY = getY(currentLivePrice);
            return (
              <g className="live-ticker-group">
                {/* Live horizontal tracker line */}
                <line
                  x1={paddingLeft}
                  y1={liveY}
                  x2={width - paddingRight}
                  y2={liveY}
                  stroke="#a855f7"
                  strokeWidth="1.5"
                  strokeDasharray="2 2"
                />

                {/* Pulse dot on the line at the latest candle */}
                <circle
                  cx={paddingLeft + (visibleCandles.length - 1) * candleGap + candleGap / 2}
                  cy={liveY}
                  r="4"
                  fill="#c084fc"
                  stroke="#ffffff"
                  strokeWidth="1.5"
                />

                {/* Axis badge with live price */}
                <rect
                  x={width - paddingRight + 2}
                  y={liveY - 10}
                  width={70}
                  height={20}
                  fill="#8b5cf6"
                  rx="4"
                  stroke="#ffffff"
                  strokeWidth="1"
                />
                <text
                  x={width - paddingRight + 6}
                  y={liveY + 3.5}
                  fill="#ffffff"
                  fontSize="10"
                  fontFamily="monospace"
                  fontWeight="black"
                >
                  {currentLivePrice.toFixed(2)}
                </text>
              </g>
            );
          })()}

          {/* Crosshair on hover */}
          {hoverIndex !== null && (
            <g>
              <line
                x1={paddingLeft + hoverIndex * candleGap + candleGap / 2}
                y1={paddingTop}
                x2={paddingLeft + hoverIndex * candleGap + candleGap / 2}
                y2={paddingTop + chartHeight}
                stroke="#94a3b8"
                strokeDasharray="3 3"
              />
              <line
                x1={paddingLeft}
                y1={getY(visibleCandles[hoverIndex].close)}
                x2={width - paddingRight}
                y2={getY(visibleCandles[hoverIndex].close)}
                stroke="#94a3b8"
                strokeDasharray="3 3"
              />
            </g>
          )}
        </svg>}
      </div>

      {/* Subpanel: RSI Oscillator */}
      {showRsi && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between text-xs font-mono mb-1 text-slate-400">
            <span>RSI (14)</span>
            <span className="text-rose-400">
              Value: {rsi[activeActualIdx] !== null ? rsi[activeActualIdx] : 'N/A'}
            </span>
          </div>
          <svg viewBox={`0 0 ${width} 70`} className="w-full h-16 bg-slate-900/50 rounded">
            <line x1={paddingLeft} y1={21} x2={width - paddingRight} y2={21} stroke="#e11d48" strokeDasharray="3 3" opacity="0.6" />
            <line x1={paddingLeft} y1={49} x2={width - paddingRight} y2={49} stroke="#10b981" strokeDasharray="3 3" opacity="0.6" />
            <polyline
              fill="none"
              stroke="#f43f5e"
              strokeWidth="2"
              points={visibleCandles
                .map((_, i) => {
                  const val = rsi[offset + i];
                  if (val === null) return null;
                  const x = paddingLeft + i * candleGap + candleGap / 2;
                  const y = 70 - (val / 100) * 70;
                  return `${x},${y}`;
                })
                .filter(Boolean)
                .join(' ')}
            />
          </svg>
        </div>
      )}

      {/* Subpanel: MACD */}
      {showMacd && (
        <div className="mt-3 pt-3 border-t border-border">
          <div className="flex items-center justify-between text-xs font-mono mb-1 text-slate-400">
            <span>MACD (12, 26, 9)</span>
            <span className="text-indigo-400">
              Histogram: {macd[activeActualIdx]?.histogram ?? 'N/A'}
            </span>
          </div>
          <svg viewBox={`0 0 ${width} 70`} className="w-full h-16 bg-slate-900/50 rounded">
            <line x1={paddingLeft} y1={35} x2={width - paddingRight} y2={35} stroke="#334155" />
            {visibleCandles.map((_, i) => {
              const m = macd[offset + i];
              if (!m || m.histogram === null) return null;
              const x = paddingLeft + i * candleGap + candleGap / 2;
              const h = Math.min(30, Math.abs(m.histogram) * 4);
              const y = m.histogram >= 0 ? 35 - h : 35;
              return (
                <rect
                  key={`macd-${i}`}
                  x={x - 2}
                  y={y}
                  width={4}
                  height={h}
                  fill={m.histogram >= 0 ? '#10b981' : '#f43f5e'}
                />
              );
            })}
          </svg>
        </div>
      )}
    </div>
  );
}
