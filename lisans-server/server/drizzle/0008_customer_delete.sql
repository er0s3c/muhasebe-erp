-- Activation deletion remains blocked except inside the scoped customer purge.
CREATE OR REPLACE FUNCTION activations_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF nullif(current_setting('erp.customer_delete', true), '') IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.licenses
      WHERE id = OLD.license_id AND customer_id::text = current_setting('erp.customer_delete', true)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Etkinleştirme kayıtları silinemez; devre dışı bırakılır' USING ERRCODE = 'LIC02';
END $$;
--> statement-breakpoint

-- The runtime role can invoke this operation without blanket DELETE privileges.
CREATE FUNCTION public.delete_license_customer(customer_uuid uuid)
RETURNS TABLE(customer_name text, license_count integer, activation_count integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE previous_scope text;
BEGIN
  SELECT name INTO customer_name FROM public.customers WHERE id = customer_uuid FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM id FROM public.licenses WHERE customer_id = customer_uuid ORDER BY id FOR UPDATE;
  previous_scope := current_setting('erp.customer_delete', true);
  PERFORM set_config('erp.customer_delete', customer_uuid::text, true);
  DELETE FROM public.activations WHERE license_id IN (SELECT id FROM public.licenses WHERE customer_id = customer_uuid);
  GET DIAGNOSTICS activation_count = ROW_COUNT;
  DELETE FROM public.licenses WHERE customer_id = customer_uuid;
  GET DIAGNOSTICS license_count = ROW_COUNT;
  DELETE FROM public.customers WHERE id = customer_uuid;
  PERFORM set_config('erp.customer_delete', coalesce(previous_scope, ''), true);
  RETURN NEXT;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.delete_license_customer(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT EXECUTE ON FUNCTION public.delete_license_customer(uuid) TO erp_app;
  END IF;
END $$;
