/**
 * Report routes, registered inside the finance scope (so the module-off rule, the Pentadbir MAXCOM view log and
 * no-store apply). The JSON is finance:read; the PDF and the share note are finance:write: an AJK reads the report in
 * the app and does not get the file. Every download and every share leaves a history row.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import { klDateOf } from '@surau/core';
import { tooMany } from '../auth/authz.ts';
import type { Limiters } from '../auth/authz.ts';
import { logChange } from '../auth/users.ts';
import { surauPublicInfo } from '../settingsStore.ts';
import { renderReportPdf } from './pdf.ts';
import { reportFor } from './report.ts';
import { monthStatus } from './store.ts';

export interface ReportRouteDeps {
  db: DatabaseSync;
  role: 'box' | 'cloud';
  now: () => Date;
  limiters: Limiters;
  actorOf: (request: FastifyRequest) => string;
  deviceOf: (request: FastifyRequest) => string | undefined;
}

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const VIA = new Set(['whatsapp', 'email', 'other']);

/** `Surau D'Waqaf` -> `Surau-D-Waqaf` (letters and digits only, 40 characters at most). */
export function fileSlug(name: string): string {
  const s = name.normalize('NFKD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '');
  return s === '' ? 'Surau' : s;
}

export function registerReportRoutes(scope: FastifyInstance, deps: ReportRouteDeps): void {
  const { db } = deps;
  const audit = (request: FastifyRequest, ym: string, body: Record<string, unknown>): void => {
    const device = deps.deviceOf(request);
    logChange(db, deps.actorOf(request), 'finance:report', ym, undefined, { ym, ...body }, device === undefined ? undefined : { deviceId: device });
  };
  const okMonth = (ym: string): boolean => YM_RE.test(ym) && ym <= klDateOf(deps.now()).slice(0, 7);

  scope.get('/api/finance/report/:ym', async (request, reply) => {
    const { ym } = request.params as { ym: string };
    if (!okMonth(ym)) return reply.code(400).send({ errors: ['ym must be a month that has begun, YYYY-MM'] });
    return reportFor(db, ym, deps.now(), deps.role);
  });

  scope.get('/api/finance/report/:ym.pdf', async (request, reply) => {
    const a = request.auth;
    const key = a !== null && a !== undefined && a.kind === 'user' ? `s:${a.sessionId}` : `ip:${request.ip}`;
    const hit = deps.limiters.financePdf.hit(key);
    if (!hit.ok) return tooMany(reply, hit.retryAfterSec);
    const { ym } = request.params as { ym: string };
    if (!okMonth(ym)) return reply.code(400).send({ errors: ['ym must be a month that has begun, YYYY-MM'] });
    const report = reportFor(db, ym, deps.now(), deps.role);
    const info = surauPublicInfo(db, deps.now());
    let closed: { at: string; by: string } | undefined;
    if (monthStatus(db, ym) === 'closed') {
      const m = db.prepare('SELECT closed_at, closed_by FROM finance_months WHERE ym = ?').get(ym);
      if (m !== undefined && typeof m.closed_at === 'string') {
        const id = typeof m.closed_by === 'string' ? m.closed_by.replace(/^user:/, '') : '';
        const u = id === '' ? undefined : db.prepare('SELECT name FROM users WHERE id = ?').get(id);
        closed = { at: m.closed_at, by: typeof u?.name === 'string' ? u.name : '' };
      }
    }
    const pdf = renderReportPdf(report, { name: info.name, kind: info.kind, ...(info.shortAddress ? { shortAddress: info.shortAddress } : {}) }, closed);
    audit(request, ym, { action: 'download' });
    return reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `attachment; filename="Penyata-Kewangan-${fileSlug(info.name)}-${ym}.pdf"`)
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(pdf);
  });

  scope.post('/api/finance/report/:ym/shared', async (request, reply) => {
    const { ym } = request.params as { ym: string };
    if (!okMonth(ym)) return reply.code(400).send({ errors: ['ym must be a month that has begun, YYYY-MM'] });
    const body = request.body;
    const via = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { via?: unknown }).via : undefined;
    if (typeof via !== 'string' || !VIA.has(via)) return reply.code(400).send({ errors: ['via must be whatsapp, email or other'] });
    audit(request, ym, { action: 'share', via });
    return { ok: true };
  });
}
