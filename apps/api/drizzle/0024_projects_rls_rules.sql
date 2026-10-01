-- =========================================================================
-- Şantiye / proje (Faz B1): RLS, yetki, denetim izi ve iş kuralları.
-- Kurallar ERRCODE ERP09 ile yükselir (API'de 422 PROJECT_RULE_VIOLATION);
-- ERP01 defter, ERP02 stok, ERP03 fatura, ERP04 irsaliye, ERP05 kasa/banka, ERP06 banka ekstresi,
-- ERP07 denetim kaydı, ERP08 lisans durumu kuralları içindir.
-- journal_lines_guard() DEĞİŞMEZ: kaydedilmiş satırın proje/iş kalemi alanları, tüm satırı
-- karşılaştıran mevcut korumayla zaten değiştirilemezdir.
-- =========================================================================

-- 1) Satır düzeyinde güvenlik
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'project_wbs', 'project_budgets', 'project_budget_lines', 'project_progress'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (company_id = app_company_id()) WITH CHECK (company_id = app_company_id())',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 2) Yetkiler (erp_app şema sahibi değildir). İlerleme kayıtları yalnızca eklenir.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'erp_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON projects, project_wbs, project_budgets, project_budget_lines TO erp_app;
    GRANT SELECT, INSERT ON project_progress TO erp_app;
  END IF;
END
$$;
--> statement-breakpoint

-- 3) Denetim izi
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['projects', 'project_wbs', 'project_budgets', 'project_budget_lines', 'project_progress'] LOOP
    EXECUTE format(
      'CREATE TRIGGER audit_%1$s AFTER INSERT OR UPDATE OR DELETE ON %1$I FOR EACH ROW EXECUTE FUNCTION audit_row_change()',
      t);
  END LOOP;
END
$$;
--> statement-breakpoint

-- 4) Yardımcı: bir iş kaleminde maliyet/bütçe/ilerleme kaydı var mı? (alt iş eklemeyi ve silmeyi engeller)
CREATE FUNCTION project_wbs_has_postings(p_wbs uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$
  SELECT EXISTS (SELECT 1 FROM journal_lines WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM invoice_lines WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM stock_movements WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM project_budget_lines WHERE wbs_id = p_wbs)
      OR EXISTS (SELECT 1 FROM project_progress WHERE wbs_id = p_wbs)
$$;
--> statement-breakpoint

-- Yardımcı: projede etiketli maliyet/gelir satırı var mı?
CREATE FUNCTION project_has_postings(p_project uuid) RETURNS boolean LANGUAGE sql STABLE AS
$$
  SELECT EXISTS (SELECT 1 FROM journal_lines WHERE project_id = p_project)
      OR EXISTS (SELECT 1 FROM invoice_lines WHERE project_id = p_project)
      OR EXISTS (SELECT 1 FROM stock_movements WHERE project_id = p_project)
$$;
--> statement-breakpoint

-- 5) Proje: tür ve kod değişmez, durum geçişleri sınırlı, işveren müşteri türünde olmalı, maliyetli proje silinemez/iptal edilemez.
CREATE FUNCTION projects_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pk text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF project_has_postings(OLD.id) THEN
      RAISE EXCEPTION 'Maliyet kaydı olan proje silinemez; tamamlandı olarak işaretleyin' USING ERRCODE = 'ERP09';
    END IF;
    IF EXISTS (SELECT 1 FROM project_wbs WHERE project_id = OLD.id)
       OR EXISTS (SELECT 1 FROM project_budgets WHERE project_id = OLD.id) THEN
      RAISE EXCEPTION 'İş kalemi veya bütçesi olan proje silinemez' USING ERRCODE = 'ERP09';
    END IF;
    RETURN OLD;
  END IF;

  IF NEW.kind = 'contract' THEN
    SELECT kind INTO pk FROM parties WHERE id = NEW.client_party_id AND company_id = NEW.company_id;
    IF pk IS NULL OR pk NOT IN ('customer', 'both') THEN
      RAISE EXCEPTION 'İşveren, müşteri türünde bir cari olmalı' USING ERRCODE = 'ERP09';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id THEN
      RAISE EXCEPTION 'Proje başka şirkete taşınamaz' USING ERRCODE = 'ERP09';
    END IF;
    IF NEW.kind <> OLD.kind THEN
      RAISE EXCEPTION 'Proje türü değiştirilemez' USING ERRCODE = 'ERP09';
    END IF;
    IF NEW.code <> OLD.code THEN
      RAISE EXCEPTION 'Proje kodu değiştirilemez' USING ERRCODE = 'ERP09';
    END IF;
    IF NEW.status <> OLD.status THEN
      IF NOT (
        (OLD.status = 'planned'   AND NEW.status IN ('active', 'cancelled')) OR
        (OLD.status = 'active'    AND NEW.status IN ('on_hold', 'completed', 'cancelled')) OR
        (OLD.status = 'on_hold'   AND NEW.status IN ('active', 'completed', 'cancelled')) OR
        (OLD.status = 'completed' AND NEW.status = 'active') OR
        (OLD.status = 'cancelled' AND NEW.status = 'planned')
      ) THEN
        RAISE EXCEPTION 'Geçersiz proje durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP09';
      END IF;
      IF NEW.status = 'cancelled' AND project_has_postings(OLD.id) THEN
        RAISE EXCEPTION 'Maliyet kaydı olan proje iptal edilemez; tamamlandı olarak işaretleyin' USING ERRCODE = 'ERP09';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER projects_guard
  BEFORE INSERT OR UPDATE OR DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_guard();
