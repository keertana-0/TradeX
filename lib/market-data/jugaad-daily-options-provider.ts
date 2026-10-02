import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { DailyHistoricalOptionObservation, DailyOptionsDataQuality, DailyOptionsProviderName, HistoricalOptionsCoverage } from '@/types/daily-options';

const execFileAsync = promisify(execFile);

export interface DailyOptionsDataset {
  provider: DailyOptionsProviderName;
  granularity: 'daily';
  observations: DailyHistoricalOptionObservation[];
  coverage: HistoricalOptionsCoverage;
  quality: DailyOptionsDataQuality;
}

export class JugaadDailyOptionsProvider {
  async getHistoricalOptions(symbol: string, from: string, to: string): Promise<DailyOptionsDataset> {
    const root = process.cwd();
    const script = path.join(root, 'services', 'stock-analysis', 'get_historical_options.py');
    let dataset: DailyOptionsDataset;
    const serviceUrl = process.env.JUGAAD_HISTORICAL_API_URL;
    if (serviceUrl) {
      const url = new URL(`/api/backtest/daily-options/${encodeURIComponent(symbol)}`, serviceUrl);
      url.searchParams.set('from', from);
      url.searchParams.set('to', to);
      let response: Response;
      const headers = process.env.JUGAAD_HISTORICAL_API_TOKEN
        ? { Authorization: `Bearer ${process.env.JUGAAD_HISTORICAL_API_TOKEN}` }
        : undefined;
      try { response = await fetch(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(300_000) }); }
      catch (error) { throw new Error(error instanceof Error ? `Historical-data service request failed: ${error.message}` : 'Historical-data service request failed.'); }
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `Historical-data service returned HTTP ${response.status}.`);
      dataset = payload as DailyOptionsDataset;
    } else {
      const configuredPython = process.env.PYTHON_EXECUTABLE;
      const localPython = process.platform === 'win32'
        ? path.join(root, 'services', 'stock-analysis', '.venv', 'Scripts', 'python.exe')
        : path.join(root, 'services', 'stock-analysis', '.venv', 'bin', 'python');
      const python = configuredPython || (fs.existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
      if (!fs.existsSync(script)) throw new Error('The Jugaad daily history adapter is missing from the server installation.');

      let stdout: string;
      try {
        ({ stdout } = await execFileAsync(python, [script, symbol, from, to], {
          cwd: root, windowsHide: true, timeout: 270_000, maxBuffer: 64 * 1024 * 1024,
        }));
      } catch (error) {
        const detail = error as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
        if (detail.code === 'ENOENT') throw new Error('Python was not found. Install the stock-analysis requirements or set PYTHON_EXECUTABLE.');
        if (detail.killed) throw new Error('Jugaad historical data retrieval exceeded the request time limit. Narrow the date range and try again.');
        throw new Error(detail.stderr?.trim() || detail.message || 'Jugaad could not retrieve historical NSE options data.');
      }

      try { dataset = JSON.parse(stdout) as DailyOptionsDataset; }
      catch { throw new Error('The Jugaad adapter returned malformed data.'); }
    }
    if (!['jugaad-data', 'bseindia'].includes(dataset.provider) || dataset.granularity !== 'daily' || !Array.isArray(dataset.observations) ||
      !dataset.coverage || !Number.isInteger(dataset.coverage.observedSessions) || dataset.coverage.observedSessions < 0 ||
      !Number.isInteger(dataset.coverage.failedDateCount) || dataset.coverage.failedDateCount < 0 || !Array.isArray(dataset.coverage.failedDates)) {
      throw new Error('The Jugaad adapter returned an invalid daily options dataset.');
    }
    if (!dataset.quality || !Number.isInteger(dataset.quality.rawCandidateRows) || dataset.quality.rawCandidateRows < 0 ||
      !Number.isInteger(dataset.quality.acceptedRows) || dataset.quality.acceptedRows < 0 ||
      !Number.isInteger(dataset.quality.rejectedRows) || dataset.quality.rejectedRows < 0 ||
      !dataset.quality.rejectionCounts || typeof dataset.quality.rejectionCounts !== 'object' || Array.isArray(dataset.quality.rejectionCounts)) {
      throw new Error('The historical options provider returned an invalid data-cleaning summary.');
    }
    for (const count of Object.values(dataset.quality.rejectionCounts)) {
      if (!Number.isInteger(count) || count < 0) throw new Error('The historical options provider returned an invalid data-cleaning summary.');
    }
    const rejectionCounts = { ...dataset.quality.rejectionCounts };
    const seenContracts = new Set<string>();
    const filtered = dataset.observations.filter((row) => {
      let reason: string | undefined;
      const validDate = typeof row?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.date) &&
        !Number.isNaN(Date.parse(`${row.date}T00:00:00Z`));
      const validExpiry = typeof row?.expiry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.expiry) &&
        !Number.isNaN(Date.parse(`${row.expiry}T00:00:00Z`));
      if (!row || !validDate || row.date < from || row.date > to) reason = 'wrong_or_invalid_trade_date';
      else if (!validExpiry || row.expiry < row.date || !['CE', 'PE'].includes(row.optionType) ||
        !Number.isFinite(row.strike) || row.strike <= 0 || !Number.isFinite(row.underlyingPrice) || row.underlyingPrice <= 0) {
        reason = 'invalid_contract_or_underlying';
      } else if (![row.open, row.high, row.low, row.close].every((value) => Number.isFinite(value) && Number(value) > 0)) {
        reason = 'incomplete_ohlc';
      } else if (row.low! > row.high! || row.open! < row.low! || row.open! > row.high! || row.close < row.low! || row.close > row.high!) {
        reason = 'inconsistent_ohlc';
      } else if (!Number.isFinite(row.volume) || Number(row.volume) <= 0) reason = 'no_traded_volume';
      else if (row.underlying !== symbol) reason = 'wrong_underlying';
      else {
        const contractKey = `${row.date}|${row.expiry}|${row.strike}|${row.optionType}`;
        if (seenContracts.has(contractKey)) reason = 'duplicate_contract_rows';
        else seenContracts.add(contractKey);
      }
      if (reason) rejectionCounts[reason] = (rejectionCounts[reason] || 0) + 1;
      return !reason;
    });
    const adapterRejected = dataset.observations.length - filtered.length;
    const quality: DailyOptionsDataQuality = {
      rawCandidateRows: Math.max(dataset.quality.rawCandidateRows, dataset.quality.acceptedRows + dataset.quality.rejectedRows),
      acceptedRows: filtered.length,
      rejectedRows: dataset.quality.rejectedRows + adapterRejected,
      rejectionCounts,
    };
    if (!filtered.length) throw new Error(`Jugaad returned no valid daily ${symbol} option prices between ${from} and ${to}.`);
    return { ...dataset, observations: filtered, quality };
  }
}
