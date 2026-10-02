import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { prisma } from '@/lib/db/prisma';

export async function GET() {
  const sessionUser = await getSessionUser();
  if (!sessionUser) {
    return NextResponse.json({ user: null }, { status: 401 });
  }

  const dbUser = await prisma.user.findUnique({
    where: { id: sessionUser.userId },
    include: { virtualAccount: true },
  });

  if (!dbUser || dbUser.status !== 'ACTIVE') {
    return NextResponse.json({ user: null }, { status: 403 });
  }

  return NextResponse.json({
    user: {
      id: dbUser.id,
      email: dbUser.email,
      username: dbUser.username,
      displayName: dbUser.displayName,
      role: dbUser.role,
      balance: dbUser.virtualAccount ? Number(dbUser.virtualAccount.balance) : 0,
      reservedBalance: dbUser.virtualAccount ? Number(dbUser.virtualAccount.reservedBalance) : 0,
      cryptoBalance: dbUser.virtualAccount ? Number(dbUser.virtualAccount.cryptoBalance ?? 1000000) : 1000000,
      cryptoReservedBalance: dbUser.virtualAccount ? Number(dbUser.virtualAccount.cryptoReservedBalance ?? 0) : 0,
    },
  });
}
