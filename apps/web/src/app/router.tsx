import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageLoading } from '../components/ui/Feedback';
import { NotFoundPage } from '../features/NotFoundPage';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { CreateCompanyPage } from '../features/onboarding/CreateCompanyPage';
import { PublicOnly, RequireAuth, RequireCompany, RequireModule } from './guards';

/**
 * Sayfalar modül bazında lazy yüklenir: kullanıcının açmadığı (ya da şirketinin sektöründe
 * bulunmayan) bir modülün kodu tarayıcıya hiç inmez.
 */
function page<K extends string>(load: () => Promise<Record<K, ComponentType>>, name: K): Pick<RouteObject, 'lazy'> {
  return { lazy: async () => ({ Component: (await load())[name] }) };
}

export const router = createBrowserRouter([
  {
    element: <PublicOnly />,
    hydrateFallbackElement: <PageLoading />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    hydrateFallbackElement: <PageLoading />,
    children: [
      { path: '/company/new', element: <CreateCompanyPage /> },
      {
        element: <RequireCompany />,
        children: [
          {
            element: <AppShell />,
            children: [
              { index: true, ...page(() => import('../features/dashboard/DashboardPage'), 'DashboardPage') },
              {
                element: <RequireModule module="core.ledger" />,
                children: [
                  { path: 'accounting/journal', ...page(() => import('../features/ledger/JournalPage'), 'JournalPage') },
                  { path: 'accounting/accounts', ...page(() => import('../features/ledger/AccountsPage'), 'AccountsPage') },
                  { path: 'accounting/trial-balance', ...page(() => import('../features/ledger/TrialBalancePage'), 'TrialBalancePage') },
                  { path: 'accounting/account-ledger', ...page(() => import('../features/ledger/AccountLedgerPage'), 'AccountLedgerPage') },
                ],
              },
              {
                element: <RequireModule module="core.parties" />,
                children: [
                  { path: 'parties', ...page(() => import('../features/parties/PartiesPage'), 'PartiesPage') },
                  { path: 'parties/aging', ...page(() => import('../features/parties/PartyAgingPage'), 'PartyAgingPage') },
                  { path: 'parties/:id', ...page(() => import('../features/parties/PartyDetailPage'), 'PartyDetailPage') },
                ],
              },
              {
                element: <RequireModule module="core.settings" />,
                children: [
                  { path: 'settings/company', ...page(() => import('../features/settings/CompanyPage'), 'CompanyPage') },
                  { path: 'settings/members', ...page(() => import('../features/settings/MembersPage'), 'MembersPage') },
                  { path: 'settings/currencies', ...page(() => import('../features/settings/CurrenciesPage'), 'CurrenciesPage') },
                  { path: 'settings/tax-rates', ...page(() => import('../features/settings/TaxRatesPage'), 'TaxRatesPage') },
                  { path: 'settings/periods', ...page(() => import('../features/settings/PeriodsPage'), 'PeriodsPage') },
                  { path: 'settings/custom-codes', ...page(() => import('../features/settings/CustomCodesPage'), 'CustomCodesPage') },
                ],
              },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
]);
