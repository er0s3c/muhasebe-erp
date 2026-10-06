ALTER TABLE "operation_entries" DROP CONSTRAINT "operation_entries_kind_ck";--> statement-breakpoint
ALTER TABLE "operation_entries" ADD CONSTRAINT "operation_entries_kind_ck" CHECK ("operation_entries"."kind" in ('collection','site_report','schedule','equipment','equipment_log','defect','rfi','site_instruction','quality_check','safety'));
--> statement-breakpoint
ALTER TABLE work_items DROP CONSTRAINT work_items_record_kind_ck;
ALTER TABLE work_items ADD CONSTRAINT work_items_record_kind_ck CHECK(record_kind IS NULL OR record_kind IN ('party','invoice','project','subcontract','sales_contract','employee','transaction','site_report','defect','rfi','site_instruction','quality_check','safety'));
ALTER TABLE record_documents DROP CONSTRAINT record_documents_kind_ck;
ALTER TABLE record_documents ADD CONSTRAINT record_documents_kind_ck CHECK(record_kind IN ('party','invoice','project','subcontract','sales_contract','employee','transaction','site_report','defect','rfi','site_instruction','quality_check','safety'));
