-- Denetim düzeltmeleri (DDL). Kesilmiş (>63 karakter) FK adları kısa adlarla yeniden adlandırılır; yalnızca SQL'de olan
-- kısıtlar/indeksler artık schema.ts'te de tanımlı (zaten varsa yeniden oluşturulmaz).
ALTER TABLE "consolidation_elimination_lines" RENAME CONSTRAINT "consolidation_elimination_lines_elimination_id_consolidation_eliminations_id_fk" TO "consolidation_elim_lines_elimination_fk";
--> statement-breakpoint
ALTER TABLE "consolidation_elimination_lines" RENAME CONSTRAINT "consolidation_elimination_lines_group_id_consolidation_groups_id_fk" TO "consolidation_elim_lines_group_fk";
--> statement-breakpoint
DROP INDEX IF EXISTS "social_declaration_lines_decl_idx";--> statement-breakpoint
ALTER TABLE "license_state" ADD COLUMN "owner_org_id" uuid;--> statement-breakpoint
ALTER TABLE "license_state" ADD CONSTRAINT "license_state_owner_org_id_organizations_id_fk" FOREIGN KEY ("owner_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attendance_entries_wbs_idx" ON "attendance_entries" USING btree ("wbs_id") WHERE "attendance_entries"."wbs_id" is not null;--> statement-breakpoint
CREATE INDEX "attendance_entries_cost_code_idx" ON "attendance_entries" USING btree ("cost_code_id") WHERE "attendance_entries"."cost_code_id" is not null;--> statement-breakpoint
CREATE INDEX "invoices_journal_idx" ON "invoices" USING btree ("journal_entry_id") WHERE "invoices"."journal_entry_id" is not null;--> statement-breakpoint
CREATE INDEX "journal_lines_cost_code_idx" ON "journal_lines" USING btree ("cost_code_id") WHERE "journal_lines"."cost_code_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "party_prices_uq" ON "party_prices" USING btree ("party_id","item_id","kind","min_qty",(coalesce("valid_from", '0001-01-01'::date)));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "price_list_items_uq" ON "price_list_items" USING btree ("price_list_id","item_id","min_qty",(coalesce("valid_from", '0001-01-01'::date)));--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
ALTER TABLE "document_line_serials" DROP CONSTRAINT IF EXISTS "document_line_serials_format_ck";--> statement-breakpoint
ALTER TABLE "document_line_serials" ADD CONSTRAINT "document_line_serials_format_ck" CHECK ("document_line_serials"."serial_no" <> '' and "document_line_serials"."serial_no" = upper(btrim("document_line_serials"."serial_no")));--> statement-breakpoint
ALTER TABLE "item_serials" DROP CONSTRAINT IF EXISTS "item_serials_format_ck";--> statement-breakpoint
ALTER TABLE "item_serials" ADD CONSTRAINT "item_serials_format_ck" CHECK ("item_serials"."serial_no" <> '' and "item_serials"."serial_no" = upper(btrim("item_serials"."serial_no")));--> statement-breakpoint
ALTER TABLE "items" DROP CONSTRAINT IF EXISTS "items_serial_goods_ck";--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_serial_goods_ck" CHECK (not "items"."tracks_serial" or "items"."kind" = 'goods');
