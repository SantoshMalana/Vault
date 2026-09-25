FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM dependencies AS build
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-alpine AS dashboard
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM node:22-alpine AS service
WORKDIR /app
COPY --chown=node:node services ./services
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 DATA_DIR=/data
EXPOSE 7400 7401
CMD ["node", "services/storage.mjs"]
