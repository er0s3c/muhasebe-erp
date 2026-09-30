CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret_hash" text NOT NULL,
	"name" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_user_id" uuid,
	"revoked_at" timestamp with time zone,
	"revoked_by" text
);
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "device_id" uuid;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_last_user_id_users_id_fk" FOREIGN KEY ("last_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_last_seen_idx" ON "devices" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "devices_last_user_idx" ON "devices" USING btree ("last_user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_device_idx" ON "refresh_tokens" USING btree ("device_id");