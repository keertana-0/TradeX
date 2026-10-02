import { afterEach, describe, expect, it, vi } from 'vitest';
import { JugaadDailyOptionsProvider } from '@/lib/market-data/jugaad-daily-options-provider';

const envBefore = {
  url: process.env.JUGAAD_HISTORICAL_API_URL,
  token: process.env.JUGAAD_HISTORICAL_API_TOKEN,
};

const dataset = {
  provider: 'jugaad-data', granularity: 'daily',
  observations: [
    { date: '2026-08-03', underlying: 'NIFTY50', expiry: '2026-08-27', strike: 25000, optionType: 'CE', open: 10, high: 12, low: 9, close: 11, ltp: 11, volume: 10, underlyingPrice: 24900 },
    { date: '2026-08-04', underlying: 'NIFTY50', expiry: '2026-08-27', strike: 25000, optionType: 'CE', open: 11, high: 13, low: 10, close: 12, ltp: 12, volume: 10, underlyingPrice: 24950 },
  ],
  quality: { rawCandidateRows: 2, acceptedRows: 2, rejectedRows: 0, rejectionCounts: {} },
  coverage: { requestedFrom: '2026-08-03', requestedTo: '2026-08-04', observedSessions: 2, failedDateCount: 0, failedDates: [] },
};

describe('Jugaad daily options adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (envBefore.url === undefined) delete process.env.JUGAAD_HISTORICAL_API_URL;
    else process.env.JUGAAD_HISTORICAL_API_URL = envBefore.url;
    if (envBefore.token === undefined) delete process.env.JUGAAD_HISTORICAL_API_TOKEN;
    else process.env.JUGAAD_HISTORICAL_API_TOKEN = envBefore.token;
  });

  it('requests the Python historical service with the selected symbol and date range', async () => {
    process.env.JUGAAD_HISTORICAL_API_URL = 'http://127.0.0.1:5000';
    process.env.JUGAAD_HISTORICAL_API_TOKEN = 'test-token';
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(dataset), { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    const result = await new JugaadDailyOptionsProvider().getHistoricalOptions('NIFTY50', '2026-08-03', '2026-08-04');
    const [url, options] = fetch.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('http://127.0.0.1:5000/api/backtest/daily-options/NIFTY50?from=2026-08-03&to=2026-08-04');
    expect(options.headers).toEqual({ Authorization: 'Bearer test-token' });
    expect(result.observations).toHaveLength(2);
    expect(result.granularity).toBe('daily');
    expect(result.quality.acceptedRows).toBe(2);
  });

  it('preserves useful historical-data errors from the Python service', async () => {
    process.env.JUGAAD_HISTORICAL_API_URL = 'http://127.0.0.1:5000';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'NSE has no contract history for these dates.' }), { status: 422 })));
    await expect(new JugaadDailyOptionsProvider().getHistoricalOptions('NIFTY50', '2026-08-03', '2026-08-04'))
      .rejects.toThrow('NSE has no contract history for these dates.');
  });

  it('rejects a response containing no valid rows for the requested date range', async () => {
    process.env.JUGAAD_HISTORICAL_API_URL = 'http://127.0.0.1:5000';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...dataset, observations: [] }), { status: 200 })));
    await expect(new JugaadDailyOptionsProvider().getHistoricalOptions('NIFTY50', '2026-08-03', '2026-08-04'))
      .rejects.toThrow('no valid daily NIFTY50 option prices');
  });

  it('filters impossible option OHLC bars before returning data for analysis', async () => {
    process.env.JUGAAD_HISTORICAL_API_URL = 'http://127.0.0.1:5000';
    const corrupt = { ...dataset, observations: [
      ...dataset.observations,
      { ...dataset.observations[0], date: '2026-08-03', close: 76152.86 },
    ], quality: { rawCandidateRows: 3, acceptedRows: 3, rejectedRows: 0, rejectionCounts: {} } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(corrupt), { status: 200 })));

    const result = await new JugaadDailyOptionsProvider().getHistoricalOptions('NIFTY50', '2026-08-03', '2026-08-04');
    expect(result.observations).toHaveLength(2);
    expect(result.quality.acceptedRows).toBe(2);
    expect(result.quality.rejectedRows).toBe(1);
    expect(result.quality.rejectionCounts.inconsistent_ohlc).toBe(1);
  });
});
