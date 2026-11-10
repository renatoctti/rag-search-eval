FROM node:24-slim

LABEL org.opencontainers.image.source="https://github.com/renatoctti/rag-search-eval"

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

# The embedding model is baked in, so a task does not download it on every start. `data` is where
# the ingestion task keeps SciFact while it runs.
RUN mkdir -p .cache data \
 && node -e "import('./src/embed.ts').then((m) => m.embedQuery('warm up'))" \
 && chown -R node:node .cache data
USER node

EXPOSE 3000
CMD ["node", "src/server.ts"]
