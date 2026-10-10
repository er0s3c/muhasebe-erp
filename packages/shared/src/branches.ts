import { z } from 'zod';
import { uuid } from './schemas/common';
export const createBranchSchema = z.object({ code:z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/).transform((v)=>v.toUpperCase()),name:z.string().trim().min(2).max(160),address:z.string().trim().max(500).nullable().optional() }).strict();
export const updateBranchSchema = z.object({ name:z.string().trim().min(2).max(160).optional(),address:z.string().trim().max(500).nullable().optional(),isActive:z.boolean().optional() }).strict();
export const memberBranchScopeSchema = z.object({ mode:z.enum(['all','restricted']),branchIds:z.array(uuid).max(100).default([]),allowUnassigned:z.boolean().default(false) }).strict().refine((v)=>new Set(v.branchIds).size===v.branchIds.length,{message:'Şube listesinde tekrar olamaz',path:['branchIds']});
export const branchAssignmentsSchema = z.object({ branchId:uuid.nullable(),warehouseIds:z.array(uuid).max(100).default([]),employeeIds:z.array(uuid).max(100).default([]) }).strict().refine((v)=>v.warehouseIds.length+v.employeeIds.length>0,{message:'En az bir depo veya personel seçin'});
export type CreateBranchInput=z.infer<typeof createBranchSchema>;
export type UpdateBranchInput=z.infer<typeof updateBranchSchema>;
export type MemberBranchScopeInput=z.infer<typeof memberBranchScopeSchema>;
export interface BranchContext { selection:'all'|'unassigned'|'branch';activeBranchId:string|null;mode:'all'|'restricted';branchIds:string[];allowUnassigned:boolean; }
