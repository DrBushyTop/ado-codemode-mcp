FROM node:22-alpine

RUN addgroup -g 65532 sandbox \
  && adduser -D -u 65532 -G sandbox sandbox

WORKDIR /app
COPY entrypoint.mjs /app/entrypoint.mjs

USER 65532:65532

ENTRYPOINT ["node", "/app/entrypoint.mjs"]
