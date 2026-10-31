# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM dependencies AS build
COPY . .
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ARG IVAT_RELEASE_TAG
ARG IVAT_RELEASE_REVISION
ENV NEXT_TELEMETRY_DISABLED=1
RUN test -n "$NEXT_PUBLIC_SUPABASE_URL" && test -n "$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY" \
    && node scripts/write-release-identity.mjs "$IVAT_RELEASE_TAG" "$IVAT_RELEASE_REVISION" && npm run build

FROM dependencies AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-bookworm-slim@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da AS runtime
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node package.json package-lock.json tsconfig.json ./
COPY --chown=node:node messages ./messages
COPY --chown=node:node schemas ./schemas
# Runtime source consumers (including the XML serializer) use the very same
# generated metadata as the compiled Next.js application.
COPY --from=build --chown=node:node /app/src ./src
COPY --chown=node:node worker ./worker
COPY --chown=node:node scripts/bootstrap-superadmin.ts ./scripts/bootstrap-superadmin.ts
COPY --chown=node:node supabase/migrations ./supabase/migrations
COPY --chown=node:node deploy/scripts ./deploy/scripts
USER node
EXPOSE 3000
CMD ["node", "server.js"]
