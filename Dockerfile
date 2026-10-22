# syntax=docker/dockerfile:1
FROM node:22-alpine

# Container defaults: a publishable bind (port mapping needs it) and a stable
# HOME so the config/token dir path is deterministic regardless of the base
# image's user entry.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3010 \
    HOME=/home/node

WORKDIR /app

# Dependencies as their own layer: cached across code-only changes.
# hls.js and qrcode are runtime deps (served at /vendor/hls.js, QR login).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server/ server/
COPY web/ web/

# Config/token dir — compose bind-mounts the host's ~/.config/twitch-webui
# here so container and native install share tokens and settings.
RUN mkdir -p /home/node/.config/twitch-webui \
 && chown -R node:node /home/node/.config /app

USER node

EXPOSE 3010

# Healthcheck per README (GET /api/auth/status). Any status < 500 proves the
# server is up: without ACCESS_PIN it answers 200; with a PIN it answers 401,
# which still means healthy (the PIN gate itself is the app working).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3010)+'/api/auth/status').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