--> statement-breakpoint

-- 6) İş kırılımı: derinlik ≤ 6, döngü yok; kaydı (maliyet/bütçe/ilerleme) olan düğüme alt iş eklenemez.
--    Üst düğüm FOR UPDATE ile kilitlenir: aynı anda "yaprağa maliyet yaz" ile "yaprağa alt iş ekle" serileşir
--    (maliyet tarafındaki tetikleyiciler iş kalemini FOR SHARE kilitler).
CREATE FUNCTION project_wbs_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  par project_wbs%ROWTYPE;
  cur uuid;
  chain int;
  height int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF project_wbs_has_postings(OLD.id) THEN
      RAISE EXCEPTION 'Maliyet, bütçe veya ilerleme kaydı olan iş kalemi silinemez; pasifleştirin' USING ERRCODE = 'ERP09';
    END IF;
    IF EXISTS (SELECT 1 FROM project_wbs WHERE parent_id = OLD.id) THEN
      RAISE EXCEPTION 'Alt işi olan iş kalemi silinemez' USING ERRCODE = 'ERP09';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' AND (NEW.project_id <> OLD.project_id OR NEW.company_id <> OLD.company_id) THEN
    RAISE EXCEPTION 'İş kalemi başka projeye taşınamaz' USING ERRCODE = 'ERP09';
  END IF;

  IF NEW.parent_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.parent_id IS DISTINCT FROM OLD.parent_id) THEN
    SELECT * INTO par FROM project_wbs WHERE id = NEW.parent_id AND project_id = NEW.project_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Üst iş kalemi bulunamadı' USING ERRCODE = 'ERP09';
    END IF;
    IF NOT par.is_active THEN
      RAISE EXCEPTION 'Pasif iş kalemine alt iş eklenemez' USING ERRCODE = 'ERP09';
    END IF;
    IF project_wbs_has_postings(par.id) THEN
      RAISE EXCEPTION 'Maliyet, bütçe veya ilerleme kaydı olan iş kalemine alt iş eklenemez (yeni bir iş kalemi açın)' USING ERRCODE = 'ERP09';
    END IF;

    -- yukarı doğru yürü: döngü ve derinlik
    cur := par.id;
    chain := 1;
    LOOP
      IF TG_OP = 'UPDATE' AND cur = NEW.id THEN
        RAISE EXCEPTION 'İş kalemi kendi altına taşınamaz' USING ERRCODE = 'ERP09';
      END IF;
      SELECT parent_id INTO cur FROM project_wbs WHERE id = cur;
      EXIT WHEN cur IS NULL;
      chain := chain + 1;
      IF chain > 12 THEN
        RAISE EXCEPTION 'İş kırılımı ağacı geçersiz (döngü)' USING ERRCODE = 'ERP09';
      END IF;
    END LOOP;

    height := 0;
    IF TG_OP = 'UPDATE' THEN
      WITH RECURSIVE d AS (
        SELECT id, 1 AS lvl FROM project_wbs WHERE parent_id = NEW.id
        UNION ALL
        SELECT w.id, d.lvl + 1 FROM project_wbs w JOIN d ON w.parent_id = d.id
      )
      SELECT coalesce(max(lvl), 0) INTO height FROM d;
    END IF;
    IF chain + 1 + height > 6 THEN
      RAISE EXCEPTION 'İş kırılımı en çok 6 seviye olabilir' USING ERRCODE = 'ERP09';
    END IF;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_wbs_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project_wbs
  FOR EACH ROW EXECUTE FUNCTION project_wbs_guard();
