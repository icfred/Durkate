FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV HUSKY=0
RUN corepack enable
WORKDIR /repo

# --- deps: install the workspace so dependency resolution works ---
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps apps
COPY packages packages
RUN pnpm install --frozen-lockfile

# --- bundle: produce a single self-contained ESM file ---
FROM deps AS bundle
COPY tsconfig.base.json tsconfig.json ./
RUN pnpm --filter @durak/server bundle

# --- runtime: smallest image that can run the bundle ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080
WORKDIR /app

COPY --from=bundle /repo/apps/server/dist-bundle/main.mjs main.mjs

USER node
CMD ["node", "main.mjs"]
