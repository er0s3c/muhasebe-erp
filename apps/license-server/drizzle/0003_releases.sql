CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"manifest" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	CONSTRAINT "releases_status_ck" CHECK ("releases"."status" in ('draft', 'published', 'withdrawn')),
	CONSTRAINT "releases_manifest_ck" CHECK (("releases"."status" = 'draft') = ("releases"."manifest" is null))
);
--> statement-breakpoint
ALTER TABLE "activations" ADD COLUMN "platform" text;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "update_version" text;--> statement-breakpoint
ALTER TABLE "licenses" ADD COLUMN "update_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_created_by_admins_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "releases_version_uq" ON "releases" USING btree ("version");