--> statement-breakpoint

-- 7) Yardımcı: maliyet/bütçe/ilerleme alabilecek iş kalemi kontrolü (yaprak; isteğe bağlı aktif şartı). İş kalemini FOR SHARE kilitler.
CREATE FUNCTION project_wbs_require_leaf(p_wbs uuid, p_project uuid, p_require_active boolean) RETURNS void LANGUAGE plpgsql AS
$$
DECLARE
  w project_wbs%ROWTYPE;
BEGIN
  SELECT * INTO w FROM project_wbs WHERE id = p_wbs AND project_id = p_project FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'İş kalemi bu projeye ait değil' USING ERRCODE = 'ERP09';
  END IF;
  IF EXISTS (SELECT 1 FROM project_wbs c WHERE c.parent_id = w.id) THEN
    RAISE EXCEPTION 'İş kalemi yaprak değil (%); kayıt yalnızca alt işi olmayan iş kalemine yazılır', w.code USING ERRCODE = 'ERP09';
  END IF;
  IF p_require_active AND NOT w.is_active THEN
    RAISE EXCEPTION 'Pasif iş kalemine kayıt yazılamaz (%)', w.code USING ERRCODE = 'ERP09';
  END IF;
END
$$;
--> statement-breakpoint

-- 8) Yevmiye satırı: proje yalnızca gelir/gider/maliyet hesaplarında; iş kalemi yaprak ve projeye ait;
--    tamamlanmış/iptal edilmiş projeye yeni satır yazılamaz (ters kayıt fişleri hariç: önceki etiketi nötrleyebilmeli).
CREATE FUNCTION journal_lines_project_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  acc_type text;
  pr projects%ROWTYPE;
  rev uuid;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.wbs_id IS NOT DISTINCT FROM OLD.wbs_id THEN
    RETURN NEW;
  END IF;

  SELECT type INTO acc_type FROM accounts WHERE id = NEW.account_id AND company_id = NEW.company_id;
  IF acc_type IS NULL OR acc_type NOT IN ('income', 'expense', 'cost') THEN
    RAISE EXCEPTION 'Proje yalnızca gelir, gider ve maliyet hesaplarına etiketlenebilir' USING ERRCODE = 'ERP09';
  END IF;

  SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proje bulunamadı' USING ERRCODE = 'ERP09';
  END IF;

  SELECT reversal_of_id INTO rev FROM journal_entries WHERE id = NEW.entry_id AND company_id = NEW.company_id;
  IF pr.status IN ('completed', 'cancelled') AND rev IS NULL THEN
    RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye (%) yeni satır yazılamaz', pr.code USING ERRCODE = 'ERP09';
  END IF;

  IF NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, rev IS NULL);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER journal_lines_project_guard
  BEFORE INSERT OR UPDATE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION journal_lines_project_guard();
--> statement-breakpoint

