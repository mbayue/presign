FROM oven/bun:1.4-slim

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

# Guild settings are stored in data/settings.sqlite; mount a volume here.
RUN mkdir -p data && chown bun:bun data
VOLUME ["/app/data"]

USER bun
CMD ["bun", "src/index.ts"]
