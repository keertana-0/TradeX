import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { createCompetition, getLatestCompetition, getOrCreateTodayCompetition } from '@/lib/strategy-agents/service';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in to use the strategy agents.' }, { status: 401 });

  const mode = request.nextUrl.searchParams.get('mode') === 'CRYPTO' ? 'CRYPTO' : 'INDIAN';

  try {
    const competition = await getOrCreateTodayCompetition(user.userId, mode);
    return NextResponse.json({ competition: await getLatestCompetition(user.userId, mode) || competition });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load strategy portfolios.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in to start the strategy agents.' }, { status: 401 });

  let mode: 'INDIAN' | 'CRYPTO' = 'INDIAN';
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.mode === 'CRYPTO' || request.nextUrl.searchParams.get('mode') === 'CRYPTO') {
      mode = 'CRYPTO';
    }
  } catch {
    // default to INDIAN
  }

  try {
    const competition = await createCompetition(user.userId, mode);
    return NextResponse.json({ competition: await getLatestCompetition(user.userId, mode) || competition }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to start strategy agents.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
