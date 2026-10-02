import { prisma } from '@/lib/db/prisma';
import { tickCompetition } from './service';

declare global {
  // eslint-disable-next-line no-var
  var __tradexStrategyWorkerTimer: ReturnType<typeof setInterval> | undefined;
  // eslint-disable-next-line no-var
  var __tradexStrategyWorkerRunning: boolean | undefined;
}

const WORKER_INTERVAL_MS = 15_000;

async function processActiveSessions() {
  if (globalThis.__tradexStrategyWorkerRunning) return;
  globalThis.__tradexStrategyWorkerRunning = true;
  try {
    const sessions = await prisma.strategyCompetition.findMany({
      where: { status: { in: ['WAITING_FOR_MARKET', 'WAITING_FOR_LIVE_DATA', 'RUNNING'] } },
      select: { id: true, userId: true },
    });
    for (const session of sessions) {
      try { await tickCompetition(session.userId, session.id); }
      catch (error) { console.error('[strategy-agent-worker] session tick failed', session.id, error); }
    }
  } catch (error) {
    console.error('[strategy-agent-worker] could not load active sessions', error);
  } finally {
    globalThis.__tradexStrategyWorkerRunning = false;
  }
}

export function startStrategyAgentWorker() {
  if (globalThis.__tradexStrategyWorkerTimer) return;
  globalThis.__tradexStrategyWorkerTimer = setInterval(() => { void processActiveSessions(); }, WORKER_INTERVAL_MS);
  globalThis.__tradexStrategyWorkerTimer.unref?.();
  void processActiveSessions();
  console.info('[strategy-agent-worker] started; active paper sessions tick every 15 seconds');
}