-- 9) Stok hareketi: proje yalnızca sarf (issue) ve fire (waste) belgelerinde ve bunların ters belgelerinde.
CREATE FUNCTION stock_movements_project_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  d stock_documents%ROWTYPE;
  pr projects%ROWTYPE;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT * INTO d FROM stock_documents WHERE id = NEW.document_id AND company_id = NEW.company_id;
  IF NOT FOUND OR d.type NOT IN ('issue', 'waste') THEN
    RAISE EXCEPTION 'Proje yalnızca malzeme sarfı ve fire hareketlerine yazılabilir' USING ERRCODE = 'ERP09';
  END IF;
  SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proje bulunamadı' USING ERRCODE = 'ERP09';
  END IF;
  IF pr.status IN ('completed', 'cancelled') AND d.reversal_of_id IS NULL THEN
    RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye (%) yeni hareket yazılamaz', pr.code USING ERRCODE = 'ERP09';
  END IF;
  IF NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, d.reversal_of_id IS NULL);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER stock_movements_project_guard
  BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_project_guard();
--> statement-breakpoint

-- 10) Fatura satırı: proje yalnızca alış, gider ve alış iadesi faturasının stoksuz (hizmet/serbest) satırında.
--     Stoklu kalem projeye doğrudan değil, stoktan proje sarfı anında yazılır.
CREATE FUNCTION invoice_lines_project_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  itype text;
  pr projects%ROWTYPE;
BEGIN
  IF NEW.project_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id AND NEW.wbs_id IS NOT DISTINCT FROM OLD.wbs_id THEN
    RETURN NEW;
  END IF;
  SELECT type INTO itype FROM invoices WHERE id = NEW.invoice_id AND company_id = NEW.company_id;
  IF itype IS NULL OR itype NOT IN ('purchase', 'expense', 'purchase_return') THEN
    RAISE EXCEPTION 'Proje şimdilik yalnızca alış, gider ve alış iadesi faturası kalemlerine yazılabilir' USING ERRCODE = 'ERP09';
  END IF;
  IF NEW.delivery_line_id IS NOT NULL
     OR (NEW.item_id IS NOT NULL AND EXISTS (SELECT 1 FROM items WHERE id = NEW.item_id AND company_id = NEW.company_id AND kind = 'goods')) THEN
    RAISE EXCEPTION 'Stoklu kalem projeye doğrudan yazılamaz; malzeme stoktan projeye sarf edilir' USING ERRCODE = 'ERP09';
  END IF;
  SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Proje bulunamadı' USING ERRCODE = 'ERP09';
  END IF;
  IF pr.status IN ('completed', 'cancelled') THEN
    RAISE EXCEPTION 'Tamamlanmış veya iptal edilmiş projeye (%) kalem yazılamaz', pr.code USING ERRCODE = 'ERP09';
  END IF;
  IF NEW.wbs_id IS NOT NULL THEN
    PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, true);
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER invoice_lines_project_guard
  BEFORE INSERT OR UPDATE ON invoice_lines
  FOR EACH ROW EXECUTE FUNCTION invoice_lines_project_guard();
--> statement-breakpoint

