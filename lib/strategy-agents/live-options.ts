import { STRATEGY_MARKETS, type StrategyMarketSymbol } from './market-data';

type OptionMarketData = {
  ltp?: number; bid_price?: number; ask_price?: number;
  volume?: number; bid_qty?: number; ask_qty?: number;
};
type ChainLeg = { instrument_key?: string; market_data?: OptionMarketData };
type ChainRow = { expiry: string; strike_price: number; call_options?: ChainLeg; put_options?: ChainLeg };
type Contract = { instrument_key: string; instrument_type: 'CE' | 'PE'; strike_price: number; lot_size: number; expiry: string };
export type LiveOptionQuote = {
  symbol: StrategyMarketSymbol; expiry: string; strike: number; optionType: 'CE' | 'PE';
  instrumentKey: string; lotSize: number; ltp: number; bid: number; ask: number;
  volume: number; bidQty: number; askQty: number; spreadPct: number;
};

const UNDERLYING_KEYS: Record<StrategyMarketSymbol, string> = {
  NIFTY: 'NSE_INDEX|Nifty 50', BANKNIFTY: 'NSE_INDEX|Nifty Bank', SENSEX: 'BSE_INDEX|SENSEX',
};
const contractsCache = new Map<string, { at: number; rows: Contract[] }>();
const chainCache = new Map<string, { at: number; rows: ChainRow[] }>();
const finitePositive = (value: unknown): number => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

function upstoxHeaders(token: string) {
  return { Accept: 'application/json', Authorization: `Bearer ${token}` };
}

async function upstoxJson(url: URL, token: string) {
  const response = await fetch(url, { headers: upstoxHeaders(token), cache: 'no-store', signal: AbortSignal.timeout(8_000) });
  const body = await response.json().catch(() => null);
  if (!response.ok || body?.status !== 'success') {
    const reason = body?.errors?.[0]?.message || body?.message || `HTTP ${response.status}`;
    if (response.status === 401) throw new Error('Upstox rejected UPSTOX_ACCESS_TOKEN. Refresh the token to enable live option quotes.');
    throw new Error(`Upstox option market data failed: ${reason}`);
  }
  return body;
}

async function getContracts(symbol: StrategyMarketSymbol, token: string): Promise<Contract[]> {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const key = `${symbol}|${today}`;
  const cached = contractsCache.get(key);
  if (cached && Date.now() - cached.at < 30 * 60_000) return cached.rows;
  const url = new URL('https://api.upstox.com/v2/option/contract');
  url.searchParams.set('instrument_key', UNDERLYING_KEYS[symbol]);
  url.searchParams.set('expiry_date', 'current_week');
  const payload = await upstoxJson(url, token);
  if (!Array.isArray(payload.data)) throw new Error(`Upstox returned no option contracts for ${symbol}.`);
  const rows = (payload.data as Contract[]).filter((row) => row.expiry >= today && Number.isFinite(Number(row.lot_size)) && Number(row.lot_size) > 0);
  if (rows.length) contractsCache.set(key, { at: Date.now(), rows });
  return rows;
}

async function getChain(symbol: StrategyMarketSymbol, token: string): Promise<ChainRow[]> {
  const cached = chainCache.get(symbol);
  if (cached && Date.now() - cached.at < 3_000) return cached.rows;
  const url = new URL('https://api.upstox.com/v2/option/chain');
  url.searchParams.set('instrument_key', UNDERLYING_KEYS[symbol]);
  url.searchParams.set('expiry_date', 'current_week');
  const payload = await upstoxJson(url, token);
  if (!Array.isArray(payload.data)) throw new Error(`Upstox returned no live option chain for ${symbol}.`);
  const rows = payload.data as ChainRow[];
  chainCache.set(symbol, { at: Date.now(), rows });
  return rows;
}

