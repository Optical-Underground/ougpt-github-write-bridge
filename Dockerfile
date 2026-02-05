FROM node:20-alpine

# Cache bust – change this value when you need to force rebuild
ARG CACHE_BUST=2026-02-05-read-debug
ENV CACHE_BUST=${CACHE_BUST}

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 10000

CMD ["node", "src/index.js"]
