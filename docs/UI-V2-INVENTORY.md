# Ada ERP V2 — Rota envanteri ve kabul durumu

10 Ekim 2026. Bu envanter router kaynaklarından statik olarak çıkarılmıştır; tarayıcıda başarı kaydı değildir. Uygulama geliştirmesi ve doğrulama devam ederken hazırlanmıştır.

## Kaynak ve kapsam

- ERP kaynağı: `apps/web/src/app/router.tsx`; 180 sayfa/endpoint deseni, wildcard dahil. Aynı bileşeni açan farklı rotalar ayrı kayıttır.
- Satıcı paneli kaynağı: `lisans-server/panel/src/App.tsx`; 11 sayfa/yönlendirme deseni, wildcard dahil. Panel yolları lisans sunucusunun panel kökü altındadır.
- Menü öğeleri ve modül tanımları: `packages/shared/src/module-registry.ts`. Query parametresiyle açılan alt görünümler, dinamik kayıt kimlikleri, sekmeler ve yan paneller route sayısını artırmaz; ayrıca sınanır.
- İzin sütunu ana route iznidir. Gerçek API işlem hakları, rol sınırları, şirket/şube kapsamı ve ek modül alternatifleri kaynakta ayrıca uygulanır; bu özet erişim denetimi yerine kullanılmaz.

## Uygulama ile kabul arasındaki ayrım

| Alan | Kaynakta durum | Kabul durumu |
| --- | --- | --- |
| Ortak token/base CSS; açık/koyu tema; 400/500/600 tipografi; mobil kontrol yüksekliği | ERP ve panel aynı CSS kaynağına bağlı | Tüm rotalarda light/dark görsel tekrar bekliyor |
| Button, Field, Card/PageHeader, Table, sekme/Combobox, loading/error/empty, ortak onay | Ortak primitive değişiklikleri mevcut | Klavye, dokunma, hata ve odak regresyonları tamamlanmadan kabul edilmez |
| Gezinti, breadcrumb, arama, menü grupları ve genişlik düzenleri | ERP kabuğunda V2 düzeni mevcut | Modül/izin profilleri ve direct URL taraması bekliyor |
| Cari, ürün, satış/alış faturası, kasa/banka işlemleri | SearchInput, ListToolbar, SavedViews, ResultFooter ve ListSkeleton kullanımına geçirilmiş | Gerçek API akışları ve görsel tekrar bekliyor |
| Diğer ERP modülleri | Ortak sistem değişikliklerini alır; route aşağıda kayıtlı | Her ekran için alan/işlem/finansal davranış incelemesi henüz tamamlandı sayılmaz |
| Satıcı/lisans paneli | Ortak bileşen ve taslak koruması entegrasyonu mevcut | Her panel sayfası için light/dark ve dar ekran QA bekliyor |
| İş kuralları, finansal hesaplar, API sözleşmeleri | Korunması gereken değişmezler | Regresyon testleri ve gerçek akışlar gerekli |

Denetim sırasında, V2 kaynak değişikliklerinden önce web paketinin 8 test dosyasındaki 41 test ve web typecheck geçti. Vitest için süreç TMP/TEMP değişkenleri mevcut `.cache` dizinine yönlendirildi. Bu başlangıç sonucu V2 değişikliklerinin son test sonucu değildir. Önceki `UI-AUDIT.md` içindeki 7–10 Ekim görsel sonuçlar eski revizyonun kanıtıdır; burada yeniden geçmiş kabul edilmez.

## ERP rotaları

