# syntax=docker/dockerfile:1
# Lisans sunucusu imajı (satıcı VPS'inde çalışır; MÜŞTERİYE VERİLMEZ).
# Derleme (depo kökünden):  docker build -f lisans-server/server/Dockerfile -t muhasebe-lisans --build-arg APP_VERSION=1.0.0 .
ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY lisans-server/server/package.json lisans-server/server/
COPY lisans-server/panel/package.json lisans-server/panel/
COPY packages/shared/package.json packages/shared/
COPY lisans-server/core/package.json lisans-server/core/
RUN npm ci
COPY packages packages
COPY lisans-server/core lisans-server/core
COPY lisans-server/server lisans-server/server
COPY lisans-server/deploy/migrations-policy.json lisans-server/deploy/migrations-policy.json
# Yönetim paneli: ortak arayüz bileşenleri web uygulamasından alınır (vite alias @ui). Bileşenler web'in lib/,
# layout/, i18n/ modüllerini ve public/ görsellerini de kullandığından web uygulaması bütün olarak kopyalanır.
COPY lisans-server/panel lisans-server/panel
COPY apps/web apps/web
RUN npm run build -w @erp/license-admin && npm run build -w @erp/license-server

FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY lisans-server/server/package.json lisans-server/server/
COPY lisans-server/panel/package.json lisans-server/panel/
COPY packages/shared/package.json packages/shared/
COPY lisans-server/core/package.json lisans-server/core/
RUN npm ci --omit=dev -w @erp/license-server

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ARG APP_VERSION=dev
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=4000 \
    MIGRATIONS_DIR=/app/dist/drizzle \
    PANEL_DIST_DIR=/app/panel \
    RELEASES_DIR=/var/lib/erp-license/releases
WORKDIR /app
# Uzaktan güncelleme kit arşivleri (kalıcı birim bağlanır; sahibi uygulama kullanıcısı)
RUN mkdir -p /var/lib/erp-license/releases && chown -R node:node /var/lib/erp-license
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/lisans-server/server/dist ./dist
COPY --from=build /app/lisans-server/panel/dist ./panel
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
