'use client';

import React, { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Search, LogOut, ShieldCheck, Wallet, ArrowUpRight, ArrowDownRight, Clock } from 'lucide-react';
import { formatINR } from '@/lib/utils';
import { MarketStatus, Quote } from '@/types/market';

export function Navbar() {
  const router = useRouter();
  const [user, setUser] = useState<{ displayName: string; role: string; balance: number; cryptoBalance?: number } | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatus | null>(null);
  const [indices, setIndices] = useState<Quote[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ symbol: string; name: string }[]>([]);
  const [showSearch, setShowSearch] = useState(false);

  useEffect(() => {
    // Fetch user info
    fetch('/api/auth/me')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data?.user) setUser(data.user);
      })
      .catch(() => {});

    // Fetch market status
    fetch('/api/market/status')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data) setMarketStatus(data);
      })
      .catch(() => {});

    // Fetch primary indices quotes
    Promise.all([
      fetch('/api/market/quote/NIFTY50').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/market/quote/SENSEX').then((r) => (r.ok ? r.json() : null)),
      fetch('/api/market/quote/BANKNIFTY').then((r) => (r.ok ? r.json() : null)),
    ]).then(([nifty, sensex, bank]) => {
      setIndices([nifty, sensex, bank].filter(Boolean));
    }).catch(() => {});
  }, []);

  const handleSearch = async (val: string) => {
    setSearchQuery(val);
    if (!val.trim()) {
      setSearchResults([]);
      return;
    }
    try {
      const res = await fetch(`/api/market/search?q=${encodeURIComponent(val)}`);
      if (res.ok) {
        const data = await res.json();
        setSearchResults(data);
      }
    } catch {}
  };

  const handleLogout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  };

  return (
    <header className="border-b border-border bg-[#090d16] sticky top-0 z-40">
      {/* Top Header */}
      <div className="h-16 px-4 flex items-center justify-between gap-4">
        {/* Brand */}
        <div className="flex items-center gap-6">
          <Link href="/dashboard" className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-tr from-indigo-600 to-indigo-400 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-600/30">
              TX
            </div>
            <div>
              <span className="font-bold text-lg text-white tracking-tight">TradeX</span>
              <span className="text-[10px] text-indigo-400 block -mt-1 font-mono">INDIA TERMINAL</span>
            </div>
          </Link>

          {/* Market Status Pill */}
          {marketStatus && (
            <div className="hidden lg:flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium border bg-slate-900 border-slate-800 neon-pulse">
              <span
                className={`w-2 h-2 rounded-full ${
                  marketStatus.isOpen ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'
                }`}
              />
              <span className="text-slate-300 font-mono text-[11px]">{marketStatus.status}</span>
              <span className="text-slate-500 text-[10px]">({marketStatus.timezone})</span>
            </div>
          )}
        </div>

        {/* Global Search Bar */}
        <div className="relative flex-1 max-w-md">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              placeholder="Search Indian stocks (e.g. RELIANCE, TCS, INFY)..."
              value={searchQuery}
              onChange={(e) => {
                handleSearch(e.target.value);
                setShowSearch(true);
              }}
              onFocus={() => setShowSearch(true)}
              className="w-full pl-9 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-lg text-sm text-slate-200 placeholder:text-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>

          {/* Search Dropdown */}
          {showSearch && searchResults.length > 0 && (
            <div
              className="absolute left-0 right-0 top-full mt-1 bg-slate-900 border border-slate-800 rounded-lg shadow-2xl overflow-hidden z-50 max-h-72 overflow-y-auto"
              onMouseLeave={() => setShowSearch(false)}
            >
              {searchResults.map((item) => (
                <button
                  key={item.symbol}
                  onClick={() => {
                    setShowSearch(false);
                    setSearchQuery('');
                    router.push(`/stocks/${item.symbol}`);
                  }}
                  className="w-full px-4 py-2.5 flex items-center justify-between hover:bg-slate-800/80 text-left border-b border-slate-800/50 transition-colors"
                >
                  <div>
                    <span className="font-semibold text-slate-100 text-sm">{item.symbol}</span>
                    <span className="text-xs text-slate-400 block truncate">{item.name}</span>
                  </div>
                  <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700">
                    NSE
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Right Section: Virtual Cash & User Menu */}
        <div className="flex items-center gap-4">
          {user && (
            <div className="flex items-center gap-2">
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800" title="Indian Market Paper Wallet (INR)">
                <span className="text-xs">🇮🇳</span>
                <div>
                  <span className="text-[9px] text-slate-400 block leading-none font-bold uppercase tracking-wider">INR Wallet</span>
                  <span className="text-xs font-semibold text-emerald-400 font-mono">
                    {formatINR(user.balance)}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-slate-900 border border-slate-800" title="Crypto 24/7 Paper Wallet (USDT)">
                <span className="text-xs">🌐</span>
                <div>
                  <span className="text-[9px] text-cyan-400 block leading-none font-bold uppercase tracking-wider">USDT Wallet</span>
                  <span className="text-xs font-semibold text-cyan-300 font-mono">
                    ${Number(user.cryptoBalance ?? 1000000).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USDT
                  </span>
                </div>
              </div>
            </div>
          )}

          {user && (
            <div className="flex items-center gap-3">
              <div className="text-right hidden sm:block">
                <span className="text-xs font-semibold text-slate-200 block">{user.displayName}</span>
                <span className="text-[10px] text-slate-400 uppercase tracking-wider">{user.role}</span>
              </div>
              <button
                onClick={handleLogout}
                title="Logout"
                className="p-2 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/20 border border-transparent hover:border-rose-900/40 transition-colors"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Real-time Indian Indices Ticker Strip */}
      <div className="bg-slate-950/80 border-t border-border px-4 py-1.5 flex items-center gap-6 overflow-x-auto text-xs font-mono">
        <div className="flex items-center gap-1.5 text-slate-400 shrink-0 text-[11px]">
          <Clock className="w-3.5 h-3.5 text-indigo-400" />
          <span>MARKETS:</span>
        </div>
        {indices.map((idx) => {
          const isPositive = idx.change >= 0;
          return (
            <Link
              key={idx.symbol}
              href={`/stocks/${idx.symbol}`}
              className="flex items-center gap-2 hover:opacity-80 shrink-0 transition-opacity"
            >
              <span className="font-semibold text-slate-200">{idx.name || idx.symbol}</span>
              <span className="text-slate-300">{idx.lastPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
              <span
                className={`flex items-center gap-0.5 text-[11px] ${
                  isPositive ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {isPositive ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {isPositive ? '+' : ''}
                {idx.change.toFixed(2)} ({isPositive ? '+' : ''}
                {idx.changePercent.toFixed(2)}%)
              </span>
            </Link>
          );
        })}
      </div>
    </header>
  );
}
