# syntax=docker/dockerfile:1
# Muhasebe ERP üretim imajı: derlenmiş API + web arayüzü tek kapta, aynı kökenden sunulur.
# Derleme:  docker build -t muhasebe-erp --build-arg APP_VERSION=1.0.0 .
ARG NODE_VERSION=22

# ---- 1) Derleme: tüm bağımlılıklar + web ve API paketleri --------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/license-server/package.json apps/license-server/
COPY apps/license-admin/package.json apps/license-admin/
COPY packages/shared/package.json packages/shared/
COPY packages/license-core/package.json packages/license-core/
RUN npm ci
COPY . .
# Satıcıya ait derleme bağımsız değişkenleri (açık bilgidir, gizli değil): güvenilir satıcı açık anahtarı halkası (JSON) ve varsayılan lisans
# sunucusu adresi pakete GÖMÜLÜR. Anahtar halkası boşsa apps/api/src/licensing/public-keys.json kullanılır; ikisi de boşsa derleme başarısız olur.
ARG LICENSE_PUBLIC_KEYS_JSON=""
ARG LICENSE_SERVER_URL=""
ARG LICENSE_ALLOW_INSECURE_URL=""
RUN npm run build
# Üçüncü taraf lisans bildirimi (MIT/BSD/Apache dağıtımda bildirim şartı): üretim bağımlılıklarından üretilir
RUN npm run licenses:notices

# ---- 2) Yalnızca API'nin üretim bağımlılıkları (yerel modül @node-rs/argon2 dahil) --------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/license-server/package.json apps/license-server/
COPY apps/license-admin/package.json apps/license-admin/
COPY packages/shared/package.json packages/shared/
COPY packages/license-core/package.json packages/license-core/
RUN npm ci --omit=dev -w @erp/api

# ---- 3) Çalışma zamanı ------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=3000 \
    WEB_DIST_DIR=/app/web \
    MIGRATIONS_DIR=/app/dist/drizzle \
    LICENSE_HOST_ID_FILE=/etc/host-machine-id
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=postgres:16-bookworm /usr/lib/postgresql/16/bin/pg_dump /usr/local/bin/pg_dump
COPY --from=postgres:16-bookworm /usr/lib/postgresql/16/bin/pg_restore /usr/local/bin/pg_restore
COPY installer/runtime /opt/construction-setup
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libpq5 liblz4-1 libzstd1 \
    && python3 -m venv /opt/construction \
    && /opt/construction/bin/pip install --no-cache-dir -r /opt/construction-setup/requirements.txt \
    && /opt/construction/bin/python /opt/construction-setup/install-languages.py /opt/construction-tessdata \
    && mkdir -p /var/lib/erp-construction /var/lib/erp-backups && chown node:node /var/lib/erp-construction /var/lib/erp-backups \
    && rm -rf /var/lib/apt/lists/*
ENV CONSTRUCTION_PYTHON=/opt/construction/bin/python \
    CONSTRUCTION_TESSDATA_DIR=/opt/construction-tessdata \
    CONSTRUCTION_STORAGE_DIR=/var/lib/erp-construction
ENV BACKUP_DIRECTORY=/var/lib/erp-backups
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/apps/web/dist ./web
# Bildirim hem imajın kökünde hem de web kökünde (arayüz /THIRD-PARTY-NOTICES.md olarak sunar)
COPY --from=build /app/THIRD-PARTY-NOTICES.md ./THIRD-PARTY-NOTICES.md
COPY --from=build /app/THIRD-PARTY-NOTICES.md ./web/THIRD-PARTY-NOTICES.md
# Kaynak haritaları imajda bulunmasın (kaynak kodu sızmasın)
RUN find /app/web -name '*.map' -delete
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
