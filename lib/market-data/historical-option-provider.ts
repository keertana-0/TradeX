import fs from 'node:fs/promises';
import { HistoricalOptionObservation } from '@/types/historical-options';

const aliases: Record<string, string> = {
  date: 'date', trade_date: 'date', datetime: 'timestamp', timestamp: 'timestamp', time: 'time', symbol: 'underlying', index: 'underlying', underlying: 'underlying', spot: 'underlyingPrice',
  underlying_price: 'underlyingPrice', underlyingprice: 'underlyingPrice', option_type: 'optionType', optiontype: 'optionType', type: 'optionType', expiry_date: 'expiry', oi: 'oi', open_interest: 'oi',
  change_in_oi: 'changeOi', changeoi: 'changeOi', bid_price: 'bid', ask_price: 'ask',
};

function csvRows(text: string): Record<string, string>[] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { record.push(field.trim()); field = ''; }
    else if (char === '\n') { record.push(field.trim()); records.push(record); record = []; field = ''; }
    else if (char !== '\r') field += char;
  }
  if (quoted) throw new Error('Historical option CSV contains an unterminated quoted field.');
  if (field.length || record.length) { record.push(field.trim()); records.push(record); }
  const nonEmpty = records.filter((row) => row.some((value) => value.trim()));
  if (!nonEmpty.length) return [];
  const headers = nonEmpty[0].map((h) => aliases[h.trim().toLowerCase()] || h.trim().toLowerCase());
  if (new Set(headers).size !== headers.length) throw new Error('Historical option CSV contains duplicate column names.');
  return nonEmpty.slice(1).map((values) => Object.fromEntries(headers.map((header, i) => [header, values[i]?.trim() || ''])));
}

function normalizeExpiry(value: string): string {
  const input = value.trim();
  const isoDate = input.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoDate) {
    const canonical = `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
    const parsed = new Date(`${canonical}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === canonical ? canonical : '';
  }
  const nseDate = input.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2}|\d{4})$/);
  if (!nseDate) return '';
  const months: Record<string, string> = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };
  const month = months[nseDate[2].toUpperCase()];
  const year = nseDate[3].length === 2 ? `20${nseDate[3]}` : nseDate[3];
  const day = nseDate[1].padStart(2, '0');
  if (!month || Number(day) < 1 || Number(day) > 31) return '';
  const canonical = `${year}-${month}-${day}`;
  const parsed = new Date(`${canonical}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === canonical ? canonical : '';
}

function parseTimestamp(value: string): number {
  const input = value.trim();
  if (!input) return NaN;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(input);
  const normalized = input.includes('T') ? input : input.includes(' ') ? input.replace(' ', 'T') : `${input}T00:00:00`;
  return Date.parse(hasZone ? normalized : `${normalized}+05:30`);
}

export function parseHistoricalOptionsCsv(text: string, symbol?: string, from?: string, to?: string): HistoricalOptionObservation[] {
  const rows = csvRows(text);
  const required = ['underlying', 'expiry', 'strike', 'optionType', 'underlyingPrice', 'ltp'];
  const missing = required.filter((key) => !rows[0] || !(key in rows[0]));
  if (!rows[0] || (!('timestamp' in rows[0]) && !('date' in rows[0]))) missing.push('timestamp');
  if (missing.length) throw new Error(`Historical option data is missing required columns: ${[...new Set(missing)].join(', ')}.`);
  const fromTime = from ? Date.parse(`${from}T00:00:00+05:30`) : -Infinity;
  const toTime = to ? Date.parse(`${to}T23:59:59.999+05:30`) : Infinity;
  const normalizedSymbol = symbol?.toUpperCase();
  const observations: HistoricalOptionObservation[] = [];
  for (const row of rows) {
    const dateTime = row.timestamp || [row.date, row.time].filter(Boolean).join(' ');
    const timestamp = parseTimestamp(dateTime);
    const optionType = (row.optionType || '').toUpperCase().replace('CALL', 'CE').replace('PUT', 'PE');
    const rawUnderlying = (row.underlying || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const underlying = rawUnderlying === 'NIFTY' ? 'NIFTY50' : rawUnderlying;
    const expiry = normalizeExpiry(row.expiry || '');
    const strike = Number(row.strike), spot = Number(row.underlyingPrice), ltp = Number(row.ltp);
    if (!Number.isFinite(timestamp) || timestamp < fromTime || timestamp > toTime || !underlying || !expiry || !['CE', 'PE'].includes(optionType) || !Number.isFinite(strike) || strike <= 0 || !Number.isFinite(spot) || spot <= 0 || !Number.isFinite(ltp) || ltp <= 0) continue;
    if (normalizedSymbol && underlying !== (normalizedSymbol === 'NIFTY' ? 'NIFTY50' : normalizedSymbol.replace(/[^A-Z0-9]/g, ''))) continue;
    const n = (key: string) => {
      if (row[key] === '' || row[key] === undefined) return undefined;
      const value = Number(row[key]);
      return Number.isFinite(value) && (key === 'changeOi' || value >= 0) ? value : undefined;
    };
    observations.push({ timestamp: new Date(timestamp).toISOString(), underlying: normalizedSymbol || underlying, underlyingPrice: spot, expiry, strike, optionType: optionType as 'CE' | 'PE', ltp, open: n('open'), high: n('high'), low: n('low'), close: n('close'), volume: n('volume'), oi: n('oi'), changeOi: n('changeOi'), iv: n('iv'), bid: n('bid'), ask: n('ask') });
  }
  const unique = new Map<string, HistoricalOptionObservation>();
  for (const observation of observations) {
    const key = `${observation.timestamp}|${observation.underlying}|${observation.expiry}|${observation.strike}|${observation.optionType}`;
    const previous = unique.get(key);
    if (previous && Object.keys(observation).some((key) => previous[key as keyof HistoricalOptionObservation] !== observation[key as keyof HistoricalOptionObservation])) {
      throw new Error(`Conflicting duplicate historical option observations for ${observation.underlying} ${observation.expiry} ${observation.strike} ${observation.optionType} at ${observation.timestamp}.`);
    }
    if (!previous) unique.set(key, observation);
  }
  return [...unique.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

export class HistoricalOptionDataProvider {
  async getHistoricalOptions(symbol: string, from?: string, to?: string): Promise<HistoricalOptionObservation[]> {
    const path = process.env.BACKTEST_OPTIONS_FILE;
    if (!path) throw new Error('Historical option data unavailable for the selected period. BACKTEST_OPTIONS_FILE is not configured. The backtest requires intraday option quotes near both selected times; jugaad-data exposes daily derivatives history and cannot provide those prices.');
    let contents: string;
    try { contents = await fs.readFile(path, 'utf8'); } catch { throw new Error('Historical option data unavailable for the selected period.'); }
    const result = parseHistoricalOptionsCsv(contents, symbol, from, to);
    if (!result.length) throw new Error('Historical option data unavailable for the selected period.');
    return result;
  }
}
