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

# Copy package files and install dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy source code
COPY . .

# Expose the server port
EXPOSE 3001

# Health check — uses the extended health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3001/api/health').then(r=>r.json()).then(j=>{if(j.status!=='ok')process.exit(1)}).catch(()=>process.exit(1))"

# Start the server (not dev-start.js — this is the production-style entrypoint)
CMD ["node", "src/index.js"]
