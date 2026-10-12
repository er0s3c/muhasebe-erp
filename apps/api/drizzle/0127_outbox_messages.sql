CREATE TABLE "outbox_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"channel" text DEFAULT 'email' NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"source_type" text,
	"source_id" uuid,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"body_text" text NOT NULL,
	"body_html" text,
	"document" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 6 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_messages_dedupe_uq" UNIQUE("company_id","dedupe_key"),
	CONSTRAINT "outbox_messages_status_ck" CHECK ("outbox_messages"."status" in ('pending','sending','delivered','dead_letter','cancelled')),
	CONSTRAINT "outbox_messages_channel_ck" CHECK ("outbox_messages"."channel" = 'email'),
	CONSTRAINT "outbox_messages_attempts_ck" CHECK ("outbox_messages"."attempts" >= 0 and "outbox_messages"."max_attempts" between 1 and 20),
	CONSTRAINT "outbox_messages_recipient_ck" CHECK (char_length("outbox_messages"."recipient") between 3 and 254)
);
--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outbox_messages_due_idx" ON "outbox_messages" USING btree ("company_id","status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "outbox_messages_source_idx" ON "outbox_messages" USING btree ("company_id","source_type","source_id");--> statement-breakpoint
-- E-posta outbox'ı: şirket yalıtımı. Satır silinmez (gönderim geçmişi); çalışma zamanı rolü yalnız ekler ve durum günceller.
ALTER TABLE outbox_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON outbox_messages USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id());
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE ON outbox_messages TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint
-- Gönderilen içerik, alıcı ve kaynak sonradan değişmez; teslim edilen ya da iptal edilen ileti yeniden açılmaz.
CREATE FUNCTION outbox_messages_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
BEGIN
  IF NEW.company_id <> OLD.company_id OR NEW.kind <> OLD.kind OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.recipient <> OLD.recipient OR NEW.subject <> OLD.subject OR NEW.body_text <> OLD.body_text
     OR NEW.body_html IS DISTINCT FROM OLD.body_html OR NEW.document IS DISTINCT FROM OLD.document
     OR NEW.source_type IS DISTINCT FROM OLD.source_type OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'Gönderim kaydının içeriği değiştirilemez' USING ERRCODE = 'ERP25';
  END IF;
  IF OLD.status IN ('delivered', 'cancelled') AND NEW.status <> OLD.status THEN
    RAISE EXCEPTION 'Teslim edilen veya iptal edilen ileti yeniden açılamaz' USING ERRCODE = 'ERP25';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER outbox_messages_guard BEFORE UPDATE ON outbox_messages FOR EACH ROW EXECUTE FUNCTION outbox_messages_guard();
--> statement-breakpoint
-- Gönderici için: yalnız zamanı gelmiş iletisi olan şirketlerin kimliklerini döndürür (RLS'i aşar ama ileti içeriği dönmez).
-- Gönderici her şirkete ayrı işlemde, o şirketin kendi RLS bağlamıyla girer.
CREATE FUNCTION outbox_due_targets() RETURNS TABLE (company_id uuid, organization_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp
  AS $$
    SELECT c.id, c.organization_id FROM companies c
     WHERE EXISTS (SELECT 1 FROM outbox_messages m
                    WHERE m.company_id = c.id AND m.status IN ('pending', 'sending') AND m.next_attempt_at <= now()
                      AND (m.lease_until IS NULL OR m.lease_until < now()))
     ORDER BY c.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION outbox_due_targets() FROM PUBLIC;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION outbox_due_targets() TO erp_app;
  END IF;
END
$$;
