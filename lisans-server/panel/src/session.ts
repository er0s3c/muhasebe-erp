import { useOutletContext } from 'react-router-dom';

export function usePanelAdmin() {
  return useOutletContext<{ admin: { id: string; email: string; fullName: string } }>().admin;
}
