# Skill Domain: Phase 15 — Load Testing

## Context
The system needs to handle fleets of 1000+ devices polling every 30s. That's ~33 requests/second baseline, with spikes during lockdown (all devices get commands simultaneously). No load testing has been done.

## Current State
- No load testing infrastructure
- Server uses express-rate-limit (could throttle under load)
- Agent polls every 30s by default
- No performance benchmarks

## Research Findings
### Load Testing Tool
- **k6** (Go-based, YAML/JS scripts, good for HTTP APIs) — recommended
- **artillery** (Node-based, YAML config) — alternative
- **locust** (Python-based) — alternative
- Decision: k6. It's purpose-built for HTTP load testing, has good metrics, and integrates with CI.

### Key Scenarios to Test
1. **Baseline polling**: 1000 virtual users (VUs), each polling every 30s
   - ~33 req/s sustained
   - Measure: latency, error rate, CPU, memory
   - Duration: 5 minutes

2. **Lockdown spike**: 1000 VUs all receive lockdown command simultaneously
   - All agents poll at once → all get lockdown command → all ACK
   - Measure: server response time under spike

3. **Mixed load**: 90% polling, 5% admin dashboard, 5% agent ACKs
   - Realistic traffic mix

4. **Ramp-up**: gradually increase from 100 to 2000 VUs
   - Find breaking point
   - Identify bottlenecks

### Metrics to Collect
- http_req_duration (p95, p99)
- http_req_failed (error rate)
- vus (active virtual users)
- iterations_per_second (throughput)
- Server-side: CPU, memory, DB connection pool usage

### k6 Script Structure
```javascript
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 100 },   // ramp up
    { duration: '2m', target: 100 },     // hold
    { duration: '30s', target: 0 },      // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.01'],
  },
};
```

## Reasoning Questions
1. **Should load tests run in CI?**
   - Answer: No. Load tests are too slow and resource-intensive for CI. Run manually or in a dedicated nightly job. Document how to run locally.

2. **Should tests require a running server?**
   - Answer: Yes. Load tests need a real server. Script should start a test server if one isn't running, or accept `--url` to point to an existing server.

3. **Should we test with real agent processes?**
   - Answer: No. 1000 Python processes would overwhelm the test machine. Use k6 virtual users to simulate agent HTTP calls.

## Implementation Guidelines
### tests/load/k6-baseline.js
- 1000 VUs polling every 30s
- Each VU: authenticate as agent → checkin → sleep 30s
- Thresholds: p95 < 500ms, error rate < 1%

### tests/load/k6-lockdown-spike.js
- 1000 VUs all polling simultaneously
- All receive lockdown command → all ACK
- Measures server under spike load

### tests/load/k6-mixed.js
- 90% agent polling, 5% admin dashboard, 5% ACKs
- Realistic traffic mix

### scripts/run-load-test.sh
- `--scenario <baseline|lockdown|mixed|all>` — which test
- `--url <server-url>` — target server (default: http://localhost:3001)
- `--vus <count>` — override VU count
- `--duration <time>` — override duration
- Checks k6 is installed, runs test, reports results
- Make executable

### docs/LOAD_TESTING.md
- How to install k6
- How to run each scenario
- How to interpret results
- Performance benchmarks/baselines
- Tuning recommendations

## File Boundaries
- CREATE: `tests/load/k6-baseline.js`, `tests/load/k6-lockdown-spike.js`, `tests/load/k6-mixed.js`, `scripts/run-load-test.sh`, `docs/LOAD_TESTING.md`
- DO NOT EDIT: existing source code, server config, tests
