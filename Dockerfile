# API ve işçi için üretim imajı. Web arayüzü (apps/web/dist) ayrı olarak CDN/ters vekil üzerinden sunulur.
# Gizli bilgiler imaja girmez; çalışma anında ortam değişkeniyle verilir.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps/api apps/api
COPY apps/web apps/web
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production APP_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w apps/api && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/migrations apps/api/migrations
USER node
WORKDIR /app/apps/api
EXPOSE 3000
# İşçi için: docker run ... node dist/src/cli/worker.js
CMD ["node", "dist/src/server.js"]
