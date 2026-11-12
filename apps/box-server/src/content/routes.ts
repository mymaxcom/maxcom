import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseSync } from 'node:sqlite';
import type { ChangeBus } from '../events.ts';
import { identityCan } from '../auth/authz.ts';
import { getVersion } from '../settingsStore.ts';
import { ContentError, deleteItem, getItem, listItems, putItem } from './store.ts';
import { CONTENT_IMAGE_FIELDS, isContentKind, validateContent } from '@surau/core';
import type { ImageRef } from '@surau/core';
import { AssetError } from '../assets/store.ts';
import { deriveImage, ImageAdjustError } from '../imageAdjust.ts';

export interface ContentRouteDeps {
  db: DatabaseSync;
  bus: ChangeBus;
  /** Where assets live: adjusted pictures are rendered into it when an item is saved. */
  dataDir: string;
  actorOf: (request: FastifyRequest) => string;
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A speaker's private phone number is for the people who edit content. Every other reader (the
 * read-only roles) gets the item without it.
 */
function forReader<T>(request: FastifyRequest, kind: string, item: T): T {
  if (kind !== 'penceramah' || identityCan(request.auth, 'content:write')) return item;
  if (typeof item !== 'object' || item === null || !('phone' in item)) return item;
  const { phone: _phone, ...rest } = item as Record<string, unknown>;
  return rest as T;
}

function fail(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof ContentError) return reply.code(error.status).send({ errors: error.errors });
  throw error;
}

export function registerContentRoutes(app: FastifyInstance, deps: ContentRouteDeps): void {
  const { db, bus, dataDir } = deps;

  app.get('/api/content/:kind', async (request, reply) => {
    const { kind } = request.params as { kind: string };
    if (!isContentKind(kind)) return reply.code(404).send({ errors: [`unknown content kind ${kind}`] });
    return { items: listItems(db, kind).map((item) => forReader(request, kind, item)) };
  });

  app.get('/api/content/:kind/:id', async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!isContentKind(kind)) return reply.code(404).send({ errors: [`unknown content kind ${kind}`] });
    const item = getItem(db, kind, id);
    if (item === null) return reply.code(404).send({ errors: [`${kind} ${id} not found`] });
    return { item: forReader(request, kind, item) };
  });

  app.put('/api/content/:kind/:id', async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!isContentKind(kind)) return reply.code(404).send({ errors: [`unknown content kind ${kind}`] });
    const body: unknown = request.body;
    if (!isPlain(body)) return reply.code(400).send({ errors: ['body must be a JSON object'] });
    // An adjusted picture is rendered now, once; a bad adjustment is refused before anything is saved.
    // (A missing source asset is left to putItem, which answers 409.)
    const checked = validateContent(kind, { ...body, id });
    if (checked.ok) {
      for (const [field, slot] of Object.entries(CONTENT_IMAGE_FIELDS[kind] ?? {})) {
        const ref = (checked.value as Record<string, unknown>)[field] as ImageRef | undefined;
        if (ref === undefined) continue;
        try {
          deriveImage(db, dataDir, slot, ref);
        } catch (error) {
          if (error instanceof ImageAdjustError && error.missing) continue;
          if (error instanceof AssetError) return reply.code(error.status).send({ errors: error.errors });
          if (error instanceof ImageAdjustError) return reply.code(400).send({ errors: [`${field}: ${error.message}`] });
          throw error;
        }
      }
    }
    try {
      const result = putItem(db, kind, { ...body, id }, deps.actorOf(request));
      bus.emit(getVersion(db));
      return reply.code(result.created ? 201 : 200).send({ item: result.item });
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete('/api/content/:kind/:id', async (request, reply) => {
    const { kind, id } = request.params as { kind: string; id: string };
    if (!isContentKind(kind)) return reply.code(404).send({ errors: [`unknown content kind ${kind}`] });
    try {
      if (!deleteItem(db, kind, id, deps.actorOf(request))) {
        return reply.code(404).send({ errors: [`${kind} ${id} not found`] });
      }
      bus.emit(getVersion(db));
      return reply.code(204).send();
    } catch (error) {
      return fail(reply, error);
    }
  });
}