-- 11) Bütçe revizyonu: numara ardışık (proje kilitli), yalnızca taslak olarak açılır; taslak → onaylı → yerine yenisi onaylanınca 'superseded';
--     onaylı revizyon değiştirilemez/silinemez; boş bütçe onaylanamaz.
CREATE FUNCTION project_budgets_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
  next_no int;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN
      RAISE EXCEPTION 'Onaylanmış bütçe revizyonu silinemez' USING ERRCODE = 'ERP09';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'INSERT' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR UPDATE;
    IF NOT FOUND OR pr.status = 'cancelled' THEN
      RAISE EXCEPTION 'İptal edilmiş projeye bütçe eklenemez' USING ERRCODE = 'ERP09';
    END IF;
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'Bütçe revizyonu taslak olarak açılır' USING ERRCODE = 'ERP09';
    END IF;
    SELECT coalesce(max(revision_no), 0) + 1 INTO next_no FROM project_budgets WHERE project_id = NEW.project_id;
    IF NEW.revision_no <> next_no THEN
      RAISE EXCEPTION 'Revizyon numarası % olmalı', next_no USING ERRCODE = 'ERP09';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.status = 'draft' AND NEW.status = 'draft' THEN
    IF (to_jsonb(NEW) - 'title') IS DISTINCT FROM (to_jsonb(OLD) - 'title') THEN
      RAISE EXCEPTION 'Taslak bütçede yalnızca başlık değiştirilebilir' USING ERRCODE = 'ERP09';
    END IF;
    RETURN NEW;
  END IF;

  IF (to_jsonb(NEW) - 'status' - 'approved_at' - 'approved_by') IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'approved_at' - 'approved_by') THEN
    RAISE EXCEPTION 'Onaylanmış bütçe revizyonu değiştirilemez' USING ERRCODE = 'ERP09';
  END IF;

  IF OLD.status = 'draft' AND NEW.status = 'approved' THEN
    SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id FOR UPDATE;
    IF pr.status = 'cancelled' THEN
      RAISE EXCEPTION 'İptal edilmiş projenin bütçesi onaylanamaz' USING ERRCODE = 'ERP09';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM project_budget_lines WHERE budget_id = NEW.id) THEN
      RAISE EXCEPTION 'Boş bütçe onaylanamaz' USING ERRCODE = 'ERP09';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'approved' AND NEW.status = 'superseded' THEN
    IF NOT EXISTS (
      SELECT 1 FROM project_budgets b
       WHERE b.project_id = NEW.project_id AND b.status = 'approved' AND b.revision_no > NEW.revision_no
    ) THEN
      RAISE EXCEPTION 'Bütçe revizyonu yalnızca daha yeni bir onaylı revizyon varken devre dışı kalır' USING ERRCODE = 'ERP09';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Geçersiz bütçe durum geçişi (% → %)', OLD.status, NEW.status USING ERRCODE = 'ERP09';
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_budgets_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project_budgets
  FOR EACH ROW EXECUTE FUNCTION project_budgets_guard();
--> statement-breakpoint

-- 12) Bütçe satırı: yalnızca taslak revizyonda (revizyon FOR SHARE kilitli: onayla yarışır), yalnızca yaprak iş kaleminde.
CREATE FUNCTION project_budget_lines_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  b project_budgets%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT * INTO b FROM project_budgets WHERE id = OLD.budget_id;
    -- Üst revizyon yoksa (taslak silinirken cascade) izin ver
    IF FOUND AND b.status <> 'draft' THEN
      RAISE EXCEPTION 'Onaylanmış bütçenin satırları silinemez' USING ERRCODE = 'ERP09';
    END IF;
    RETURN OLD;
  END IF;

  SELECT * INTO b FROM project_budgets WHERE id = NEW.budget_id FOR SHARE;
  IF NOT FOUND OR b.status <> 'draft' THEN
    RAISE EXCEPTION 'Yalnızca taslak bütçe revizyonunun satırları eklenir veya değiştirilir' USING ERRCODE = 'ERP09';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.budget_id <> OLD.budget_id OR NEW.wbs_id <> OLD.wbs_id OR NEW.project_id <> OLD.project_id) THEN
    RAISE EXCEPTION 'Bütçe satırının iş kalemi değiştirilemez' USING ERRCODE = 'ERP09';
  END IF;
  PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_budget_lines_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project_budget_lines
  FOR EACH ROW EXECUTE FUNCTION project_budget_lines_guard();
--> statement-breakpoint

-- 13) İlerleme: yalnızca eklenir; yalnızca yaprak iş kalemi; iptal edilmiş projeye girilmez.
CREATE FUNCTION project_progress_guard() RETURNS trigger LANGUAGE plpgsql AS
$$
DECLARE
  pr projects%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'İlerleme kayıtları değiştirilemez; yeni kayıt girin' USING ERRCODE = 'ERP09';
  END IF;
  SELECT * INTO pr FROM projects WHERE id = NEW.project_id AND company_id = NEW.company_id;
  IF NOT FOUND OR pr.status = 'cancelled' THEN
    RAISE EXCEPTION 'İptal edilmiş projeye ilerleme girilemez' USING ERRCODE = 'ERP09';
  END IF;
  PERFORM project_wbs_require_leaf(NEW.wbs_id, NEW.project_id, false);
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_progress_guard
  BEFORE INSERT OR UPDATE OR DELETE ON project_progress
  FOR EACH ROW EXECUTE FUNCTION project_progress_guard();
