FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run db:generate && npm run build -w @task-tg/api
USER node
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@task-tg/api"]
