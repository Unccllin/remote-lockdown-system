# FA6: Dockerfile for the Remote Device Lockdown Server.
# Scoped as dev/test infrastructure — NOT the production deploy path yet.
#
# Usage:
#   docker build -t lockdown-server .
#   docker run -p 3001:3001 --env-file .env lockdown-server
#
# Secret handling (CC12): Use the _FILE convention for secrets.
# Instead of passing FIELD_ENCRYPTION_KEY via ENV (visible in docker inspect),
# mount a secrets file and set FIELD_ENCRYPTION_KEY_FILE=/run/secrets/field_key.
# This is compatible with Docker secrets, Kubernetes secrets, and KMS bridges.
#
# Example docker-compose with secrets:
#   see docker-compose.yml

FROM node:20-slim

WORKDIR /app

# Copy package files and install dependencies.
# sqlite3's prebuilt binary is linked against a newer glibc than node:20-slim
# (Debian bookworm, glibc 2.36) provides, so the container died on startup with
#   Error: /lib/x86_64-linux-gnu/libm.so.6: version `GLIBC_2.38' not found
# Building it from source avoids depending on the publisher's build host; the
# toolchain is removed in the same layer so it does not ship.
COPY package.json package-lock.json ./
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && npm ci --omit=dev --build-from-source=sqlite3 \
 && apt-get purge -y python3 make g++ \
 && apt-get autoremove -y \
 && rm -rf /var/lib/apt/lists/*

# Copy source code
COPY . .

# Run as a non-root user (CWE-250). node:20-slim ships uid 1000 as `node`.
# /data is the SQLite volume — an empty named volume inherits this ownership on
# first use; a host bind mount must be chowned by the operator.
RUN mkdir -p /data && chown -R node:node /app /data
USER node

# Expose the server port
EXPOSE 3001

# Health check — uses the extended health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>r.json()).then(j=>{if(j.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

# Start the server (not dev-start.js — this is the production-style entrypoint)
CMD ["node", "src/index.js"]
