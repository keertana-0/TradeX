import { createReadStream } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import type { Candle } from '../types/market';
import { runIndependentStrategyBacktests } from '../lib/strategy-agents/backtest';

const root = process.cwd();
const inputRoot = path.join(root, 'data', 'historical-options');
const timeframeMinutes = Math.max(1, Math.min(60, Number(process.env.STRATEGY_AGENT_TIMEFRAME_MINUTES || 5)));

async function readCsv(file: string): Promise<Candle[]> {
  const lines = readline.createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  const result: Candle[] = []; let header = true;
  for await (const line of lines) {
    if (header) { header = false; continue; }
    const [timestampText, open, high, low, close, volume] = line.split(',');
    const timestamp = new Date(`${timestampText.replace(' ', 'T')}+05:30`);
    const values = [Number(open), Number(high), Number(low), Number(close), Number(volume || 0)];
    if (!Number.isFinite(timestamp.getTime()) || values.slice(0, 4).some(v => !Number.isFinite(v) || v <= 0)) continue;
    result.push({ time: Math.floor(timestamp.getTime() / 1000), open: values[0], high: values[1], low: values[2], close: values[3], volume: values[4] });
  }
  return result;
}

function aggregate(candles: Candle[], minutes: number) {
  if (minutes === 1) return candles;
  const groups = new Map<number, Candle[]>();
  for (const candle of candles) {
    const key = Math.floor(candle.time / (minutes * 60)) * minutes * 60;
    const group = groups.get(key) || []; group.push(candle); groups.set(key, group);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([time, group]) => {
    // Use only complete intervals, using source timestamps so partial candles cannot leak into decisions.
    const sorted = group.sort((a, b) => a.time - b.time);
    if (sorted.length < minutes || sorted.at(-1)!.time - sorted[0].time < (minutes - 1) * 60) return [];
    return [{ time, open: sorted[0].open, high: Math.max(...sorted.map(x => x.high)), low: Math.min(...sorted.map(x => x.low)), close: sorted.at(-1)!.close, volume: sorted.reduce((s, x) => s + x.volume, 0) }];
  });
}

async function main() {
  const folders = await readdir(inputRoot, { withFileTypes: true });
  const all = new Map<number, Candle>();
  for (const folder of folders.filter(entry => entry.isDirectory())) {
    const file = path.join(inputRoot, folder.name, 'nifty_spot.csv');
    try { for (const candle of await readCsv(file)) all.set(candle.time, candle); } catch { /* folders without spot candles are ignored */ }
  }
  const minuteCandles = [...all.values()].sort((a, b) => a.time - b.time);
  const candles = aggregate(minuteCandles, timeframeMinutes);
  if (candles.length < 250) throw new Error(`Only ${candles.length} complete ${timeframeMinutes}-minute NIFTY candles were found; at least 250 are required.`);
  const report = runIndependentStrategyBacktests(candles, timeframeMinutes);
  const outputDir = path.join(root, 'data', 'strategy-backtests');
  await mkdir(outputDir, { recursive: true });
  const output = path.join(outputDir, 'independent-strategy-results.json');
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output, timeframeMinutes, data: report.data, periods: report.strategies.map(strategy => ({ strategy: strategy.strategy, train: strategy.periods.training.metrics, validation: strategy.periods.validation.metrics, test: strategy.periods.testing.metrics })) }, null, 2));
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
