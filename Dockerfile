# syntax=docker/dockerfile:1
#
# barcode-wms — optimized multi-stage Alpine build.
# Stage 1 compiles the canvas native binding (no musl prebuild exists) and strips it.
# Stage 2 keeps only runtime shared libs + JS, dropping the entire toolchain + npm.
#
# ---- Stage 1: build native deps ----
# Pinned to alpine3.21: newer Alpine's librsvg pulls the heavy glycin sandbox chain.
FROM node:24-alpine3.21 AS build

RUN apk add --no-cache \
        build-base python3 pkgconf binutils \
        cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev \
        pixman-dev freetype-dev fontconfig-dev harfbuzz-dev glib-dev

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    # strip debug symbols from the native binding
    && find node_modules -name '*.node' -exec sh -c 'strip --strip-unneeded "$1" 2>/dev/null || true' _ {} \; \
    # strip non-runtime bloat (keep .js + .node binaries intact)
    && find node_modules -type f \( -name '*.md' -o -iname 'readme*' -o -name '*.markdown' \
        -o -name 'LICENSE*' -o -name 'license*' -o -name '*.ts' -o -name '*.map' \) -delete 2>/dev/null ; \
    find node_modules -type d \( -name test -o -name tests -o -name __tests__ -o -name __mocks__ \
        -o -name docs -o -name doc -o -name .github -o -name example -o -name examples \) \
        -prune -exec rm -rf {} + 2>/dev/null ; \
    npm cache clean --force

# ---- Stage 2: minimal runtime ----
FROM node:24-alpine3.21 AS runtime

# canvas.node is linked against these at load time, so the .so must exist.
# npm/corepack aren't needed at runtime.
RUN apk add --no-cache cairo pango jpeg giflib librsvg fontconfig \
    && rm -rf /usr/local/lib/node_modules/npm \
              /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx \
    && rm -rf /var/cache/apk/*

ENV NODE_ENV=production
WORKDIR /app

# --chown sets ownership inside the COPY layer, avoiding a duplicated 50MB+ chown layer.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js db.js ./
COPY --chown=node:node public ./public
COPY --chown=node:node fonts ./fonts

RUN mkdir -p public/exports && chown node:node public/exports
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/login.html').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
