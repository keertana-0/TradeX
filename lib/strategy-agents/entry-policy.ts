const ENTRY_START_DEFAULT = '09:20';
const ENTRY_START_SETTING = process.env.STRATEGY_OPTION_ENTRY_START_IST || ENTRY_START_DEFAULT;
export const STRATEGY_ENTRY_START_IST = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(ENTRY_START_SETTING) ? ENTRY_START_SETTING : ENTRY_START_DEFAULT;

const CONFIDENCE_SETTING = Number(process.env.STRATEGY_OPTION_MIN_CONFIDENCE ?? 0.55);
export const STRATEGY_MIN_CONFIDENCE = Number.isFinite(CONFIDENCE_SETTING) ? Math.max(0, Math.min(1, CONFIDENCE_SETTING)) : 0.55;

const istClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
export function isAfterStrategyEntryStart(time: Date): boolean {
  return istClock.format(time) >= STRATEGY_ENTRY_START_IST;
}
