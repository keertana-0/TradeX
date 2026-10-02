import { afterEach, describe, expect, it, vi } from 'vitest';
import { HistoricalOptionDataProvider, parseHistoricalOptionsCsv } from '@/lib/market-data/historical-option-provider';

vi.mock('node:fs/promises', () => {
  const mockedReadFile = vi.fn();
  return { default: { readFile: mockedReadFile }, readFile: mockedReadFile };
});
import { readFile } from 'node:fs/promises';

const csv = [
  'timestamp,symbol,expiry,strike,option_type,spot,ltp,volume,oi',
  '2025-01-02 09:30:00,NIFTY,30-Jan-2025,23000,CALL,23010,120.5,1000,2500',
].join('\n');

describe('historical options provider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.BACKTEST_OPTIONS_FILE;
  });

  it('parses quoted CSV cells, aliases and normalizes the NSE schema', () => {
    const rows = parseHistoricalOptionsCsv([
      'timestamp,symbol,expiry,strike,option_type,spot,ltp,volume,oi',
      '"2025-01-02 09:30:00","NIFTY",30-Jan-2025,23000,call,23010,120.5,1000,2500',
    ].join('\n'), 'NIFTY50');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      underlying: 'NIFTY50', expiry: '2025-01-30', strike: 23000,
      optionType: 'CE', underlyingPrice: 23010, ltp: 120.5, volume: 1000, oi: 2500,
    });
    expect(rows[0].timestamp).toBe('2025-01-02T04:00:00.000Z');
  });

  it('accepts date-only observations as exchange-local midnight and filters the requested dates', () => {
    const result = parseHistoricalOptionsCsv([
      'date,symbol,expiry,strike,type,spot,ltp',
      '2025-01-02,NIFTY,2025-01-30,23000,PE,23010,120',
      '2025-01-03,NIFTY,2025-01-30,23000,PE,23020,115',
    ].join('\n'), 'NIFTY50', '2025-01-03', '2025-01-03');

    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe('2025-01-02T18:30:00.000Z');
    expect(result[0].optionType).toBe('PE');
  });

  it('drops invalid prices and malformed expiries rather than treating blanks as zero', () => {
    const result = parseHistoricalOptionsCsv([
      'timestamp,symbol,expiry,strike,option_type,spot,ltp,volume',
      '2025-01-02 09:30:00,NIFTY,30-Jan-2025,,CE,23010,120,12',
      '2025-01-02 09:30:00,NIFTY,not-an-expiry,23000,PE,23010,120,12',
      '2025-01-02 09:30:00,NIFTY,30-Jan-2025,23000,PE,23010,,12',
    ].join('\n'));
    expect(result).toEqual([]);
  });

  it('removes identical duplicate contract observations and rejects conflicting duplicates', () => {
    const duplicate = [csv, csv.split('\n')[1]].join('\n');
    expect(parseHistoricalOptionsCsv(duplicate)).toHaveLength(1);
    expect(() => parseHistoricalOptionsCsv(duplicate.replace('120.5,1000', '121,1000'))).toThrow(/Conflicting duplicate/);
  });

  it('keeps BACKTEST_OPTIONS_FILE as the selected file provider', async () => {
    process.env.BACKTEST_OPTIONS_FILE = 'historical.csv';
    vi.mocked(readFile).mockResolvedValue(csv);
    const rows = await new HistoricalOptionDataProvider().getHistoricalOptions('NIFTY50');
    expect(readFile).toHaveBeenCalledWith('historical.csv', 'utf8');
    expect(rows).toHaveLength(1);
  });

  it('reports the missing file configuration explicitly', async () => {
    await expect(new HistoricalOptionDataProvider().getHistoricalOptions('NIFTY50'))
      .rejects.toThrow('BACKTEST_OPTIONS_FILE is not configured');
  });

  it('reports malformed CSV headers and unterminated quoted cells', () => {
    expect(() => parseHistoricalOptionsCsv('timestamp,symbol\n')).toThrow(/missing required columns/);
    expect(() => parseHistoricalOptionsCsv('timestamp,symbol,expiry,strike,option_type,spot,ltp\n"bad'))
      .toThrow(/unterminated quoted field/);
  });
});
