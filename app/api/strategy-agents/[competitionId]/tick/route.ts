import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { tickCompetition } from '@/lib/strategy-agents/service';

export const dynamic = 'force-dynamic';

export async function POST(_request: Request, { params }: { params: { competitionId: string } }) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: 'Sign in to update strategy agents.' }, { status: 401 });
  try {
    const competition = await tickCompetition(user.userId, params.competitionId);
    if (!competition) return NextResponse.json({ error: 'Strategy session not found.' }, { status: 404 });
    return NextResponse.json({ competition });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update strategy agents.';
    return NextResponse.json({ error: message }, { status: 503 });
  }
}
