import { NextResponse } from 'next/server';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getSessionUser } from '@/lib/auth/session';

export const dynamic = 'force-dynamic';

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in to view strategy validation results.' }, { status: 401 });
  try {
    const reportPath = path.join(process.cwd(), 'data', 'strategy-backtests', 'independent-strategy-results.json');
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    return NextResponse.json({ report });
  } catch {
    return NextResponse.json({ report: null, message: 'Run npm run backtest:strategy-agents to generate validation results.' });
  }
}
