# Frontend (React + Vite) — build to static assets, serve with nginx.
#
# VITE_* values are baked in at BUILD time (they end up in the JS bundle), so
# they're passed as build args, not runtime env. All are PUBLIC by design
# (publishable Clerk key, backend URL) — never put a secret here.
#
#   docker build \
#     --build-arg VITE_API_URL=https://api.example.com \
#     --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_live_... \
#     -t focusflow-frontend epic-dev-assignment/frontend

# ── build stage ──────────────────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

ARG VITE_API_URL=""
ARG VITE_SOCKET_URL=""
ARG VITE_CLERK_PUBLISHABLE_KEY=""
ENV VITE_API_URL=$VITE_API_URL \
    VITE_SOCKET_URL=$VITE_SOCKET_URL \
    VITE_CLERK_PUBLISHABLE_KEY=$VITE_CLERK_PUBLISHABLE_KEY

COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

# ── serve stage ──────────────────────────────────────────────────────────────
FROM nginx:alpine AS serve
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
