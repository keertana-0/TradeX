import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getLatestCompetition, stopCompetition } from '@/lib/strategy-agents/service';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: { competitionId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in to stop strategy agents.' }, { status: 401 });
  try {
    const stopped = await stopCompetition(user.userId, params.competitionId);
    if (!stopped) return NextResponse.json({ error: 'Active strategy session not found.' }, { status: 404 });
    return NextResponse.json({ competition: await getLatestCompetition(user.userId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to stop strategy agents.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
