FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@8.10.3 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm exec turbo run build --filter=@space/server... --filter=@space/worker... --filter=@space/tools... --filter=@space/event-service...
RUN pnpm --filter @space/server deploy --prod /runtime/apps/server \
 && pnpm --filter @space/worker deploy --prod /runtime/apps/worker \
 && pnpm --filter @space/event-service deploy --prod /runtime/apps/events \
 && pnpm --filter @space/tools deploy --prod /runtime/scripts

FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache poppler-utils util-linux-misc font-liberation
ENV NODE_ENV=production
COPY --from=build --chown=node:node /runtime/ ./
RUN mkdir -p /app/.space-memory && chown node:node /app/.space-memory && chmod 700 /app/.space-memory
USER node
CMD ["node", "apps/server/dist/main.js"]