| Rota | Ekran bileşeni | Ana izin | Modül kapısı | Kaynakta V2 kapsamı | Bu revizyon görsel QA |
| --- | --- | --- | --- | --- | --- |
| `/offline-drafts` | `OfflineDraftPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/field-offline` | `OfflineFieldPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/portal` | `PortalPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/login` | `LoginPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/register` | `RegisterPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/forgot-password` | `ForgotPasswordPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reset-password` | `ResetPasswordPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/verify-email` | `VerifyEmailPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/password-change` | `PasswordChangeRequiredPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/company/new` | `CreateCompanyPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/` | `DashboardPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace` | `WorkPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/offline` | `OfflineSetupPage` | `workspace.use` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/integrations` | `PlatformIntegrationsPage` | `core.integrations.read` | core.integrations | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/portal` | `PortalAdminPage` | `members.manage` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/project-control` | `ProjectControlPage` | `projects.read` | construction.projects | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/construction` | `ConstructionPage` | `projects.read` | construction.projects | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/operations` | `OperationsPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/supplier-performance` | `SupplierPerformancePage` | `procurement.read` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/replenishment` | `ReplenishmentPage` | `procurement.read` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/handover` | `HandoverPage` | `realestate.read` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/scenarios` | `ScenariosPage` | `treasury.read` | core.treasury | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/workspace/documents` | `DocumentsPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/journal` | `JournalPage` | `ledger.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/fixed-assets` | `FixedAssetsPage` | `ledger.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/budgets` | `CompanyBudgetsPage` | `ledger.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/openings` | `OpeningBalancesPage` | `ledger.post` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/accounts` | `AccountsPage` | `ledger.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/trial-balance` | `TrialBalancePage` | `reports.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/account-ledger` | `AccountLedgerPage` | `reports.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/accounting/year-end` | `YearEndPage` | `ledger.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/journal-book` | `JournalBookPage` | `reports.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/general-ledger` | `GeneralLedgerPage` | `reports.read` | core.ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/parties` | `PartiesPage` | `parties.read` | core.parties | Ortak sistem + liste araçları | Bekliyor |
| `/parties/aging` | `PartyAgingPage` | `parties.read` | core.parties | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/parties/:id` | `PartyDetailPage` | `parties.read` | core.parties | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/invoices/sales` | `SalesInvoicesPage` | `invoices.read` | core.invoices | Ortak sistem + liste araçları | Bekliyor |
| `/sales/campaigns` | `CampaignsPage` | `invoices.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/invoices/purchases` | `PurchaseInvoicesPage` | `invoices.read` | core.invoices | Ortak sistem + liste araçları | Bekliyor |
| `/invoices/vat-summary` | `VatSummaryPage` | `reports.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/sales` | `SalesReportPage` | `reports.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/purchases` | `PurchaseReportPage` | `reports.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/item-profit` | `ItemProfitPage` | `reports.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/invoices/new` | `InvoiceEditorPage` | `invoices.manage` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/invoices/:id` | `InvoiceEditorPage` | `invoices.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/delivery-notes/sales` | `SalesDeliveryNotesPage` | `deliveries.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/delivery-notes/purchases` | `PurchaseDeliveryNotesPage` | `deliveries.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/delivery-notes/sales-returns` | `SalesReturnNotesPage` | `deliveries.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/delivery-notes/purchase-returns` | `PurchaseReturnNotesPage` | `deliveries.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/invoices/batch` | `BatchInvoicingPage` | `invoices.manage` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/delivery-notes/new` | `DeliveryNoteEditorPage` | `deliveries.manage` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/delivery-notes/:id` | `DeliveryNoteEditorPage` | `deliveries.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/sales/quotes` | `SalesQuotesPage` | `invoices.read` | invoices.orders | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/sales/orders` | `SalesOrdersPage` | `invoices.read` | invoices.orders | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/sales/docs/new` | `SalesDocPage` | `invoices.manage` | invoices.orders | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/sales/docs/:id` | `SalesDocPage` | `invoices.read` | invoices.orders | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/price-lists` | `PriceListsPage` | `invoices.read` | sales.pricelists | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/price-lists/:id` | `PriceListDetailPage` | `invoices.read` | sales.pricelists | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/party-prices` | `PartyPricesPage` | `invoices.read` | sales.pricelists | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/imports` | `ImportFilesPage` | `inventory.read` | inventory.imports | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/imports/new` | `ImportFilePage` | `invoices.manage` | inventory.imports | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/imports/:id` | `ImportFilePage` | `inventory.read` | inventory.imports | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/expenses` | `ExpenseEntriesPage` | `treasury.read` | treasury.expenses | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/expense-cards` | `ExpenseCardsPage` | `treasury.read` | treasury.expenses | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/expense-reports` | `ExpenseReportPage` | `treasury.read` | treasury.expenses | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/serials` | `SerialsPage` | `inventory.read` | inventory.serials | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/accounts` | `AccountsPage` | `treasury.read` | core.treasury | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/accounts/:id` | `AccountDetailPage` | `treasury.read` | core.treasury | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/cash-forecast` | `CashForecastPage` | `treasury.read` | core.treasury | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/transactions` | `TransactionsPage` | `treasury.read` | core.treasury | Ortak sistem + liste araçları | Bekliyor |
| `/reports/fx-differences` | `FxDifferencePage` | `reports.read` | core.treasury | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/fx-position` | `FxPositionPage` | `reports.read` | core.treasury | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/cheques` | `ChequesPage` | `treasury.read` | treasury.cheques | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/treasury/guarantees` | `GuaranteesPage` | `treasury.read` | treasury.guarantees | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/stock-analytics` | `StockAnalyticsPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/items` | `ItemsPage` | `inventory.read` | core.inventory | Ortak sistem + liste araçları | Bekliyor |
| `/inventory/items/:id` | `ItemDetailPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/status` | `StockStatusPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/movements` | `MovementsPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/counts` | `CountsPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/counts/:id` | `CountEditorPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/inventory/warehouses` | `WarehousesPage` | `inventory.read` | core.inventory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/projects` | `ProjectsPage` | `projects.read` | construction.projects | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/project-profitability` | `ProfitabilityPage` | `projects.read` | construction.projects | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/projects/:id` | `ProjectDetailPage` | `projects.read` | construction.projects | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/employees` | `EmployeesPage` | `hr.read` | hr.core | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/employees/:id` | `EmployeePage` | `hr.read` | hr.core | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/attendance` | `AttendancePage` | `hr.read` | hr.core | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/privacy` | `PrivacyPage` | `privacy.manage` | hr.core | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/payroll` | `PayrollPage` | `hr.payroll` | hr.payroll | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/payroll/settings` | `PayrollSettingsPage` | `hr.payroll` | hr.payroll | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/payroll/:id` | `PayrollRunPage` | `hr.payroll` | hr.payroll | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/payroll/:id/slip/:employeeId` | `PayrollSlipPage` | `hr.payroll` | hr.payroll | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/executive-summary` | `ExecutiveSummaryPage` | `reports.read` | reports.executive | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/consolidation` | `ConsolidationPage` | `reports.consolidation` | reports.consolidation | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/directory/contacts` | `ContactsPage` | `directory.read` | core.directory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/directory/contacts/:id` | `ContactDetailPage` | `directory.read` | core.directory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/directory/organizations` | `OrganizationsPage` | `directory.read` | core.directory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/directory/organizations/:id` | `OrganizationDetailPage` | `directory.read` | core.directory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/agenda` | `AgendaPage` | `directory.read` | core.directory | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/employee-ledger` | `EmployeeLedgerPage` | `hr.payroll` | hr.employee_ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/employee-ledger/:id` | `EmployeeStatementPage` | `hr.payroll` | hr.employee_ledger | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/social-security` | `SocialSecurityPage` | `hr.payroll` | hr.socialsecurity | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/social-security/settings` | `SocialSettingsPage` | `hr.payroll` | hr.socialsecurity | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/social-security/:id` | `SocialDeclarationPage` | `hr.payroll` | hr.socialsecurity | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/foreign-workers` | `ForeignWorkersPage` | `hr.read` | hr.foreign | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/hr/foreign-workers/settings` | `ForeignSettingsPage` | `hr.read` | hr.foreign | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/subcontracts` | `SubcontractsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/subcontracts/:id` | `SubcontractDetailPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/employer-contracts` | `EmployerContractsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/employer-claims` | `EmployerClaimsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/progress-payments` | `ProgressPaymentsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/progress-payments/new` | `ProgressEditorPage` | `subcontracts.manage` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/progress-payments/:id` | `ProgressEditorPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/variation-orders` | `VariationsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/variation-orders/:id` | `VariationPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/approvals` | `ApprovalsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/construction` | `ConstructionSettingsPage` | `subcontracts.read` | construction.subcontracts | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/requests` | `PurchaseRequestsPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/requests/:id` | `PurchaseRequestEditorPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/rfqs` | `RfqsPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/rfqs/:id` | `RfqPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/matching` | `OrderMatchingPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/orders` | `PurchaseOrdersPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/purchasing/orders/:id` | `PurchaseOrderEditorPage` | `procurement.read` | core.procurement | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/real-estate/units` | `UnitsPage` | `realestate.read` | construction.realestate | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/real-estate/contracts` | `SalesContractsPage` | `realestate.read` | construction.realestate | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/real-estate/contracts/:id` | `SalesContractPage` | `realestate.read` | construction.realestate | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/real-estate/installments` | `SalesInstallmentsPage` | `realestate.read` | construction.realestate | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/company` | `CompanyPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/branches` | `BranchesPage` | `company.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/approvals` | `DocumentApprovalsPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/file-exchange` | `FileExchangePage` | `workspace.use` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/operations` | `OperationsSettingsPage` | `settings.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/backups` | `BackupsPage` | `company.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/recurring` | `RecurringPage` | `settings.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/insights` | `InsightsPage` | `workspace.use` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/activity` | `ActivityPage` | `members.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/members` | `MembersPage` | `members.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/currencies` | `CurrenciesPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/tax-rates` | `TaxRatesPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/periods` | `PeriodsPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/custom-codes` | `CustomCodesPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/modules` | `ModulesPage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/license` | `LicensePage` | `settings.read` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/devices` | `DevicesPage` | `members.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/account-mapping` | `AccountMappingPage` | `accounts.manage` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/reports/data-export` | `DataExportPage` | `data.export` | core.settings | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/account/security` | `SecurityPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/notifications` | `NotificationsPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/settings/notifications` | `NotificationPreferencesPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/catalog` | `ManufacturingCatalogPage` | `manufacturing.catalog.read` | manufacturing.catalog | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/production` | `ManufacturingProductionPage` | `manufacturing.production.read` | manufacturing.production | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/shop-floor` | `ManufacturingShopFloorPage` | `manufacturing.production.read` | manufacturing.production | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/exceptions` | `ManufacturingExceptionsPage` | `manufacturing.production.read` | manufacturing.production | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/quality` | `ManufacturingQualityPage` | `manufacturing.quality.read` | manufacturing.quality | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/subcontracting` | `ManufacturingSubcontractingPage` | `manufacturing.subcontracting.read` | manufacturing.subcontracting | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/costs` | `ManufacturingProductionPage` | `manufacturing.costs.read` | manufacturing.costs | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/mrp` | `ManufacturingMrpPage` | `manufacturing.mrp.read` | manufacturing.mrp | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/supply` | `ManufacturingSupplyPage` | `manufacturing.mrp.read` | manufacturing.mrp | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/promise` | `ManufacturingPromisePage` | `invoices.read` | core.invoices | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/planning` | `ManufacturingOperationsPage` | `manufacturing.planning.read` | manufacturing.planning | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing/maintenance` | `ManufacturingOperationsPage` | `manufacturing.maintenance.read` | manufacturing.maintenance | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/manufacturing` | `ManufacturingOverviewPage` | `manufacturing.catalog.read` | manufacturing.catalog | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/wms` | `ManufacturingWarehousePage` | `inventory.wms.read` | inventory.wms | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/logistics` | `ManufacturingLogisticsPage` | `sales.logistics.read` | sales.logistics | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/integrations` | `ManufacturingIntegrationsPage` | `core.integrations.read` | core.integrations | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather` | `LeatherOverviewPage` | `leather.catalog.read` | leather.catalog | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/models` | `LeatherModelsPage` | `leather.catalog.read` | leather.catalog | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/custom-orders` | `LeatherCustomOrdersPage` | `leather.production.read` | leather.catalog | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/materials` | `LeatherMaterialsPage` | `leather.materials.read` | leather.materials | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/production` | `LeatherProductionPage` | `leather.production.read` | leather.production | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/quality` | `LeatherQualityPage` | `leather.quality.read` | leather.quality | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/subcontracts` | `LeatherSubcontractsPage` | `leather.subcontracting.read` | leather.subcontracting | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/leather/service` | `LeatherServicePage` | `leather.service.read` | leather.service | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/pos` | `PosPage` | `pos.read` | sales.pos | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/pos/settings` | `PosSettingsPage` | `pos.manage` | sales.pos | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/pos/sessions` | `PosSessionsPage` | `pos.read` | sales.pos | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/pos/sales/:id` | `PosSalePage` | `pos.read` | sales.pos | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |
| `/*` | `NotFoundPage` | `—` | — | Ortak sistem; sayfaya özel inceleme gerekli | Bekliyor |

