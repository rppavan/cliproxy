# Multi-target container image:
#   Server:    docker build -t star-cliproxy:local .
#   Dashboard: docker build -t star-cliproxy-dashboard:local --target dashboard .
# Note: CLI providers rely on host authentication, so they should be disabled in containers.
FROM node:22-alpine AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/dashboard/package.json packages/dashboard/
# node-pty lacks linux/arm64 prebuilds and requires node-gyp compilation.
# Build toolchain is removed after install; libstdc++ is retained for runtime linking.
RUN apk add --no-cache libstdc++ \
 && apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci \
 && apk del .build-deps
COPY tsconfig*.json ./
COPY packages/shared packages/shared
RUN npm run build --workspace=packages/shared

FROM base AS server
COPY packages/server packages/server
# Drop privileges to uid 1000 and grant write access only to SQLite/log paths.
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
USER node
EXPOSE 8300
# busybox wget attempts IPv6 ::1 first for localhost, but the server only binds IPv4 (0.0.0.0).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8300/health || exit 1
CMD ["npx", "tsx", "packages/server/src/index.ts"]

FROM base AS dashboard-build
COPY packages/dashboard packages/dashboard
RUN npm run build --workspace=packages/dashboard

FROM nginx:alpine AS dashboard
COPY --from=dashboard-build /app/packages/dashboard/dist /usr/share/nginx/html
# NGINX_ENVSUBST_FILTER prevents envsubst from replacing nginx variables like $host.
COPY <<'CONF' /etc/nginx/templates/default.conf.template
server {
    listen 80;
    location /admin { proxy_pass ${CLIPROXY_UPSTREAM}; proxy_set_header Host $host; proxy_read_timeout 300s; proxy_send_timeout 300s; }
    location /v1 { proxy_pass ${CLIPROXY_UPSTREAM}; proxy_set_header Host $host; proxy_buffering off; proxy_read_timeout 300s; proxy_send_timeout 300s; }
    location /health { proxy_pass ${CLIPROXY_UPSTREAM}; }
    location / { root /usr/share/nginx/html; try_files $uri /index.html; }
}
CONF
ENV CLIPROXY_UPSTREAM=http://cliproxy:8300
ENV NGINX_ENVSUBST_FILTER=CLIPROXY_UPSTREAM
EXPOSE 80

FROM server

