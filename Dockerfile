# syntax=docker/dockerfile:1
# Build: install with the lockfile, compile TypeScript, keep production dependencies only.
FROM node:26.12.1-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN pnpm run build && pnpm prune --prod --ignore-scripts

# Run: small, non-root. Migrations run on start-up (src/main.ts), before the port opens.
FROM node:26.12.1-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
