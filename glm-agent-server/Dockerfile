FROM node:18-alpine

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev

COPY . .

RUN chmod +x docker-entrypoint.sh \
    && mkdir -p logs \
    && chown node:node logs

USER node

EXPOSE 8000

ENTRYPOINT ["/app/docker-entrypoint.sh"]
