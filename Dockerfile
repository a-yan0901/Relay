FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data

RUN groupadd --system webssh && useradd --system --gid webssh --home-dir /app --no-create-home webssh
WORKDIR /app

COPY --from=build /app/dist ./dist
COPY --from=production-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./

RUN mkdir -p /data && chown -R webssh:webssh /app /data
USER webssh

VOLUME ["/data"]
EXPOSE 3000
CMD ["node", "dist/server/index.js"]
