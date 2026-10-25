FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run db:generate && npm run build -w @task-tg/api

FROM build AS test
USER node
CMD ["npm", "run", "test:integration", "-w", "@task-tg/api"]

FROM base AS runtime
ENV NODE_ENV=production
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci --omit=dev --workspace @task-tg/api --workspace @task-tg/shared && npm cache clean --force
COPY --from=build /app/apps/api/dist apps/api/dist
COPY apps/api/prisma apps/api/prisma
COPY apps/api/prisma.config.ts apps/api/prisma.config.ts
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
