CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rate_limit_expiry" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE rate_limit_buckets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON rate_limit_buckets FROM PUBLIC,erp_app;
CREATE FUNCTION rate_limit_step(p_key text,p_max int,p_window int,p_mode text) RETURNS TABLE(current int,ttl int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_count int; v_expiry timestamptz; v_now timestamptz:=clock_timestamp(); BEGIN
IF p_key !~ '^[a-f0-9]{64}$' OR p_max<1 OR p_max>1000000 OR p_window<1 OR p_window>86400000 OR p_mode NOT IN ('consume','blocked','reset') THEN
RAISE EXCEPTION 'Geçersiz oran sınırı parametresi' USING ERRCODE='22023'; END IF;
PERFORM pg_advisory_xact_lock(hashtextextended('limiter:' || p_key,0));
IF p_mode='reset' THEN DELETE FROM rate_limit_buckets WHERE key=p_key; RETURN QUERY SELECT 0,0; RETURN; END IF;
IF p_mode='consume' THEN
INSERT INTO rate_limit_buckets(key,count,expires_at) VALUES(p_key,1,v_now+p_window*interval '1 millisecond')
ON CONFLICT(key) DO UPDATE SET count=CASE WHEN rate_limit_buckets.expires_at<=v_now THEN 1 ELSE least(rate_limit_buckets.count+1,1000000000) END,
expires_at=CASE WHEN rate_limit_buckets.expires_at<=v_now THEN v_now+p_window*interval '1 millisecond' ELSE rate_limit_buckets.expires_at END
RETURNING count,expires_at INTO v_count,v_expiry;
ELSE SELECT count,expires_at INTO v_count,v_expiry FROM rate_limit_buckets WHERE key=p_key; END IF;
IF v_expiry IS NULL OR v_expiry<=v_now THEN RETURN QUERY SELECT 0,0; ELSE RETURN QUERY SELECT v_count,greatest(1,ceil(extract(epoch FROM(v_expiry-v_now))*1000)::int); END IF;
IF random()<0.01 THEN DELETE FROM rate_limit_buckets WHERE key IN (SELECT key FROM rate_limit_buckets WHERE expires_at<v_now ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED); END IF;
END $$;
REVOKE ALL ON FUNCTION rate_limit_step(text,int,int,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rate_limit_step(text,int,int,text) TO erp_app;
