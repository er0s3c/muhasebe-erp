CREATE TABLE "cash_forecast_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"item_date" date NOT NULL,
	"direction" text NOT NULL,
	"description" text NOT NULL,
	"amount" numeric(19, 4) NOT NULL,
	"currency_code" text NOT NULL,
	"project_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cash_forecast_items_id_company_uq" UNIQUE("id","company_id"),
	CONSTRAINT "cash_forecast_items_direction_ck" CHECK ("cash_forecast_items"."direction" in ('in','out')),
	CONSTRAINT "cash_forecast_items_amount_ck" CHECK ("cash_forecast_items"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_currency_code_currencies_code_fk" FOREIGN KEY ("currency_code") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cash_forecast_items" ADD CONSTRAINT "cash_forecast_items_project_fk" FOREIGN KEY ("project_id","company_id") REFERENCES "public"."projects"("id","company_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cash_forecast_items_date_idx" ON "cash_forecast_items" USING btree ("company_id","item_date");