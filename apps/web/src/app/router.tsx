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
import type { Permission } from '@erp/shared';
import {
  PublicOnly,
  RequireAuth,
  RequireCompany,
  RequireModule,
  RequireRoutePermission,
  type RouteHandle,
} from './guards';
import { RouteError } from './RouteError';

/**
 * Sayfalar modül bazında lazy yüklenir: kullanıcının açmadığı (ya da şirketinin sektöründe
 * bulunmayan) bir modülün kodu tarayıcıya hiç inmez.
 * `permission`: sayfanın ana API çağrısının istediği izin (menüdeki izinle aynı); rol taşımıyorsa sayfa yerine
 * "yetkiniz yok" ekranı çıkar (RequireRoutePermission). Her rota bunu açıkça belirtir (`null` = herkes).
 */
function page<K extends string>(
  load: () => Promise<Record<K, ComponentType>>,
  name: K,
  permission: Permission | null,
): Pick<RouteObject, 'lazy' | 'handle'> {
  const handle: RouteHandle = { permission };
  return { handle, lazy: async () => ({ Component: (await load())[name] }) };
}

export const router = createBrowserRouter([
  {
    element: <PublicOnly />,
    errorElement: <RouteError />,
    hydrateFallbackElement: <PageLoading />,
    children: [
      { path: '/login', element: <LoginPage /> },
      { path: '/register', element: <RegisterPage /> },
      { path: '/forgot-password', element: <ForgotPasswordPage /> },
    ],
  },
  {
    // E-postadaki bağlantılar: oturum açıkken de çalışmalı (PublicOnly dışında)
    errorElement: <RouteError />,
    hydrateFallbackElement: <PageLoading />,
    children: [
      { path: '/reset-password', element: <ResetPasswordPage /> },
      { path: '/verify-email', element: <VerifyEmailPage /> },
    ],
  },
  {
    element: <RequireAuth />,
    errorElement: <RouteError />,
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
              {
                // Kabuk (menü, üst çubuk) ayakta kalır; sayfa hatası ve izin kapısı yalnızca içerik alanını etkiler
                element: <RequireRoutePermission />,
                errorElement: <RouteError />,
                children: [
                  { index: true, ...page(() => import('../features/dashboard/DashboardPage'), 'DashboardPage', null) },
                  {
                    element: <RequireModule module="core.ledger" />,
                    children: [
                      { path: 'accounting/journal', ...page(() => import('../features/ledger/JournalPage'), 'JournalPage', 'ledger.read') },
                      { path: 'accounting/openings', ...page(() => import('../features/imports/OpeningBalancesPage'), 'OpeningBalancesPage', 'ledger.post') },
                      { path: 'accounting/accounts', ...page(() => import('../features/ledger/AccountsPage'), 'AccountsPage', 'ledger.read') },
                      { path: 'accounting/trial-balance', ...page(() => import('../features/ledger/TrialBalancePage'), 'TrialBalancePage', 'reports.read') },
                      { path: 'accounting/account-ledger', ...page(() => import('../features/ledger/AccountLedgerPage'), 'AccountLedgerPage', 'reports.read') },
                      { path: 'accounting/year-end', ...page(() => import('../features/ledger/YearEndPage'), 'YearEndPage', 'ledger.read') },
                      { path: 'reports/journal-book', ...page(() => import('../features/reports/JournalBookPage'), 'JournalBookPage', 'reports.read') },
                      { path: 'reports/general-ledger', ...page(() => import('../features/reports/GeneralLedgerPage'), 'GeneralLedgerPage', 'reports.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="core.parties" />,
                    children: [
                      { path: 'parties', ...page(() => import('../features/parties/PartiesPage'), 'PartiesPage', 'parties.read') },
                      { path: 'parties/aging', ...page(() => import('../features/parties/PartyAgingPage'), 'PartyAgingPage', 'parties.read') },
                      { path: 'parties/:id', ...page(() => import('../features/parties/PartyDetailPage'), 'PartyDetailPage', 'parties.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="core.invoices" />,
                    children: [
                      { path: 'invoices/sales', ...page(() => import('../features/invoices/InvoicesPage'), 'SalesInvoicesPage', 'invoices.read') },
                      { path: 'invoices/purchases', ...page(() => import('../features/invoices/InvoicesPage'), 'PurchaseInvoicesPage', 'invoices.read') },
                      { path: 'invoices/vat-summary', ...page(() => import('../features/invoices/VatSummaryPage'), 'VatSummaryPage', 'reports.read') },
                      { path: 'reports/sales', ...page(() => import('../features/reports/SalesReportPage'), 'SalesReportPage', 'reports.read') },
                      { path: 'reports/purchases', ...page(() => import('../features/reports/SalesReportPage'), 'PurchaseReportPage', 'reports.read') },
                      { path: 'reports/item-profit', ...page(() => import('../features/reports/ItemProfitPage'), 'ItemProfitPage', 'reports.read') },
                      { path: 'invoices/new', ...page(() => import('../features/invoices/InvoiceEditorPage'), 'InvoiceEditorPage', 'invoices.manage') },
                      { path: 'invoices/:id', ...page(() => import('../features/invoices/InvoiceEditorPage'), 'InvoiceEditorPage', 'invoices.read') },
                      { path: 'delivery-notes/sales', ...page(() => import('../features/deliveries/DeliveryNotesPage'), 'SalesDeliveryNotesPage', 'deliveries.read') },
                      { path: 'delivery-notes/purchases', ...page(() => import('../features/deliveries/DeliveryNotesPage'), 'PurchaseDeliveryNotesPage', 'deliveries.read') },
                      { path: 'delivery-notes/sales-returns', ...page(() => import('../features/deliveries/DeliveryNotesPage'), 'SalesReturnNotesPage', 'deliveries.read') },
                      { path: 'delivery-notes/purchase-returns', ...page(() => import('../features/deliveries/DeliveryNotesPage'), 'PurchaseReturnNotesPage', 'deliveries.read') },
                      { path: 'invoices/batch', ...page(() => import('../features/invoices/BatchInvoicingPage'), 'BatchInvoicingPage', 'invoices.manage') },
                      { path: 'delivery-notes/new', ...page(() => import('../features/deliveries/DeliveryNoteEditorPage'), 'DeliveryNoteEditorPage', 'deliveries.manage') },
                      { path: 'delivery-notes/:id', ...page(() => import('../features/deliveries/DeliveryNoteEditorPage'), 'DeliveryNoteEditorPage', 'deliveries.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="invoices.orders" />,
                    children: [
                      { path: 'sales/quotes', ...page(() => import('../features/sales/SalesDocsPage'), 'SalesQuotesPage', 'invoices.read') },
                      { path: 'sales/orders', ...page(() => import('../features/sales/SalesDocsPage'), 'SalesOrdersPage', 'invoices.read') },
                      { path: 'sales/docs/new', ...page(() => import('../features/sales/SalesDocPage'), 'SalesDocPage', 'invoices.manage') },
                      { path: 'sales/docs/:id', ...page(() => import('../features/sales/SalesDocPage'), 'SalesDocPage', 'invoices.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="sales.pricelists" />,
                    children: [
                      { path: 'price-lists', ...page(() => import('../features/pricing/PriceListsPage'), 'PriceListsPage', 'invoices.read') },
                      { path: 'price-lists/:id', ...page(() => import('../features/pricing/PriceListDetailPage'), 'PriceListDetailPage', 'invoices.read') },
                      { path: 'party-prices', ...page(() => import('../features/pricing/PartyPricesPage'), 'PartyPricesPage', 'invoices.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="inventory.imports" />,
                    children: [
                      { path: 'inventory/imports', ...page(() => import('../features/landed/ImportFilesPage'), 'ImportFilesPage', 'inventory.read') },
                      { path: 'inventory/imports/new', ...page(() => import('../features/landed/ImportFilePage'), 'ImportFilePage', 'invoices.manage') },
                      { path: 'inventory/imports/:id', ...page(() => import('../features/landed/ImportFilePage'), 'ImportFilePage', 'inventory.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="treasury.expenses" />,
                    children: [
                      { path: 'treasury/expenses', ...page(() => import('../features/expenses/ExpenseEntriesPage'), 'ExpenseEntriesPage', 'treasury.read') },
                      { path: 'treasury/expense-cards', ...page(() => import('../features/expenses/ExpenseCardsPage'), 'ExpenseCardsPage', 'treasury.read') },
                      { path: 'treasury/expense-reports', ...page(() => import('../features/expenses/ExpenseReportPage'), 'ExpenseReportPage', 'treasury.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="inventory.serials" />,
                    children: [
                      { path: 'inventory/serials', ...page(() => import('../features/inventory/SerialsPage'), 'SerialsPage', 'inventory.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="core.treasury" />,
                    children: [
                      { path: 'treasury/accounts', ...page(() => import('../features/treasury/AccountsPage'), 'AccountsPage', 'treasury.read') },
                      { path: 'treasury/accounts/:id', ...page(() => import('../features/treasury/AccountDetailPage'), 'AccountDetailPage', 'treasury.read') },
                      { path: 'treasury/cash-forecast', ...page(() => import('../features/treasury/CashForecastPage'), 'CashForecastPage', 'treasury.read') },
                      { path: 'treasury/transactions', ...page(() => import('../features/treasury/TransactionsPage'), 'TransactionsPage', 'treasury.read') },
                      { path: 'reports/fx-differences', ...page(() => import('../features/reports/FxDifferencePage'), 'FxDifferencePage', 'reports.read') },
                      { path: 'reports/fx-position', ...page(() => import('../features/reports/FxPositionPage'), 'FxPositionPage', 'reports.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="treasury.cheques" />,
                    children: [
                      { path: 'treasury/cheques', ...page(() => import('../features/treasury/ChequesPage'), 'ChequesPage', 'treasury.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="treasury.guarantees" />,
                    children: [
                      { path: 'treasury/guarantees', ...page(() => import('../features/treasury/GuaranteesPage'), 'GuaranteesPage', 'treasury.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="core.inventory" />,
                    children: [
                      { path: 'inventory/items', ...page(() => import('../features/inventory/ItemsPage'), 'ItemsPage', 'inventory.read') },
                      { path: 'inventory/items/:id', ...page(() => import('../features/inventory/ItemDetailPage'), 'ItemDetailPage', 'inventory.read') },
                      { path: 'inventory/status', ...page(() => import('../features/inventory/StockStatusPage'), 'StockStatusPage', 'inventory.read') },
                      { path: 'inventory/movements', ...page(() => import('../features/inventory/MovementsPage'), 'MovementsPage', 'inventory.read') },
                      { path: 'inventory/counts', ...page(() => import('../features/inventory/CountsPage'), 'CountsPage', 'inventory.read') },
                      { path: 'inventory/counts/:id', ...page(() => import('../features/inventory/CountEditorPage'), 'CountEditorPage', 'inventory.read') },
                      { path: 'inventory/warehouses', ...page(() => import('../features/inventory/WarehousesPage'), 'WarehousesPage', 'inventory.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="construction.projects" />,
                    children: [
                      { path: 'projects', ...page(() => import('../features/projects/ProjectsPage'), 'ProjectsPage', 'projects.read') },
                      { path: 'reports/project-profitability', ...page(() => import('../features/projects/ProfitabilityPage'), 'ProfitabilityPage', 'projects.read') },
                      { path: 'projects/:id', ...page(() => import('../features/projects/ProjectDetailPage'), 'ProjectDetailPage', 'projects.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="hr.core" />,
                    children: [
                      { path: 'hr/employees', ...page(() => import('../features/hr/EmployeesPage'), 'EmployeesPage', 'hr.read') },
                      { path: 'hr/employees/:id', ...page(() => import('../features/hr/EmployeePage'), 'EmployeePage', 'hr.read') },
                      { path: 'hr/attendance', ...page(() => import('../features/hr/AttendancePage'), 'AttendancePage', 'hr.read') },
                      { path: 'hr/privacy', ...page(() => import('../features/hr/PrivacyPage'), 'PrivacyPage', 'privacy.manage') },
                    ],
                  },
                  {
                    element: <RequireModule module="hr.payroll" />,
                    children: [
                      { path: 'hr/payroll', ...page(() => import('../features/hr/PayrollPage'), 'PayrollPage', 'hr.payroll') },
                      { path: 'hr/payroll/settings', ...page(() => import('../features/hr/PayrollSettingsPage'), 'PayrollSettingsPage', 'hr.payroll') },
                      { path: 'hr/payroll/:id', ...page(() => import('../features/hr/PayrollRunPage'), 'PayrollRunPage', 'hr.payroll') },
                      { path: 'hr/payroll/:id/slip/:employeeId', ...page(() => import('../features/hr/PayrollSlipPage'), 'PayrollSlipPage', 'hr.payroll') },
                    ],
                  },
                  {
                    element: <RequireModule module="reports.executive" />,
                    children: [
                      { path: 'reports/executive-summary', ...page(() => import('../features/reports/ExecutiveSummaryPage'), 'ExecutiveSummaryPage', 'reports.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="reports.consolidation" />,
                    children: [
                      { path: 'reports/consolidation', ...page(() => import('../features/consolidation/ConsolidationPage'), 'ConsolidationPage', 'reports.consolidation') },
                    ],
                  },
                  {
                    element: <RequireModule module="core.directory" />,
                    children: [
                      { path: 'directory/contacts', ...page(() => import('../features/directory/ContactsPage'), 'ContactsPage', 'directory.read') },
                      { path: 'directory/contacts/:id', ...page(() => import('../features/directory/ContactDetailPage'), 'ContactDetailPage', 'directory.read') },
                      { path: 'directory/organizations', ...page(() => import('../features/directory/OrganizationsPage'), 'OrganizationsPage', 'directory.read') },
                      { path: 'directory/organizations/:id', ...page(() => import('../features/directory/OrganizationDetailPage'), 'OrganizationDetailPage', 'directory.read') },
                      { path: 'agenda', ...page(() => import('../features/directory/AgendaPage'), 'AgendaPage', 'directory.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="hr.employee_ledger" />,
                    children: [
                      { path: 'hr/employee-ledger', ...page(() => import('../features/hr/EmployeeLedgerPage'), 'EmployeeLedgerPage', 'hr.payroll') },
                      { path: 'hr/employee-ledger/:id', ...page(() => import('../features/hr/EmployeeStatementPage'), 'EmployeeStatementPage', 'hr.payroll') },
                    ],
                  },
                  {
                    element: <RequireModule module="hr.socialsecurity" />,
                    children: [
                      { path: 'hr/social-security', ...page(() => import('../features/hr/SocialSecurityPage'), 'SocialSecurityPage', 'hr.payroll') },
                      { path: 'hr/social-security/settings', ...page(() => import('../features/hr/SocialSettingsPage'), 'SocialSettingsPage', 'hr.payroll') },
                      { path: 'hr/social-security/:id', ...page(() => import('../features/hr/SocialDeclarationPage'), 'SocialDeclarationPage', 'hr.payroll') },
                    ],
                  },
                  {
                    element: <RequireModule module="hr.foreign" />,
                    children: [
                      { path: 'hr/foreign-workers', ...page(() => import('../features/hr/ForeignWorkersPage'), 'ForeignWorkersPage', 'hr.read') },
                      { path: 'hr/foreign-workers/settings', ...page(() => import('../features/hr/ForeignSettingsPage'), 'ForeignSettingsPage', 'hr.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="construction.subcontracts" />,
                    children: [
                      { path: 'subcontracts', ...page(() => import('../features/subcontracts/SubcontractsPage'), 'SubcontractsPage', 'subcontracts.read') },
                      { path: 'subcontracts/:id', ...page(() => import('../features/subcontracts/SubcontractDetailPage'), 'SubcontractDetailPage', 'subcontracts.read') },
                      { path: 'employer-contracts', ...page(() => import('../features/subcontracts/SubcontractsPage'), 'EmployerContractsPage', 'subcontracts.read') },
                      { path: 'employer-claims', ...page(() => import('../features/subcontracts/ProgressList'), 'EmployerClaimsPage', 'subcontracts.read') },
                      { path: 'progress-payments', ...page(() => import('../features/subcontracts/ProgressList'), 'ProgressPaymentsPage', 'subcontracts.read') },
                      { path: 'progress-payments/new', ...page(() => import('../features/subcontracts/ProgressEditorPage'), 'ProgressEditorPage', 'subcontracts.manage') },
                      { path: 'progress-payments/:id', ...page(() => import('../features/subcontracts/ProgressEditorPage'), 'ProgressEditorPage', 'subcontracts.read') },
                      { path: 'variation-orders', ...page(() => import('../features/subcontracts/VariationsPage'), 'VariationsPage', 'subcontracts.read') },
                      { path: 'variation-orders/:id', ...page(() => import('../features/subcontracts/VariationPage'), 'VariationPage', 'subcontracts.read') },
                      { path: 'approvals', ...page(() => import('../features/subcontracts/ApprovalsPage'), 'ApprovalsPage', 'subcontracts.read') },
                      { path: 'settings/construction', ...page(() => import('../features/settings/ConstructionSettingsPage'), 'ConstructionSettingsPage', 'subcontracts.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="construction.procurement" />,
                    children: [
                      { path: 'purchasing/requests', ...page(() => import('../features/procurement/RequestsPage'), 'PurchaseRequestsPage', 'procurement.read') },
                      { path: 'purchasing/requests/:id', ...page(() => import('../features/procurement/RequestEditorPage'), 'PurchaseRequestEditorPage', 'procurement.read') },
                      { path: 'purchasing/rfqs', ...page(() => import('../features/procurement/RfqsPage'), 'RfqsPage', 'procurement.read') },
                      { path: 'purchasing/rfqs/:id', ...page(() => import('../features/procurement/RfqPage'), 'RfqPage', 'procurement.read') },
                      { path: 'purchasing/matching', ...page(() => import('../features/procurement/MatchingPage'), 'OrderMatchingPage', 'procurement.read') },
                      { path: 'purchasing/orders', ...page(() => import('../features/procurement/OrdersPage'), 'PurchaseOrdersPage', 'procurement.read') },
                      { path: 'purchasing/orders/:id', ...page(() => import('../features/procurement/OrderEditorPage'), 'PurchaseOrderEditorPage', 'procurement.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="construction.realestate" />,
                    children: [
                      { path: 'real-estate/units', ...page(() => import('../features/realestate/UnitsPage'), 'UnitsPage', 'realestate.read') },
                      { path: 'real-estate/contracts', ...page(() => import('../features/realestate/ContractsPage'), 'SalesContractsPage', 'realestate.read') },
                      { path: 'real-estate/contracts/:id', ...page(() => import('../features/realestate/ContractPage'), 'SalesContractPage', 'realestate.read') },
                      { path: 'real-estate/installments', ...page(() => import('../features/realestate/InstallmentsPage'), 'SalesInstallmentsPage', 'realestate.read') },
                    ],
                  },
                  {
                    element: <RequireModule module="core.settings" />,
                    children: [
                      { path: 'settings/company', ...page(() => import('../features/settings/CompanyPage'), 'CompanyPage', 'settings.read') },
                      { path: 'settings/members', ...page(() => import('../features/settings/MembersPage'), 'MembersPage', 'members.manage') },
                      { path: 'settings/currencies', ...page(() => import('../features/settings/CurrenciesPage'), 'CurrenciesPage', 'settings.read') },
                      { path: 'settings/tax-rates', ...page(() => import('../features/settings/TaxRatesPage'), 'TaxRatesPage', 'settings.read') },
                      { path: 'settings/periods', ...page(() => import('../features/settings/PeriodsPage'), 'PeriodsPage', 'settings.read') },
                      { path: 'settings/custom-codes', ...page(() => import('../features/settings/CustomCodesPage'), 'CustomCodesPage', 'settings.read') },
                      { path: 'settings/modules', ...page(() => import('../features/settings/ModulesPage'), 'ModulesPage', 'settings.read') },
                      { path: 'settings/license', ...page(() => import('../features/settings/LicensePage'), 'LicensePage', 'settings.read') },
                      { path: 'settings/devices', ...page(() => import('../features/settings/DevicesPage'), 'DevicesPage', 'members.manage') },
                      { path: 'settings/account-mapping', ...page(() => import('../features/settings/AccountMappingPage'), 'AccountMappingPage', 'accounts.manage') },
                      { path: 'reports/data-export', ...page(() => import('../features/reports/DataExportPage'), 'DataExportPage', 'data.export') },
                    ],
                  },
                  { path: 'account/security', ...page(() => import('../features/settings/SecurityPage'), 'SecurityPage', null) },
                  // Bildirimler çekirdektir (modül kapısı yok): her üye kendi bildirimlerini ve tercihlerini görür
                  { path: 'notifications', ...page(() => import('../features/notifications/NotificationsPage'), 'NotificationsPage', null) },
                  { path: 'settings/notifications', ...page(() => import('../features/notifications/NotificationPreferencesPage'), 'NotificationPreferencesPage', null) },
                  { path: '*', element: <NotFoundPage /> },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
]);
