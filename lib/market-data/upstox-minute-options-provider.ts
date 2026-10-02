import fs from 'node:fs/promises';
import path from 'node:path';

export interface UpstoxMinuteContractRequest {
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  from: string;
  to: string;
}

export interface UpstoxMinuteCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface UpstoxMinuteOptionSeries extends UpstoxMinuteContractRequest {
  instrumentKey: string;
  candles: UpstoxMinuteCandle[];
}

interface UpstoxContract {
  expiry: string;
  instrument_key: string;
  instrument_type: 'CE' | 'PE';
  strike_price: number;
}

const UNDERLYING_KEYS: Record<string, string> = {
  NIFTY: 'NSE_INDEX|Nifty 50',
  NIFTY50: 'NSE_INDEX|Nifty 50',
  BANKNIFTY: 'NSE_INDEX|Nifty Bank',
  SENSEX: 'BSE_INDEX|SENSEX',
};
const todayIst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Calcutta', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** Fetches true one-minute option candles from Upstox; no CSV fallback. */
export class UpstoxMinuteOptionsProvider {
  private readonly token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  private readonly cacheDirectory = path.join(process.cwd(), '.cache', 'upstox-minute-options');

  async getMinuteOptions(symbol: string, requests: UpstoxMinuteContractRequest[]): Promise<UpstoxMinuteOptionSeries[]> {
    if (!this.token) throw new Error('Minute-level backtesting requires UPSTOX_ACCESS_TOKEN. Add a valid Upstox OAuth access token to the server environment; the expired-contract candle API also requires Upstox Plus.');
    const underlyingKey = UNDERLYING_KEYS[symbol.toUpperCase()];
    if (!underlyingKey) throw new Error(`Upstox minute options do not support ${symbol}.`);
    const normalized = [...new Map(requests.map((request) => [`${request.expiry}|${request.strike}|${request.optionType}|${request.from}|${request.to}`, request])).values()];
    if (!normalized.length) return [];

    const contractsByExpiry = new Map<string, UpstoxContract[]>();
    for (const expiry of [...new Set(normalized.map((request) => request.expiry))]) {
      contractsByExpiry.set(expiry, await this.getContracts(underlyingKey, expiry));
    }

    const selected = normalized.map((request) => {
      const contract = contractsByExpiry.get(request.expiry)?.find((item) =>
        item.expiry === request.expiry && item.instrument_type === request.optionType && Number(item.strike_price) === request.strike
      );
      if (!contract) throw new Error(`Upstox returned no ${symbol} ${request.strike} ${request.optionType} contract for expiry ${request.expiry}.`);
      return { request, instrumentKey: contract.instrument_key };
    });

    const output: UpstoxMinuteOptionSeries[] = [];
    let cursor = 0;
    const workers = Array.from({ length: Math.min(3, selected.length) }, async () => {
      while (cursor < selected.length) {
        const index = cursor++;
        const item = selected[index];
        const candles = await this.getCandles(item.instrumentKey, item.request);
        output[index] = { ...item.request, instrumentKey: item.instrumentKey, candles };
      }
    });
    await Promise.all(workers);
    return output;
  }

  private async requestJson(url: URL): Promise<any> {
    let lastError = 'Upstox request failed.';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(url, { headers: { Accept: 'application/json', Authorization: `Bearer ${this.token}` }, cache: 'no-store', signal: AbortSignal.timeout(45_000) });
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 400 * (2 ** attempt))); continue; }
        throw new Error(`Upstox minute-data request failed: ${lastError}`);
      }
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === 'success') return payload;
      const detail = payload?.errors?.[0]?.message || payload?.message || `HTTP ${response.status}`;
      if (response.status === 401) throw new Error('Upstox rejected UPSTOX_ACCESS_TOKEN. Refresh the OAuth token and update the server environment.');
      if (response.status === 403 && /Plus|UDAPI1149/i.test(String(detail))) throw new Error('Upstox expired-option minute candles require an active Upstox Plus subscription.');
      lastError = String(detail);
      if (response.status === 429 && attempt < 3) { await new Promise((resolve) => setTimeout(resolve, 750 * (2 ** attempt))); continue; }
      throw new Error(`Upstox minute-data request failed: ${lastError}`);
    }
    throw new Error(`Upstox minute-data request failed: ${lastError}`);
  }

  private async getContracts(underlyingKey: string, expiry: string): Promise<UpstoxContract[]> {
    const expired = expiry < todayIst();
    const url = new URL(expired ? 'https://api.upstox.com/v2/expired-instruments/option/contract' : 'https://api.upstox.com/v2/option/contract');
    url.searchParams.set('instrument_key', underlyingKey);
    url.searchParams.set('expiry_date', expiry);
    const payload = await this.requestJson(url);
    if (!Array.isArray(payload.data)) throw new Error(`Upstox returned an invalid ${expiry} option-contract list.`);
    return payload.data as UpstoxContract[];
  }

  private async getCandles(instrumentKey: string, request: UpstoxMinuteContractRequest): Promise<UpstoxMinuteCandle[]> {
    const cacheName = `${Buffer.from(`${instrumentKey}|${request.from}|${request.to}`).toString('base64url')}.json`;
    const cachePath = path.join(this.cacheDirectory, cacheName);
    try {
      const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as UpstoxMinuteCandle[];
      if (Array.isArray(cached)) return cached;
    } catch { /* Missing or invalid cache; fetch fresh candles. */ }

    const expired = request.expiry < todayIst();
    const endpoint = expired
      ? `https://api.upstox.com/v2/expired-instruments/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${request.to}/${request.from}`
      : `https://api.upstox.com/v2/historical-candle/${encodeURIComponent(instrumentKey)}/1minute/${request.to}/${request.from}`;
    const payload = await this.requestJson(new URL(endpoint));
    const rawCandles: unknown[] = payload?.data?.candles;
    if (!Array.isArray(rawCandles)) throw new Error(`Upstox returned no valid minute candles for ${instrumentKey}.`);
    const byTimestamp = new Map<string, UpstoxMinuteCandle>();
    for (const raw of rawCandles) {
      if (!Array.isArray(raw) || raw.length < 6) continue;
      const [timestamp, open, high, low, close, volume] = raw;
      const time = typeof timestamp === 'string' ? Date.parse(timestamp) : Number(timestamp);
      const prices = [open, high, low, close].map(Number);
      const tradedVolume = Number(volume);
      if (!Number.isFinite(time) || prices.some((price) => !Number.isFinite(price) || price <= 0) ||
        prices[2] > prices[1] || prices[0] < prices[2] || prices[0] > prices[1] || prices[3] < prices[2] || prices[3] > prices[1] ||
        !Number.isFinite(tradedVolume) || tradedVolume <= 0) continue;
      const iso = new Date(time).toISOString();
      const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time));
      if (date < request.from || date > request.to) continue;
      byTimestamp.set(iso, { timestamp: iso, open: prices[0], high: prices[1], low: prices[2], close: prices[3], volume: tradedVolume });
    }
    const candles = [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    await fs.mkdir(this.cacheDirectory, { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(candles), 'utf8');
    return candles;
  }
}
