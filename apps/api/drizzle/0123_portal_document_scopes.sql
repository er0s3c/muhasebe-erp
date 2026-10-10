ALTER TABLE "portal_links" ADD COLUMN "scopes" jsonb DEFAULT '{"invoices":false,"quotes":false,"orders":false}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE portal_links ADD CONSTRAINT portal_links_scopes_ck CHECK(jsonb_typeof(scopes)='object' AND scopes ?& ARRAY['invoices','quotes','orders'] AND (scopes-ARRAY['invoices','quotes','orders'])='{}'::jsonb AND jsonb_typeof(scopes->'invoices')='boolean' AND jsonb_typeof(scopes->'quotes')='boolean' AND jsonb_typeof(scopes->'orders')='boolean');
