# --- Stage 1: build the React client ---
FROM node:22-slim AS client-build
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# --- Stage 2: runtime (server serves the built client) ---
FROM node:22-slim
WORKDIR /app/server
# python3 is a compile fallback for better-sqlite3, and also runs the Fee
# Register Parser tool (tools/amazon_invoice_parser.py) via a child process —
# which needs pdfplumber + openpyxl.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip make g++ \
    && pip3 install --no-cache-dir --break-system-packages pdfplumber openpyxl \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci --omit=dev
COPY server/ ./
# The Fee Parser tool script lives at the repo root's tools/ (resolved as
# /app/tools by the route).
COPY tools/ /app/tools/
# The server serves client/dist from ../../client/dist (relative to server/src).
COPY --from=client-build /app/client/dist /app/client/dist

ENV NODE_ENV=production
# Persist the SQLite DB + uploads here — mount a volume at /data in production.
ENV DATA_DIR=/data
EXPOSE 3001
CMD ["node", "src/index.js"]
