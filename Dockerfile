# There is no build step — the front end is a single hand-written HTML file —
# so this is a plain runtime image rather than a multi-stage build.
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Dependencies first: this layer is cached until package-lock.json changes, so
# a typical push that only touches server.js or index.html skips the install.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Matches internal_port in fly.toml. The server reads PORT from the env.
EXPOSE 8080

CMD ["node", "server.js"]
