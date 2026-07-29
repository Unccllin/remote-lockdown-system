# Load Testing

This document describes how to load test the remote-lockdown-system server using
[k6](https://k6.io). Load tests verify that the server can handle a fleet of
1000+ devices polling every 30 seconds (~33 req/s baseline) and survive spikes
when a lockdown command is dispatched to the entire fleet simultaneously.

> **Load tests are NOT run in CI.** They are too slow and resource-intensive for
> a CI pipeline. Run them manually against a dedicated test/staging server, or
> in a nightly job on isolated infrastructure. See
> [CI Integration Notes](#ci-integration-notes).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Installing k6](#installing-k6)
- [Test Scenarios](#test-scenarios)
- [Running Tests](#running-tests)
- [Interpreting Results](#interpreting-results)
- [Performance Baselines](#performance-baselines)
- [Tuning Recommendations](#tuning-recommendations)
- [CI Integration Notes](#ci-integration-notes)

## Prerequisites

1. **A running server** — Start the server (or point to a staging instance).
   The default target is `http://localhost:3001`.

   ```bash
   cd server
   npm start
   ```

2. **Test data** — The k6 scripts generate per-VU device identities
   (`hostname`, `mac_address`, `hardware_uuid`). For the server to accept
   checkins, matching devices must be registered in the database. Either:
   - Provision devices via the admin API before the test, or
   - Set `AGENT_SHARED_KEY` on the server and use the legacy shared-key fallback
     (the scripts send `x-agent-key: $K6_AGENT_KEY`).

3. **Pending commands (lockdown scenario only)** — For
   `k6-lockdown-spike.js`, each test device must have a pending `lockdown`
   command queued so the checkin returns a command for the agent to ACK. Use the
   admin API to enqueue lockdown commands for the test devices before running
   the spike test.

4. **Disable rate limiting for load tests** — The server uses
   `express-rate-limit`. Under 1000 VUs it may throttle legitimate test
   traffic. Raise the limits (or disable rate limiting) on the test server via
   the appropriate environment variables, or whitelist the test client IP.

5. **HMAC** — The scripts do not sign requests with HMAC. Ensure the server is
   running with `REQUIRE_HMAC=false` (the default) so unsigned requests are
   accepted during the transition period. Load testing with HMAC enabled is a
   future enhancement.

## Installing k6

### Linux (Debian/Ubuntu)

```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A36442D57D35B459D764BB1C0
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

### macOS (Homebrew)

```bash
brew install k6
```

### Windows (Chocolatey)

```powershell
choco install k6
```

### Windows (Scoop)

```powershell
scoop install k6
```

### Docker (no local install)

```bash
docker run --rm -i grafana/k6 run - < tests/load/k6-baseline.js
```

To pass environment variables through Docker:

```bash
docker run --rm -i \
  -e K6_VUS=500 -e K6_DURATION=2m -e K6_BASE_URL=http://host.docker.internal:3001 \
  grafana/k6 run - < tests/load/k6-baseline.js
```

Verify the installation:

```bash
k6 version
```

## Test Scenarios

| Scenario | Script | VUs | Duration | Description |
|----------|--------|-----|----------|-------------|
| Baseline | `tests/load/k6-baseline.js` | 1000 | 2m | Sustained agent polling every 30s |
| Lockdown spike | `tests/load/k6-lockdown-spike.js` | 1000 | 1m | All VUs poll + ACK a lockdown command |
| Mixed | `tests/load/k6-mixed.js` | 500 | 3m | 90% polling, 5% admin, 5% ACKs |

### Baseline — `k6-baseline.js`

Simulates the steady-state fleet polling load. Each VU is a single device that
POSTs to `/api/agent/checkin` and sleeps for the poll interval (default 30s).

- **VUs:** 1000 (configurable via `K6_VUS`)
- **Duration:** 2m (configurable via `K6_DURATION`)
- **Poll interval:** 30s (configurable via `K6_POLL_INTERVAL`)
- **Thresholds:** p95 < 500ms, p99 < 1000ms, error rate < 1%

### Lockdown Spike — `k6-lockdown-spike.js`

Simulates a lockdown burst: all VUs poll at once, each receives a pending
lockdown command, and each immediately ACKs it. Measures server response time
under a spike of simultaneous checkin + ACK work.

- **VUs:** 1000 (configurable via `K6_VUS`)
- **Duration:** 1m (configurable via `K6_DURATION`)
- **Thresholds:** p95 < 1000ms, p99 < 2000ms, error rate < 2%
- **Requires:** pending lockdown commands queued for each test device.

### Mixed — `k6-mixed.js`

Realistic traffic mix using k6 scenarios with weighted exec functions:

- 90% agent polling (checkin every 30s)
- 5% admin dashboard requests (`GET /api/devices`, `GET /api/audit`)
- 5% agent command ACKs (`POST /api/agent/command-ack`)

- **VUs:** 500 (configurable via `K6_VUS`)
- **Duration:** 3m (configurable via `K6_DURATION`)
- **Thresholds:** p95 < 800ms, error rate < 2%
- **Requires:** `K6_ADMIN_TOKEN` set to a valid admin bearer token for the
  dashboard endpoints.

## Running Tests

### Using the runner script

`scripts/run-load-test.sh` wraps the k6 invocation, checks that k6 is installed,
and reports pass/fail per scenario.

```bash
# Run the baseline scenario with defaults
scripts/run-load-test.sh --scenario baseline

# Run the lockdown spike with custom VUs/duration
scripts/run-load-test.sh --scenario lockdown --vus 2000 --duration 30s

# Run the mixed scenario against a staging server
scripts/run-load-test.sh --scenario mixed \
  --url https://staging.example.com \
  --agent-key my-shared-key \
  --admin-token my-admin-jwt

# Run all scenarios sequentially
scripts/run-load-test.sh --scenario all
```

**Options:**

| Option | Description | Default |
|--------|-------------|---------|
| `--scenario` | `baseline`, `lockdown`, `mixed`, or `all` | `baseline` |
| `--url` | Target server URL | `http://localhost:3001` |
| `--vus` | Override VU count (sets `K6_VUS`) | script default |
| `--duration` | Override duration (sets `K6_DURATION`) | script default |
| `--agent-key` | Agent API key (sets `K6_AGENT_KEY`) | `test-agent-key` |
| `--admin-token` | Admin bearer token (sets `K6_ADMIN_TOKEN`) | `test-admin-token` |

### Running k6 directly

```bash
# Baseline
K6_VUS=1000 K6_DURATION=2m K6_BASE_URL=http://localhost:3001 \
  k6 run tests/load/k6-baseline.js

# Lockdown spike
K6_VUS=1000 K6_DURATION=1m k6 run tests/load/k6-lockdown-spike.js

# Mixed
K6_VUS=500 K6_DURATION=3m K6_ADMIN_TOKEN=xxx k6 run tests/load/k6-mixed.js
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `K6_VUS` | scenario-specific | Number of virtual users |
| `K6_DURATION` | scenario-specific | Test duration (e.g. `2m`, `30s`) |
| `K6_BASE_URL` | `http://localhost:3001` | Target server base URL |
| `K6_AGENT_KEY` | `test-agent-key` | Agent API key (`x-agent-key` header) |
| `K6_ADMIN_TOKEN` | `test-admin-token` | Admin bearer token for dashboard endpoints |
| `K6_POLL_INTERVAL` | `30` | Seconds between checkins per VU |

## Interpreting Results

k6 prints a summary table at the end of each run. The key metrics:

| Metric | Meaning | Target |
|--------|---------|--------|
| `http_req_duration` p95 | 95% of requests completed within this time | < 500ms (baseline), < 800ms (mixed), < 1000ms (spike) |
| `http_req_duration` p99 | 99% of requests completed within this time | < 1000ms (baseline), < 2000ms (spike) |
| `http_req_failed` rate | Fraction of non-2xx responses | < 1% (baseline), < 2% (spike/mixed) |
| `http_reqs` count / rate | Total requests and requests/sec | ~33 req/s for 1000 VUs @ 30s poll |
| `iterations` | Number of completed VU iterations | — |
| `vus` / `vus_max` | Active and peak virtual users | — |

### Thresholds

Each script declares `thresholds`. If any threshold is breached, k6 exits with a
non-zero status and the runner script reports `FAIL`. A passing run means all
thresholds were satisfied.

### Throughput

For the baseline scenario with 1000 VUs and a 30s poll interval, the expected
throughput is approximately:

```
1000 VUs / 30s = ~33 req/s
```

If observed throughput is significantly lower, the server may be the bottleneck
(slow DB queries, connection pool exhaustion, rate limiting).

### Error Rate

An elevated error rate usually indicates one of:

- **429 Too Many Requests** — rate limiting is throttling test traffic. Raise
  limits or whitelist the test client.
- **401 Unauthorized** — the agent key is wrong, or the device is not
  registered.
- **500 Internal Server Error** — server crash, DB connection exhaustion, or
  unhandled exception. Check server logs.
- **503 Service Unavailable** — the server is overloaded and refusing
  connections.

## Performance Baselines

These are the expected performance characteristics for a single server instance
with reasonable hardware (4 vCPU, 8 GB RAM) and a local PostgreSQL database.
Your numbers will vary with hardware, network, and database size.

| Scenario | VUs | Expected req/s | p95 target | p99 target | Error rate |
|----------|-----|----------------|------------|------------|------------|
| Baseline | 1000 | ~33 | < 500ms | < 1000ms | < 1% |
| Lockdown spike | 1000 | burst | < 1000ms | < 2000ms | < 2% |
| Mixed | 500 | ~15–20 | < 800ms | — | < 2% |

If the server fails to meet these baselines, see
[Tuning Recommendations](#tuning-recommendations).

## Tuning Recommendations

If load tests reveal bottlenecks, consider the following tuning steps.

### Database Connection Pool

The server uses `pg` with a connection pool. Under 1000 VUs, the default pool
size (often 10) is insufficient. Increase it:

```env
# server/.env
PG_POOL_MAX=50
PG_POOL_MIN=10
```

Monitor pool usage — if connections are exhausted, requests queue and latency
spikes. A rough guideline is `pool_max ≈ 2 * CPU_cores` for OLTP workloads, but
load testing will reveal the right number for your hardware.

### Rate Limiting

`express-rate-limit` can throttle legitimate test traffic. For load tests:

- Raise `windowMs` / `max` limits, or
- Whitelist the test client IP via `skip` / `trustProxy`, or
- Disable rate limiting entirely on the test server.

In production, keep rate limiting enabled but tune it to allow the expected
fleet polling rate with headroom for spikes.

### Database Indexes

The checkin endpoint runs several queries per request. Ensure these indexes
exist (they should from migrations):

- `devices(api_key_hash)` — per-device key lookup
- `commands(device_id, status)` — pending command fetch
- `commands(command_uuid)` — idempotent ACK dedup
- `encryption_keys(device_id, command_id)` — key lookup for unlock

Run `EXPLAIN ANALYZE` on slow queries identified during load testing.

### Horizontal Scaling

A single server instance handles the baseline (~33 req/s) comfortably. For
larger fleets or higher availability:

- Run multiple server instances behind a load balancer.
- Use `USE_DB_NONCE_CACHE=true` for HMAC replay protection across instances
  (the in-memory nonce cache is per-process).
- Ensure the database can handle the aggregate connection count
  (`pool_max * instance_count`).
- Consider a read replica for admin dashboard queries (`GET /api/devices`,
  `GET /api/audit`) which are read-heavy.

### Node.js Runtime

- Run the server with `NODE_ENV=production`.
- Increase the UV thread pool if crypto-heavy workloads are CPU-bound:
  `UV_THREADPOOL_SIZE=16`.
- Use cluster mode or a process manager (PM2, systemd with multiple workers)
  to use all CPU cores.

### Agent Poll Interval

The adaptive polling returned by the server already reduces the poll interval
for `active` devices to 300s (5 min). If the fleet is mostly idle, the steady-
state load is far below the 30s worst case. Tune `ADAPTIVE_POLL` values in
`server/src/routes/agent.js` if needed.

## CI Integration Notes

**Load tests are not recommended for CI pipelines** because:

1. **Duration** — Even the shortest scenario runs for 1+ minute; a full suite
   is 6+ minutes. This slows every PR build.
2. **Resource contention** — 1000 VUs consume significant CPU and memory on
   the CI runner, producing noisy, unreliable results and interfering with
   other jobs on shared runners.
3. **External dependencies** — Load tests need a running server + database with
   seeded test data, which is expensive to provision per CI run.
4. **Flakiness** — Latency thresholds are inherently environment-sensitive; CI
   runners have variable performance, leading to false failures.

### Recommended approach

- **Run manually** before releases or after significant server changes, using
  `scripts/run-load-test.sh` against a dedicated test/staging server.
- **Optional nightly job** — If desired, run the baseline scenario in a
  scheduled nightly job on isolated infrastructure (not the PR CI pipeline)
  and publish results to a dashboard. Alert on threshold regressions.
- **Keep functional tests in CI** — Unit and integration tests (fast,
  deterministic) belong in CI. Load tests are a separate, manual concern.

### If you must run in CI

Run only the smallest meaningful configuration (e.g. `K6_VUS=50
K6_DURATION=30s`) as a smoke test, on a dedicated runner with fixed resources,
and treat threshold failures as warnings rather than hard gates.
