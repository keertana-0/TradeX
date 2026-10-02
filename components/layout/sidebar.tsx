'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  TrendingUp,
  Layers,
  Briefcase,
  ListOrdered,
  Bookmark,
  ShieldAlert,
  BarChart2,
  Compass,
  BarChart3,
  Zap,
  Database,
  Bot,
} from 'lucide-react';
import { UserRole } from '@/types/user';

interface SidebarProps {
  userRole?: UserRole;
}

export function Sidebar({ userRole }: SidebarProps) {
  const pathname = usePathname();

  const navItems = [
    { label: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { label: 'Stocks & Charts', href: '/stocks/RELIANCE', icon: TrendingUp },
    { label: 'Options Chain', href: '/options/NIFTY50', icon: Layers },
    { label: 'Market Regime', href: '/regime', icon: Compass },
    { label: 'Expert Picks', href: '/expert-picks', icon: Zap },
    { label: 'Backtest Engine', href: '/backtest', icon: BarChart3 },
    { label: 'Historical Explorer', href: '/historical', icon: Database },
    { label: 'Strategy Agent Arena', href: '/strategy-agents', icon: Bot },
    { label: 'Portfolio & P&L', href: '/portfolio', icon: Briefcase },
    { label: 'Orders & Trades', href: '/orders', icon: ListOrdered },
    { label: 'Watchlist', href: '/watchlist', icon: Bookmark },
  ];

  return (
    <aside className="w-64 border-r border-border bg-[#090d16] flex flex-col shrink-0 min-h-[calc(100vh-64px)]">
      <div className="p-4 space-y-1">
        <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider px-3 mb-2">
          Trading Terminal
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || (item.href.startsWith('/stocks/') && pathname.startsWith('/stocks/')) || (item.href.startsWith('/options/') && pathname.startsWith('/options/'));
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-500/30 shadow-sm'
                  : 'text-slate-300 hover:text-white hover:bg-slate-800/60'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-indigo-400' : 'text-slate-400'}`} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </div>

      {userRole === 'ADMIN' && (
        <div className="p-4 border-t border-border mt-auto">
          <div className="text-[11px] font-semibold text-amber-400 uppercase tracking-wider px-3 mb-2 flex items-center gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5" />
            <span>Admin Control</span>
          </div>
          <Link
            href="/admin"
            className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${
              pathname.startsWith('/admin')
                ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40'
                : 'text-amber-200/80 hover:text-amber-200 hover:bg-amber-950/40'
            }`}
          >
            <BarChart2 className="w-4 h-4 text-amber-400" />
            <span>Admin Management</span>
          </Link>
        </div>
      )}
    </aside>
  );
}
