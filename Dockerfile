# --- Étape de construction : compile le module natif better-sqlite3 ---
FROM node:20-bookworm-slim AS builder
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# --- Image finale : aucun outil de compilation, image légère ---
FROM node:20-bookworm-slim
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public

RUN mkdir -p /data /media && chown -R node:node /data /media /app
USER node

ENV NODE_ENV=production
# Fuseau horaire de l'application : les rappels (récap de 18 h, jeudi 19 h…), « aujourd'hui » et les heures du
# journal d'audit s'entendent en heure locale. Sans cette ligne, un conteneur tourne en UTC (1 à 2 h de décalage
# en France). Pour un autre fuseau : variable TZ dans docker-compose.yml.
ENV TZ=Europe/Paris
ENV PORT=3000
ENV DATA_DIR=/data
VOLUME ["/data", "/media"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/state').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
