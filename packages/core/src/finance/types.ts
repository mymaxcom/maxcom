/** Finance types shared by the box, the cloud and the app. Every amount is an integer number of sen. */

export type EntryKind = 'in' | 'out' | 'opening' | 'adjust';
export type Method = 'tunai' | 'bank' | 'duitnow' | 'cek';
export type CorrectionKind = 'amount' | 'void' | 'fund';
export type Counter = { userId: string } | { name: string };

/** The names used when an entry was made, kept so a later rename never rewrites the record. `counters` is keyed by user id. */
export interface EntryNames {
  createdBy: string | null;
  device: string | null;
  counters: Record<string, string>;
  /** The IDs (`U-0001`, `D-0001`) of the same people and device, stored when known and filled at read when missing. */
  createdByRef?: string | null;
  deviceRef?: string | null;
  counterRefs?: Record<string, string>;
}

export interface Denominations {
  '100'?: number;
  '50'?: number;
  '20'?: number;
  '10'?: number;
  '5'?: number;
  '1'?: number;
  coinsSen?: number;
}

export interface Fund {
  id: string;
  name: string;
  public: boolean;
  targetSen: number | null;
  jumaat: boolean;
  sortOrder: number;
  archivedAt: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface Perihal {
  id: string;
  direction: 'in' | 'out';
  label: string;
  system: 'penceramah' | null;
  sortOrder: number;
  archivedAt: string | null;
  updatedAt: string;
  updatedBy: string;
}

export interface FinanceEntry {
  id: string;
  kind: EntryKind;
  /** KL date YYYY-MM-DD. */
  entryDate: string;
  fundId: string;
  perihalId: string | null;
  amountSen: number;
  method: Method | null;
  reference: string | null;
  note: string | null;
  payee: string | null;
  counters: Counter[] | null;
  denominations: Denominations | null;
  photoId: string | null;
  kuliahId: string | null;
  penceramahId: string | null;
  penceramahName: string | null;
  correctsId: string | null;
  correctionKind: CorrectionKind | null;
  toFundId: string | null;
  reason: string | null;
  refNo: string | null;
  createdBy: string;
  deviceId: string | null;
  editedAt: string;
  receivedAt: string;
  cloudReceivedAt: string | null;
  /** Names at the time the entry was made (null on an entry from before they were kept). */
  names?: EntryNames | null;
}

export interface MonthState {
  ym: string;
  status: 'open' | 'closed';
  closedAt: string | null;
  closedBy: string | null;
  /** The report as it was when the month was closed (names and figures frozen); null while the month is open. */
  report: MonthReport | null;
  /** Ids of entries that reached this side after the month was closed (absent when there are none). */
  lateEntries?: string[];
}

export interface PhotoMeta {
  id: string;
  entryId: string;
  mime: string;
  bytes: number;
  present: boolean;
}

export interface FinanceSnapshot {
  funds: Fund[];
  perihal: Perihal[];
  entries: FinanceEntry[];
  /** A month row also carries its own edit stamp so a puller can judge it against its own copy. */
  months: (MonthState & { editedAt?: string; rev?: string })[];
  photos: PhotoMeta[];
}

export interface EffectiveEntry extends FinanceEntry {
  effFundId: string;
  effAmountSen: number;
  voided: boolean;
  corrections: FinanceEntry[];
}

export interface ReportFundRow {
  fundId: string;
  name: string;
  openingSen: number;
  inSen: number;
  outSen: number;
  correctionsSen: number;
  closingSen: number;
}

export interface ReportInRow { date: string; refNo: string | null; note: string | null; amountSen: number }
export interface ReportOutRow extends ReportInRow {
  payee: string | null;
  penceramahName: string | null;
  kuliahTitle: string | null;
  kuliahDate: string | null;
}

export interface ReportGroup<R> {
  perihalId: string;
  label: string;
  fundId: string;
  rows: R[];
  totalSen: number;
}

export interface ReportCorrection {
  id: string;
  date: string;
  refNo: string | null;
  originalRefNo: string | null;
  kind: CorrectionKind;
  reason: string;
  deltaSen: number;
  fundName: string;
  lastMonth: boolean;
}

export interface MonthReport {
  ym: string;
  status: 'open' | 'closed';
  generatedAt: string;
  syncedUntil: string | null;
  funds: ReportFundRow[];
  inByPerihal: ReportGroup<ReportInRow>[];
  outByPerihal: ReportGroup<ReportOutRow>[];
  corrections: ReportCorrection[];
  totals: { openingSen: number; inSen: number; outSen: number; correctionsSen: number; closingSen: number };
  /** Ids of entries that reached this side after the month was closed; never part of the frozen figures. */
  lateEntries?: string[];
}

export interface TabungRow {
  id: string;
  name: string;
  valueSen: number;
  subLabel: string | null;
  subSen: number | null;
  targetSen: number | null;
  highlightUntil: string | null;
}

export interface TabungCardView {
  title: string;
  manual: boolean;
  figure: 'balance' | 'month' | 'lastEntry';
  rows: TabungRow[];
  updatedAt: string | null;
  qrAssetId: string | null;
}
