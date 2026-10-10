ALTER TABLE "member_branch_access" DROP CONSTRAINT "member_branch_access_membership_fk";
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_rate_type" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_reason" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fx_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "document_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "member_branch_access" ADD CONSTRAINT "member_branch_access_membership_fk" FOREIGN KEY ("company_id","user_id") REFERENCES "public"."memberships"("company_id","user_id") ON DELETE cascade ON UPDATE no action;