## Satıcı paneli rotaları

| Rota | Ekran bileşeni | Ana izin | Modül kapısı | Kaynakta V2 kapsamı | Bu revizyon görsel QA |
| --- | --- | --- | --- | --- | --- |
| `/login` | `LoginPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/setup` | `SetupPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/` | `DashboardPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/customers` | `CustomersPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/licenses` | `LicensesPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/licenses/:id` | `LicenseDetailPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/releases` | `ReleasesPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/feedback` | `FeedbackPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/audit` | `AuditPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/security` | `SecurityPage` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |
| `/*` | `Navigate` | `—` | — | Ortak sistem + panel düzeni | Bekliyor |

## Kabul kontrol listesi

- [x] Router kaynaklarından mevcut route desenleri çıkarıldı; doğrudan URL ve dinamik kayıt sayfaları envantere alındı.
- [x] Mevcut shared primitive, token, dark theme, API/state ve test altyapısı statik olarak incelendi.
- [ ] Son V2 web/panel typecheck, lint, unit test ve üretim build sonuçları son revizyonla ilişkilendirildi.
- [ ] ERP menü yolları 1440×960, 1280×720 ve 390×844; uzun metinli kritik ekranlar ayrıca 320px genişlikte light/dark tarandı.
- [ ] Satıcı panelinin tüm route ve giriş/kurulum/oturum hata durumları light/dark ve mobilde tarandı.
- [ ] Gerçek auth, onboarding, MFA, lisans, deep-link, modül kapalı ve permission-denied davranışları doğrulandı.
- [ ] Cari/ürün/fatura/yevmiye/tahsilat/ödeme/rapor ve sektörel iş akışları mevcut gerçek API testleriyle doğrulandı.
- [ ] Form hata sonrası değer koruması, ilk hataya odak, yinelenen gönderim engeli, dirty onayı ve başarılı kayıt sonrası ayrılma doğrulandı.
- [ ] Her liste için loading, API error, permission error, empty, filtre/no-results, result count ve mevcut load-more/pagination ayrımı doğrulandı.
- [ ] Tablolarda para/tarih/hassasiyet, debit-credit/tax/totals ve gerçek e-belge durumları değişmeden kaldı.
- [ ] Yan paneller/modal/onaylar: klavye, Escape, odak dönüşü, popover kesilmesi, dar ekran ve pending/error durumları doğrulandı.
- [ ] Baskı/PDF/CSV/XLSX, çevrimdışı saha/portal, POS ve şirket/şube değişimi regresyonları doğrulandı.
- [ ] Son tur ekran görüntüleri görsel olarak incelendi; yatay taşma, ikinci dikey kaydırma, kırpılmış işlem ve console/pageerror bulunmadı.

