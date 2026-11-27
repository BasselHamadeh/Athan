# Athan-Server (Web-App + Push) – keine npm-Abhängigkeiten
FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY web ./web
COPY server ./server
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "server/server.mjs"]