/** Chooses the nearest-expiry, near-ATM contract with a two-sided, reasonably tight live market. */
export async function selectLiveOption(symbol: StrategyMarketSymbol, side: 'CE' | 'PE', spot: number): Promise<LiveOptionQuote> {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN to enable live option-chain data. Agents will not simulate option fills without it.');
  const [chain, contracts] = await Promise.all([getChain(symbol, token), getContracts(symbol, token)]);
  const contractByKey = new Map(contracts.map((contract) => [contract.instrument_key, contract]));
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const candidates = chain.flatMap((row) => {
    const leg = side === 'CE' ? row.call_options : row.put_options;
    const market = leg?.market_data;
    const instrumentKey = leg?.instrument_key;
    if (!instrumentKey || !market || row.expiry < today) return [];
    const contract = contractByKey.get(instrumentKey);
    if (!contract || contract.instrument_type !== side) return [];
    const bid = finitePositive(market.bid_price), ask = finitePositive(market.ask_price), ltp = finitePositive(market.ltp);
    const bidQty = finitePositive(market.bid_qty), askQty = finitePositive(market.ask_qty), volume = finitePositive(market.volume);
    if (!bid || !ask || !ltp || ask < bid || bidQty <= 0 || askQty <= 0 || volume <= 0) return [];
    const spreadPct = (ask - bid) / ((ask + bid) / 2);
    if (spreadPct > Number(process.env.STRATEGY_OPTION_MAX_SPREAD_PCT || 0.05)) return [];
    return [{ symbol, expiry: row.expiry, strike: Number(row.strike_price), optionType: side, instrumentKey, lotSize: Number(contract.lot_size), ltp, bid, ask, volume, bidQty, askQty, spreadPct } satisfies LiveOptionQuote];
  });
  candidates.sort((a, b) => a.expiry.localeCompare(b.expiry) || Math.abs(a.strike - spot) - Math.abs(b.strike - spot) || a.spreadPct - b.spreadPct);
  const selected = candidates[0];
  if (!selected) throw new Error(`No liquid ${symbol} ${side} near-ATM contract with a fresh two-sided market was available.`);
  return selected;
}

export function getOptionQuoteForOpenTrade(symbol: StrategyMarketSymbol, expiry: string, strike: number, side: 'CE' | 'PE', chain: ChainRow[]): LiveOptionQuote | null {
  const row = chain.find((item) => item.expiry === expiry && Number(item.strike_price) === strike);
  const leg = side === 'CE' ? row?.call_options : row?.put_options;
  const market = leg?.market_data;
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token || !leg?.instrument_key || !market) return null;
  const bid = finitePositive(market.bid_price), ask = finitePositive(market.ask_price), ltp = finitePositive(market.ltp);
  const bidQty = finitePositive(market.bid_qty), askQty = finitePositive(market.ask_qty), volume = finitePositive(market.volume);
  if (!bid || !ask || !ltp || ask < bid || bidQty <= 0 || askQty <= 0) return null;
  const spreadPct = (ask - bid) / ((ask + bid) / 2);
  if (spreadPct > Number(process.env.STRATEGY_OPTION_MAX_SPREAD_PCT || 0.05)) return null;
  // Existing positions keep their original lot size in the trade quantity, so this field is informational here.
  return { symbol, expiry, strike, optionType: side, instrumentKey: leg.instrument_key, lotSize: 1, ltp, bid, ask, volume, bidQty, askQty, spreadPct };
}

export async function getLiveOptionChain(symbol: StrategyMarketSymbol): Promise<ChainRow[]> {
  const token = process.env.UPSTOX_ACCESS_TOKEN?.trim();
  if (!token) throw new Error('Set UPSTOX_ACCESS_TOKEN to enable live option-chain data.');
  return getChain(symbol, token);
}

export function marketForOptionSymbol(value: string): StrategyMarketSymbol | null {
  const prefix = value.split('_')[0];
  if (prefix === 'NIFTY' || prefix === 'BANKNIFTY' || prefix === 'SENSEX') return prefix;
  if (prefix === 'NIFTY50') return 'NIFTY';
  return null;
}

export function parseOptionSymbol(value: string): { market: StrategyMarketSymbol; expiry: string; strike: number; side: 'CE' | 'PE' } | null {
  const match = value.match(/^(NIFTY|BANKNIFTY|SENSEX)_(\d{4}-\d{2}-\d{2})_(\d+(?:\.\d+)?)_(CE|PE)$/);
  if (!match) return null;
  return { market: match[1] as StrategyMarketSymbol, expiry: match[2], strike: Number(match[3]), side: match[4] as 'CE' | 'PE' };
}

export { STRATEGY_MARKETS };
