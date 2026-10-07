-- Match the existing tenant-table policy: runtime connections remain subject
-- to RLS; the installation schema owner can perform a complete pg_dump.
ALTER TABLE pos_tills NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pos_sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE pos_sales NO FORCE ROW LEVEL SECURITY;
