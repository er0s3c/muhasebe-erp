CREATE TABLE "app_updates" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"manifest" text NOT NULL,
	"files" jsonb NOT NULL,
	"download_token" text NOT NULL,
	"offered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'offered' NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp with time zone,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"from_version" text,
	"message" text,
	"log" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_updates_status_ck" CHECK ("app_updates"."status" in ('offered','requested','downloading','applying','done','failed','rolled_back','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "app_updates" ADD CONSTRAINT "app_updates_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_updates_version_uq" ON "app_updates" USING btree ("version");