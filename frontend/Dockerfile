# syntax=docker/dockerfile:1
#
# Production image for the React SPA.
#   build:   Node compiles the static bundle (tsc + vite build)
#   runtime: unprivileged nginx serves it on :8080 (Caddy terminates TLS
#            in front of it; see deploy/Caddyfile)
#
# For live-edit development use docker-compose.dev.yml (Vite dev server).
ARG NODE_IMAGE=node:22.18.0-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.0-alpine

# ------------------------------------------------------------------ build
FROM ${NODE_IMAGE} AS build
WORKDIR /app

# Relative by default: the API lives on the same origin behind Caddy, which
# the refresh cookie (SameSite=Strict + CSRF double-submit) relies on.
ARG VITE_API_URL=/api
ENV VITE_API_URL=${VITE_API_URL} \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY . .
RUN npm run build

# ---------------------------------------------------------------- runtime
FROM ${NGINX_IMAGE} AS runtime

# Replace the stock server block; the image already runs as uid 101 and
# listens on an unprivileged port.
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
