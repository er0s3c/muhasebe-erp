import { useSyncExternalStore } from 'react';

let userId: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());
export function setBranchUserId(id: string | null) {
  userId = id;
  emit();
}
export function getActiveBranch(companyId: string): string {
  if (!userId) return 'all';
  try {
    return localStorage.getItem(`activeBranch:${userId}:${companyId}`) || 'all';
  } catch {
    return 'all';
  }
}
export function setActiveBranch(companyId: string, branchId: string) {
  if (!userId) return;
  try {
    localStorage.setItem(`activeBranch:${userId}:${companyId}`, branchId);
  } catch {
    /* Depolama kapalıysa seçim yalnız bu oturumda tutulur. */
  }
  memorySelection.set(`${userId}:${companyId}`, branchId);
  emit();
}
const memorySelection = new Map<string, string>();
export function currentBranch(companyId: string): string {
  return (userId && memorySelection.get(`${userId}:${companyId}`)) || getActiveBranch(companyId);
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export function useActiveBranch(companyId: string) {
  return useSyncExternalStore(subscribe, () => currentBranch(companyId));
}
