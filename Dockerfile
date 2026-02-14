FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json .
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
RUN npm ci --omit=dev
COPY . .
RUN npx playwright install --with-deps chromium
RUN npm run build
ENV NODE_ENV=production
ENV MCP_TRANSPORT=stdio
CMD ["node", "dist/index.js"]
