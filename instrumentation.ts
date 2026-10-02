export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { startStrategyAgentWorker } = await import('./lib/strategy-agents/worker');
  startStrategyAgentWorker();
}
