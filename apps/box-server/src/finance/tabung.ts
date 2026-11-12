/** The donation card for the TV: live figures from the ledger, or the hand-typed rows while finance is off. */
import type { DatabaseSync } from 'node:sqlite';
import { effective, klDateOf, signOf } from '@surau/core';
import type { EffectiveEntry, Fund, Settings, TabungCardView, TabungRow } from '@surau/core';
import { allEntries, listFunds } from './store.ts';

type Raw = Record<string, unknown> | undefined;
const feat = (s: Settings, k: string): Raw => (s as unknown as Record<string, Raw>)[k];
const intOr = (v: unknown, fb: number): number => (typeof v === 'number' && Number.isSafeInteger(v) ? v : fb);
const ASSET = /^[0-9a-f]{64}$/;

const FIGURES = ['balance', 'month', 'lastEntry'] as const;

/** `null` when the card is off; a manual card while finance is off; else the live card of the public tabung. */
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function buildTabung(db: DatabaseSync, now: Date, settings: Settings): TabungCardView | null {
  const card = feat(settings, 'tabungCard');
  if (card === undefined || card.enabled !== true) return null;
  const qr = typeof card.qrAssetId === 'string' && ASSET.test(card.qrAssetId) ? card.qrAssetId : null;
  const figure = FIGURES.find((f) => f === card.figure) ?? 'balance';

  if (feat(settings, 'finance')?.enabled !== true) {
    const rows: TabungRow[] = [];
    for (const n of [1, 2, 3]) {
      const label = typeof card[`row${n}Label`] === 'string' ? (card[`row${n}Label`] as string).trim() : '';
      if (label === '') continue;
      rows.push({ id: `manual-${n}`, name: label, valueSen: intOr(card[`row${n}Sen`], 0), subLabel: null, subSen: null, targetSen: null, highlightUntil: null });
    }
    const edited = db.prepare("SELECT edited_at, updated_at FROM settings WHERE feature = 'tabungCard'").get();
    const title = typeof card.manualTitle === 'string' && card.manualTitle.trim() !== '' ? card.manualTitle.trim() : 'Tabung Surau';
    return {
      title, manual: true, figure, rows, qrAssetId: qr,
      updatedAt: edited === undefined ? null : String(edited.edited_at ?? edited.updated_at),
    };
  }

  const ym = klDateOf(now).slice(0, 7);
  const eff = effective(allEntries(db));
  const showTarget = card.showTarget !== false;
  const highlightMs = Math.max(0, Math.min(120, intOr(card.highlightSeconds, 20))) * 1000;

  const byFund = new Map<string, EffectiveEntry[]>();
  for (const e of eff) {
    const l = byFund.get(e.effFundId);
    if (l) l.push(e); else byFund.set(e.effFundId, [e]);
  }
  const touchOf = (e: EffectiveEntry): number => Math.max(Date.parse(e.receivedAt), ...e.corrections.map((c) => Date.parse(c.receivedAt)));
  let latest = 0;
  for (const e of eff) latest = Math.max(latest, touchOf(e) || 0);

  const rows: TabungRow[] = [];
  for (const f of listFunds(db) as Fund[]) {
    if (!f.public) continue;
    const mine = (byFund.get(f.id) ?? []).filter((e) => !e.voided);
    const balance = mine.reduce((a, e) => a + signOf(e.kind) * e.effAmountSen, 0);
    const monthMoves = mine.filter((e) => (e.kind === 'in' || e.kind === 'out') && e.entryDate.slice(0, 7) === ym);
    const monthNet = monthMoves.reduce((a, e) => a + signOf(e.kind) * e.effAmountSen, 0);
    const monthIn = monthMoves.reduce((a, e) => (e.kind === 'in' ? a + e.effAmountSen : a), 0);
    const ins = mine.filter((e) => e.kind === 'in').sort((a, b) => cmpStr(a.entryDate, b.entryDate) || cmpStr(a.editedAt, b.editedAt) || cmpStr(a.id, b.id));
    const lastIn = ins.length > 0 ? ins[ins.length - 1]!.effAmountSen : 0;

    const valueSen = figure === 'month' ? monthNet : figure === 'lastEntry' ? lastIn : balance;
    let subLabel: string | null = null;
    let subSen: number | null = null;
    const targetSen = showTarget ? f.targetSen : null;
    if (f.jumaat) { subLabel = 'Kutipan Jumaat terakhir'; subSen = lastIn; }
    else if (targetSen === null) { subLabel = 'Bulan ini'; subSen = monthIn; }

    let touched = 0;
    for (const e of byFund.get(f.id) ?? []) touched = Math.max(touched, touchOf(e) || 0);
    const until = highlightMs > 0 && touched > 0 ? touched + highlightMs : 0;
    rows.push({
      id: f.id, name: f.name, valueSen, subLabel, subSen, targetSen,
      highlightUntil: until > now.getTime() ? new Date(until).toISOString() : null,
    });
  }
  return { title: 'Tabung Surau', manual: false, figure, rows, qrAssetId: qr, updatedAt: latest > 0 ? new Date(latest).toISOString() : null };
}
