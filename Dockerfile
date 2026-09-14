FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json package-lock.json server.mjs ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --chown=node:node lib ./lib
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node public ./public
RUN mkdir /app/data && chown node:node /app/data
USER node
ENV HOST=0.0.0.0 PORT=3010 DATA_DIR=/app/data
EXPOSE 3010
CMD ["node", "server.mjs"]
