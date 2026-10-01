import type { ComponentType } from 'react';
import { createBrowserRouter, type RouteObject } from 'react-router-dom';
import { AppShell } from '../components/layout/AppShell';
import { PageLoading } from '../components/ui/Feedback';
import { NotFoundPage } from '../features/NotFoundPage';
import { LoginPage } from '../features/auth/LoginPage';
import { ForgotPasswordPage } from '../features/auth/ForgotPasswordPage';
import { PasswordChangeRequiredPage } from '../features/auth/PasswordChangeRequiredPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { VerifyEmailPage } from '../features/auth/VerifyEmailPage';
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
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  {
    // E-postadaki bağlantılar: oturum açıkken de çalışmalı (PublicOnly dışında)
    hydrateFallbackElement: <PageLoading />,
    children: [
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    hydrateFallbackElement: <PageLoading />,
    children: [
      { path: '/password-change', element: <PasswordChangeRequiredPage /> },
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
                  { path: 'accounting/openings', ...page(() => import('../features/imports/OpeningBalancesPage'), 'OpeningBalancesPage') },
                  { path: 'accounting/accounts', ...page(() => import('../features/ledger/AccountsPage'), 'AccountsPage') },
                  { path: 'accounting/trial-balance', ...page(() => import('../features/ledger/TrialBalancePage'), 'TrialBalancePage') },
                  { path: 'accounting/account-ledger', ...page(() => import('../features/ledger/AccountLedgerPage'), 'AccountLedgerPage') },
                  { path: 'reports/journal-book', ...page(() => import('../features/reports/JournalBookPage'), 'JournalBookPage') },
                  { path: 'reports/general-ledger', ...page(() => import('../features/reports/GeneralLedgerPage'), 'GeneralLedgerPage') },
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
                element: <RequireModule module="core.invoices" />,
                children: [
                  { path: 'invoices/sales', ...page(() => import('../features/invoices/InvoicesPage'), 'SalesInvoicesPage') },
                  { path: 'invoices/purchases', ...page(() => import('../features/invoices/InvoicesPage'), 'PurchaseInvoicesPage') },
                  { path: 'invoices/vat-summary', ...page(() => import('../features/invoices/VatSummaryPage'), 'VatSummaryPage') },
                  { path: 'reports/sales', ...page(() => import('../features/reports/SalesReportPage'), 'SalesReportPage') },
                  { path: 'reports/purchases', ...page(() => import('../features/reports/SalesReportPage'), 'PurchaseReportPage') },
                  { path: 'reports/item-profit', ...page(() => import('../features/reports/ItemProfitPage'), 'ItemProfitPage') },
                  { path: 'invoices/new', ...page(() => import('../features/invoices/InvoiceEditorPage'), 'InvoiceEditorPage') },
                  { path: 'invoices/:id', ...page(() => import('../features/invoices/InvoiceEditorPage'), 'InvoiceEditorPage') },
                  { path: 'delivery-notes/sales', ...page(() => import('../features/deliveries/DeliveryNotesPage'), 'SalesDeliveryNotesPage') },
                  { path: 'delivery-notes/purchases', ...page(() => import('../features/deliveries/DeliveryNotesPage'), 'PurchaseDeliveryNotesPage') },
                  { path: 'delivery-notes/new', ...page(() => import('../features/deliveries/DeliveryNoteEditorPage'), 'DeliveryNoteEditorPage') },
                  { path: 'delivery-notes/:id', ...page(() => import('../features/deliveries/DeliveryNoteEditorPage'), 'DeliveryNoteEditorPage') },
                ],
              },
              {
                element: <RequireModule module="core.treasury" />,
                children: [
                  { path: 'treasury/accounts', ...page(() => import('../features/treasury/AccountsPage'), 'AccountsPage') },
                  { path: 'treasury/accounts/:id', ...page(() => import('../features/treasury/AccountDetailPage'), 'AccountDetailPage') },
                  { path: 'treasury/transactions', ...page(() => import('../features/treasury/TransactionsPage'), 'TransactionsPage') },
                  { path: 'reports/fx-differences', ...page(() => import('../features/reports/FxDifferencePage'), 'FxDifferencePage') },
                ],
              },
              {
                element: <RequireModule module="core.inventory" />,
                children: [
                  { path: 'inventory/items', ...page(() => import('../features/inventory/ItemsPage'), 'ItemsPage') },
                  { path: 'inventory/items/:id', ...page(() => import('../features/inventory/ItemDetailPage'), 'ItemDetailPage') },
                  { path: 'inventory/status', ...page(() => import('../features/inventory/StockStatusPage'), 'StockStatusPage') },
                  { path: 'inventory/movements', ...page(() => import('../features/inventory/MovementsPage'), 'MovementsPage') },
                  { path: 'inventory/counts', ...page(() => import('../features/inventory/CountsPage'), 'CountsPage') },
                  { path: 'inventory/counts/:id', ...page(() => import('../features/inventory/CountEditorPage'), 'CountEditorPage') },
                  { path: 'inventory/warehouses', ...page(() => import('../features/inventory/WarehousesPage'), 'WarehousesPage') },
                ],
              },
              {
                element: <RequireModule module="construction.projects" />,
                children: [
                  { path: 'projects', ...page(() => import('../features/projects/ProjectsPage'), 'ProjectsPage') },
                  { path: 'projects/:id', ...page(() => import('../features/projects/ProjectDetailPage'), 'ProjectDetailPage') },
                ],
              },
              {
                element: <RequireModule module="construction.subcontracts" />,
                children: [
                  { path: 'subcontracts', ...page(() => import('../features/subcontracts/SubcontractsPage'), 'SubcontractsPage') },
                  { path: 'subcontracts/:id', ...page(() => import('../features/subcontracts/SubcontractDetailPage'), 'SubcontractDetailPage') },
                  { path: 'employer-contracts', ...page(() => import('../features/subcontracts/SubcontractsPage'), 'EmployerContractsPage') },
                  { path: 'employer-claims', ...page(() => import('../features/subcontracts/ProgressList'), 'EmployerClaimsPage') },
                  { path: 'progress-payments', ...page(() => import('../features/subcontracts/ProgressList'), 'ProgressPaymentsPage') },
                  { path: 'progress-payments/new', ...page(() => import('../features/subcontracts/ProgressEditorPage'), 'ProgressEditorPage') },
                  { path: 'progress-payments/:id', ...page(() => import('../features/subcontracts/ProgressEditorPage'), 'ProgressEditorPage') },
                  { path: 'approvals', ...page(() => import('../features/subcontracts/ApprovalsPage'), 'ApprovalsPage') },
                  { path: 'settings/construction', ...page(() => import('../features/settings/ConstructionSettingsPage'), 'ConstructionSettingsPage') },
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
                  { path: 'settings/modules', ...page(() => import('../features/settings/ModulesPage'), 'ModulesPage') },
                  { path: 'settings/license', ...page(() => import('../features/settings/LicensePage'), 'LicensePage') },
                  { path: 'settings/devices', ...page(() => import('../features/settings/DevicesPage'), 'DevicesPage') },
                  { path: 'settings/account-mapping', ...page(() => import('../features/settings/AccountMappingPage'), 'AccountMappingPage') },
                  { path: 'reports/data-export', ...page(() => import('../features/reports/DataExportPage'), 'DataExportPage') },
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
