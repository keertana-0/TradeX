import Link from 'next/link';
import { Compass, Home } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-[#090d16] text-slate-100 font-sans">
      <div className="w-full max-w-md rounded-2xl border border-white/10 bg-[#0d1222] p-8 shadow-2xl text-center space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-500/10 border border-indigo-500/30 text-indigo-400">
          <Compass className="h-7 w-7" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-white">404 - Page Not Found</h1>
          <p className="mt-2 text-xs text-slate-400 leading-5">
            The page you requested could not be located on the TradeX terminal.
          </p>
        </div>
        <div className="pt-2">
          <Link
            href="/strategy-agents"
            className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg hover:bg-indigo-500 transition-colors"
          >
            <Home className="h-4 w-4" /> Go to Strategy Arena
          </Link>
        </div>
      </div>
    </div>
  );
}
