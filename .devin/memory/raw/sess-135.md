# Session Capture — 2026-09-20 — sess-135

## Context
- Task: Fully-serverless migration: admin RBAC + role enforcement + bios/PBA creds + per-device installer on Cloudflare Worker
- Environment: <not specified>
- Duration: <not specified>

## Decisions Made
- <none recorded>

## Actions Taken
- <none recorded>

## Outcomes
- What worked: <not recorded>
- What failed: <not recorded>
- What was unexpected: <not recorded>

## Learnings
- Worker had no role model (single ADMIN_TOKEN); ported admins[] KV + PBKDF2 + HMAC-signed JWT-shape tokens + requireRole mirroring Express hierarchy
- alerts is fully CLIENT-SIDE (dashboard/src/api/alerts.js) — no server port needed
- Serverless checkin dropped ALL bios/PBA creds → UEFI unlock broken serverless; added bios_passwords KV + groupPbaCredentials, command-ack stores 4 types, checkin returns them
- Per-device installer = self-contained install.ps1 (fresh api_key + config embedded, sc.exe service) — replaces on-the-fly ZIP/NSIS a Worker can't build
- ADMIN_TOKEN kept as break-glass super-admin for bootstrap/recovery

## Mistakes / Corrections
- <none recorded>

## Open Questions
- <none recorded>

## File References
- serverless/worker.ts
- serverless/worker.test.ts

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
