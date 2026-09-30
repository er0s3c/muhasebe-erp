CREATE TABLE "license_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"installation_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"private_key_pem" text NOT NULL,
	"lease_token" text,
	"high_water" bigint DEFAULT 0 NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error_code" text,
	"last_error" text,
	"pending_request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_state_single_ck" CHECK ("license_state"."id" = 1)
);
