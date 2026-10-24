# MedOS API image. Build from the repository root:  docker build -f docker/api.Dockerfile -t medos-api .
# The same image runs migrations (see docker-compose.yml, service "migrate") because it carries the Prisma CLI.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/* \
 && corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /repo

# Dependency layer: only manifests, so source edits do not reinstall packages.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/database/package.json packages/database/
RUN pnpm install --frozen-lockfile

COPY apps/api apps/api
COPY packages packages
# Builds shared + database (prisma generate) + api in dependency order.
RUN pnpm --filter @medos/api... build

FROM build AS runtime
ENV NODE_ENV=production PORT=4000
RUN chown -R node:node /repo
USER node
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]
