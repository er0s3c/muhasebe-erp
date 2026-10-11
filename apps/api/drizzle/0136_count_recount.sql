ALTER TABLE "stock_count_lines" ADD COLUMN "counted_by" uuid;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD COLUMN "recount_qty" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD COLUMN "recounted_by" uuid;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "blind" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "stock_counts" ADD COLUMN "recount_tolerance_pct" numeric(9, 4);--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_counted_by_users_id_fk" FOREIGN KEY ("counted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_recounted_by_users_id_fk" FOREIGN KEY ("recounted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_count_lines" ADD CONSTRAINT "stock_count_lines_recount_ck" CHECK (("stock_count_lines"."recount_qty" is null) = ("stock_count_lines"."recounted_by" is null) and ("stock_count_lines"."recounted_by" is null or "stock_count_lines"."counted_by" is null or "stock_count_lines"."recounted_by" <> "stock_count_lines"."counted_by") and ("stock_count_lines"."recount_qty" is null or "stock_count_lines"."recount_qty" >= 0));--> statement-breakpoint
ALTER TABLE "stock_counts" ADD CONSTRAINT "stock_counts_tolerance_ck" CHECK ("stock_counts"."recount_tolerance_pct" is null or "stock_counts"."recount_tolerance_pct" between 0 and 100);