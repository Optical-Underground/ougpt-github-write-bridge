FROM node:20-alpine

WORKDIR /app

# Install deps (production only)
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy source
COPY . .

ENV NODE_ENV=production

# Render will route to $PORT; this is informational only.
EXPOSE 10000

# Run the server directly so we know exactly what's executing
CMD ["node", "src/index.js"]
