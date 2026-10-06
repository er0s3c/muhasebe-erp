\set ON_ERROR_STOP on
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('erp', 'erp_app')) <> 2 THEN
    RAISE EXCEPTION 'Beklenen ERP rolleri eksik';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('erp', 'erp_app')
    AND (NOT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication)) THEN
    RAISE EXCEPTION 'ERP rol yetkileri beklenenden farklı';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname IN ('erp', 'erp_app')) THEN
    RAISE EXCEPTION 'ERP rollerinde beklenmeyen rol üyeliği var';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE d.datname = 'erp_license' AND r.rolname = 'erp') THEN
    RAISE EXCEPTION 'Lisans veritabanı sahibi beklenenden farklı';
  END IF;
END $$;
