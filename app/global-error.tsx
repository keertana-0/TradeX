'use client';

import { useEffect } from 'react';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Global Error:', error);
  }, [error]);

  return (
    <html lang="en">
      <body className="min-h-screen flex items-center justify-center p-6 bg-[#090d16] text-slate-100 font-sans">
        <div className="w-full max-w-md rounded-2xl border border-rose-500/20 bg-[#0d1222] p-8 shadow-2xl text-center space-y-4">
          <h2 className="text-xl font-bold text-white">System Error</h2>
          <p className="text-xs text-slate-400">
            {error?.message || 'A critical error occurred. Please reload the application.'}
          </p>
          <button
            onClick={() => reset()}
            className="rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg hover:bg-indigo-500 transition-colors"
          >
            Reload Application
          </button>
        </div>
      </body>
    </html>
  );
}