Tekrarlanabilir tarama kaynakları: `e2e/ui-audit.spec.ts`, `ui-details.spec.ts`, `ui-robustness.spec.ts`, `review-ui.spec.ts`, `planning-ui.spec.ts`, `lisans-server/e2e/license-admin.spec.ts`. Görsel sonuçlar ve başarısız testler ancak gerçekten çalıştırıldıktan sonra bu kabul kaydına eklenmelidir.

## V3 birleşen ekranlar ve yönlendirmeler (10 Ekim 2026)

Aşağıdaki eski adresler kaldırılmadı; sorgu parametreleri korunarak yeni merkez sayfanın ilgili sekmesine yönlenir. Menüde her konu için tek öğe görünür (`apps/web/src/components/layout/navigation.ts` → `NAV_MERGES`). Sunucu izinleri değişmedi; merkez sayfa yalnız kullanıcının izinli olduğu sekmeleri gösterir.

| Yeni merkez | Sekme | Eski adres(ler) | Rota izni |
| --- | --- | --- | --- |
| `/hr/settings` İK ve bordro ayarları | Bordro / SGK / Yabancı işçi | `/hr/payroll/settings`, `/hr/social-security/settings`, `/hr/foreign-workers/settings` | sekme başına (`hr.payroll`, `hr.payroll`, `hr.read`) |
| `/treasury/cash-planning` Nakit planlama | Projeksiyon / Senaryolar | `/treasury/cash-forecast`, `/workspace/scenarios` | `treasury.read` |
| `/settings/integrations` Entegrasyonlar | Kanal bağlantıları / API ve webhook | `/integrations` | `core.integrations.read` |
| `/settings/data-transfer` Veri aktarımı | İçe ve dışa aktarma / Tüm veriyi dışa aktar | `/reports/file-exchange`, `/reports/data-export` | sekme başına (`workspace.use`, `data.export`) |
| `/treasury/expenses` Giderler | Gider fişleri / Gider türleri | `/treasury/expense-cards` | `treasury.read` |

Yeniden adlandırılan menü/başlıklar: "İthalat dosyaları" → "İthalat maliyet dosyaları", "Onay kutusu" → "Hakediş onayları", "Belge onayları" → "Belge onay kuralları", "İşletim ve güvenlik" → "Sistem ve güvenlik", "Rapor panom" → "Analiz panosu", "Sosyal güvenlik" → "SGK bildirgeleri". `/manufacturing/costs` artık üretim ekranını maliyet dağıtımı üstte ve "Üretim maliyetleri" başlığıyla açar.

Ham `<h1>` kullanan 22 detay/editör ekranı `PageHeader`/`PageTitle`'a geçirildi; hepsinde sayfa rehberi ("i"), favori ve son ziyaret kaydı vardır. Görsel QA bu revizyonda pano, cari detayı, satış faturaları, veri aktarımı ve İK ayarları için masaüstü (açık/koyu) ve 375px'te yapıldı; diğer rotalar için "Bekliyor" durumu geçerlidir.
