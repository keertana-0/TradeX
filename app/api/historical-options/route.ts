import { NextRequest, NextResponse } from 'next/server';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

type Row = { timestamp: string; open: number; high: number; low: number; close: number; volume: number; strike: number; option_type: string };

function dataRoot() {
  return process.env.TRADEX_HISTORICAL_OPTIONS_DIR || path.resolve(process.cwd(), 'data', 'historical-options');
}

function parseCsv(text: string): Row[] {
  const lines = text.trim().split(/\r?\n/);
  return lines.slice(1).flatMap((line) => {
    const [timestamp, open, high, low, close, volume, , strike, option_type] = line.split(',');
    const values = [open, high, low, close, volume, strike].map(Number);
    if (!timestamp || values.some((value) => !Number.isFinite(value))) return [];
    return [{ timestamp, open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4], strike: values[5], option_type }];
  });
}

export async function GET(request: NextRequest) {
  try {
    const root = dataRoot();
    const expiry = request.nextUrl.searchParams.get('expiry') || '';
    const kind = request.nextUrl.searchParams.get('kind') || 'spot';
    const optionType = request.nextUrl.searchParams.get('type') || 'CE';
    const strike = request.nextUrl.searchParams.get('strike') || '';
    const date = request.nextUrl.searchParams.get('date') || '';
    const expiries = (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^\d{8}$/.test(entry.name)).map((entry) => entry.name).sort();
    if (!expiry) return NextResponse.json({ expiries });
    if (!/^\d{8}$/.test(expiry) || !expiries.includes(expiry)) return NextResponse.json({ error: 'Unknown expiry folder.' }, { status: 400 });

    const folder = path.join(root, expiry);
    if (kind === 'spot') {
      const rows = parseCsv(await readFile(path.join(folder, 'nifty_spot.csv'), 'utf8'));
      const dates = [...new Set(rows.map((row) => row.timestamp.slice(0, 10)))].sort();
      const selectedDate = date || dates[dates.length - 1];
      return NextResponse.json({ expiries, dates, date: selectedDate, candles: rows.filter((row) => row.timestamp.startsWith(selectedDate)).map((row) => ({ time: Math.floor(new Date(`${row.timestamp.replace(' ', 'T')}+05:30`).getTime() / 1000), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume })) });
    }

    if (!['CE', 'PE'].includes(optionType)) return NextResponse.json({ error: 'Invalid option type.' }, { status: 400 });
    const files = (await readdir(folder)).filter((name) => name.endsWith(`${optionType}_${expiry}.csv`) && /^\d+/.test(name));
    const strikes = files.map((name) => Number(name.split('_')[0].replace(optionType, ''))).filter(Number.isFinite).sort((a, b) => a - b);
    const selectedStrike = strike ? Number(strike) : strikes[Math.floor(strikes.length / 2)];
    if (!strikes.includes(selectedStrike)) return NextResponse.json({ error: 'Unknown strike for this expiry.' }, { status: 400 });
    const filename = `${selectedStrike}${optionType}_${expiry}.csv`;
    const rows = parseCsv(await readFile(path.join(folder, filename), 'utf8'));
    const dates = [...new Set(rows.map((row) => row.timestamp.slice(0, 10)))].sort();
    const selectedDate = date || dates[dates.length - 1];
    return NextResponse.json({ expiries, strikes, dates, date: selectedDate, strike: selectedStrike, type: optionType, candles: rows.filter((row) => row.timestamp.startsWith(selectedDate)).map((row) => ({ time: Math.floor(new Date(`${row.timestamp.replace(' ', 'T')}+05:30`).getTime() / 1000), open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume })) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Historical options data could not be read.';
    return NextResponse.json({ error: message, hint: 'Set TRADEX_HISTORICAL_OPTIONS_DIR to the folder containing the expiry directories.' }, { status: 500 });
  }
}
