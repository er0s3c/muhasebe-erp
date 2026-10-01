-- =========================================================================
-- Maliyet kodu (Faz B2a): RLS, yetki, denetim izi ve varsayılan kodlar.
-- Kodun kendisi doğrulama gerektiren bir hukuki parametre değildir; şirket düzenleyebilir.
-- journal_lines üzerindeki cost_code_id değişmezliği mevcut journal_lines_guard ile korunur
-- (kaydedilmiş satırın tüm alanları zaten değiştirilemez). Proje etiketi şartı CHECK ile (journal_lines_cost_code_ck).
-- =========================================================================

ALTER TABLE cost_codes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON cost_codes USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON cost_codes TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_cost_codes AFTER INSERT OR UPDATE OR DELETE ON cost_codes
  FOR EACH ROW EXECUTE FUNCTION audit_row_change();
--> statement-breakpoint

-- Mevcut şirketlere varsayılan maliyet kodları (yeni şirketlere uygulama tohumlar: modules/projects/cost-codes.ts)
INSERT INTO cost_codes (id, company_id, code, name, kind)
SELECT gen_random_uuid(), c.id, d.code, d.name, d.kind
  FROM companies c
 CROSS JOIN (VALUES
   ('MLZ', 'Malzeme', 'material'),
   ('ISC', 'İşçilik', 'labor'),
   ('TSR', 'Taşeron', 'subcontract'),
   ('EKP', 'Ekipman', 'equipment'),
   ('NKL', 'Nakliye', 'transport'),
   ('GNL', 'Genel gider', 'overhead')
 ) AS d(code, name, kind)
ON CONFLICT (company_id, code) DO NOTHING;
