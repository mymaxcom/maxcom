export type SurauStatus = 'ok' | 'offline' | 'waiting' | 'suspended';

export interface Surau {
  id: string;
  name: string;
  kind: string;
  location: string;
  zone: string;
  createdAt: string;
  linkedAt: string | null;
  reviewedAt: string | null;
  suspendedAt: string | null;
  suspendedReason: string | null;
}

export interface PendingBox {
  boxId: string;
  name: string;
  claimCode: string;
  at: string;
  boxName?: string;
  platform?: string;
  version?: string;
}

export const SURAU_ID_RE = /^[a-z0-9-]{2,40}$/;
