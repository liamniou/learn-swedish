FROM node:24.22.1-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    PUBLIC_DIR=/app \
    DATA_DIR=/data

WORKDIR /app
COPY index.html ./
COPY assets ./assets
COPY lessons ./lessons
COPY server ./server

RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1

CMD ["node", "server/server.mjs"]
