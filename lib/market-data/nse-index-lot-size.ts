/** Index option market lots by contract expiry, following NSE circular rollovers. */
export function getNseIndexOptionLotSize(symbol: string, expiry: string): number {
  if (symbol === 'NIFTY50') {
    // NSE revisions: 25 -> 75 for newly introduced contracts in Nov 2024,
    // then 75 -> 65 for weekly expiries from 06-Jan-2026 and monthly from 27-Jan-2026.
    if (expiry >= '2026-01-27' || expiry >= '2026-01-06') return 65;
    if (expiry >= '2025-01-02' && expiry !== '2025-01-30') return 75;
    if (expiry >= '2025-02-27') return 75;
    return 25;
  }
  if (symbol === 'BANKNIFTY') {
    // New monthly expiries used 30 from Feb 2025; July 2025 revision to 35
    // applied to newly introduced monthly expiries. Oct 2025 revision returns to 30
    // for new contracts from Jan 2026 (first applicable monthly expiry).
    if (expiry >= '2026-01-28') return 30;
    if (expiry >= '2025-07-31') return 35;
    if (expiry >= '2025-02-26') return 30;
    return 15;
  }
  if (symbol === 'SENSEX') return 20;
  throw new Error(`No NSE index option lot-size schedule is configured for ${symbol}.`);
}
