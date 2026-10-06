import { z } from 'zod';
import { isoDate, uuid } from './schemas/common';

export const locationSchema = z.object({
  projectId: uuid,
  parentId: uuid.nullable().default(null),
  kind: z.enum(['building', 'level', 'zone']),
  name: z.string().trim().min(1).max(120),
});
export const assetUploadSchema = z.object({
  projectId: uuid,
  filename: z
    .string()
    .trim()
    .min(1)
    .max(180)
    .refine((v) => !/[\\/]/.test(v) && !Array.from(v).some((c) => c.charCodeAt(0) < 32)),
  mime: z.enum(['application/pdf', 'image/png', 'image/jpeg', 'application/x-step']),
  base64: z
    .string()
    .min(4)
    .max(35_000_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
});
export const drawingSchema = z.object({
  projectId: uuid,
  assetId: uuid,
  code: z.string().trim().min(1).max(60),
  title: z.string().trim().min(2).max(200),
  discipline: z.enum(['architecture', 'civil', 'mechanical', 'electrical', 'other']),
  revision: z.string().trim().min(1).max(40),
  previousId: uuid.nullable().default(null),
});
export const drawingDecisionSchema = z.object({
  version: z.number().int().positive(),
  status: z.enum(['approved', 'obsolete']),
  note: z.string().trim().min(3).max(2000),
});
export const drawingPinSchema = z.object({
  drawingId: uuid,
  page: z.number().int().min(1).max(10000),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  locationId: uuid.nullable().default(null),
  recordKind: z.enum([
    'rfi',
    'quality_check',
    'safety',
    'defect',
    'site_report',
    'site_instruction',
  ]),
  recordId: uuid,
  label: z.string().trim().min(2).max(200),
  clientId: uuid,
});
export const progressPhotoSchema = z.object({
  clientId: uuid.optional(),
  projectId: uuid,
  locationId: uuid,
  assetId: uuid,
  date: isoDate,
  caption: z.string().trim().min(2).max(500),
  panorama: z.boolean().default(false),
  operationId: uuid.nullable().default(null),
});
export interface ConstructionLocation {
  id: string;
  projectId: string;
  parentId: string | null;
  kind: 'building' | 'level' | 'zone';
  name: string;
}
export interface ConstructionAsset {
  id: string;
  projectId: string;
  filename: string;
  mime: string;
  size: number;
}
export interface ConstructionDrawing {
  id: string;
  projectId: string;
  assetId: string;
  code: string;
  title: string;
  discipline: string;
  revision: string;
  previousId: string | null;
  status: 'draft' | 'approved' | 'obsolete';
  version: number;
  createdAt: string;
}
export interface DrawingPin {
  id: string;
  drawingId: string;
  page: number;
  x: number;
  y: number;
  label: string;
  recordKind: string;
  recordId: string;
  locationId: string | null;
}
export interface ProgressPhoto {
  id: string;
  projectId: string;
  locationId: string;
  locationName: string;
  assetId: string;
  date: string;
  caption: string;
  panorama: boolean;
  operationId: string | null;
}
export interface ConstructionRisk {
  key: string;
  title: string;
  reason: string;
  severity: 'warning' | 'critical';
  owner: string | null;
  dueDate: string | null;
  path: string;
  action: string;
}
export interface ConstructionCockpit {
  asOf: string;
  project: { id: string; code: string; name: string };
  currency: string;
  metrics: {
    budget: string;
    actual: string;
    eac: string;
    percent: string | null;
    cpi: string | null;
  } | null;
  counts: { open: number; overdue: number; drawings: number; photos: number };
  previous: { date: string; counts: ConstructionCockpit['counts'] } | null;
  risks: ConstructionRisk[];
  dataNotes: string[];
}

export type Point = { x: number; y: number };
/** Coordinates are normalized to a PDF page; page dimensions preserve aspect ratio. */
export function measureDrawing(
  points: Point[],
  kind: 'length' | 'area' | 'count',
  pageWidth: number,
  pageHeight: number,
  unitsPerPixel: number,
): number {
  if (
    !(pageWidth > 0 && pageHeight > 0 && unitsPerPixel > 0) ||
    points.some(
      (p) =>
        !Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1,
    )
  )
    throw new Error('Geçersiz ölçek veya koordinat.');
  if (kind === 'count') return points.length;
  const p = points.map((v) => ({ x: v.x * pageWidth, y: v.y * pageHeight }));
  if (kind === 'length')
    return p
      .slice(1)
      .reduce((s, v, i) => s + Math.hypot(v.x - p[i]!.x, v.y - p[i]!.y) * unitsPerPixel, 0);
  if (p.length < 3) throw new Error('Alan için en az üç nokta gerekir.');
  return (
    (Math.abs(
      p.reduce((s, v, i) => {
        const n = p[(i + 1) % p.length]!;
        return s + v.x * n.y - n.x * v.y;
      }, 0),
    ) /
      2) *
    unitsPerPixel ** 2
  );
}
