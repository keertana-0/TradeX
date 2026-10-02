export interface DailyHistoricalOptionObservation {
  date: string;
  underlying: string;
  underlyingPrice: number;
  expiry: string;
  strike: number;
  optionType: 'CE' | 'PE';
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  ltp: number;
  volume?: number | null;
  oi?: number | null;
  changeOi?: number | null;
}

export interface HistoricalOptionsCoverage {
  requestedFrom: string;
  requestedTo: string;
  observedSessions: number;
  failedDateCount: number;
  failedDates: string[];
}

export type DailyOptionsProviderName = 'jugaad-data' | 'bseindia';

export interface DailyOptionsDataQuality {
  rawCandidateRows: number;
  acceptedRows: number;
  rejectedRows: number;
  rejectionCounts: Record<string, number>;
}
