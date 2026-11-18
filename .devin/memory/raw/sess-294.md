# Session Capture — 2026-11-18 — sess-294

## Context
- Task: S291: rebuild the generic NSIS installer without root, and find out whether it can be published
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
- makensis installs without root by unpacking two Ubuntu debs: nsis_3.12-1_amd64.deb AND nsis-common_3.12-1_all.deb (ar x + tar -xf, NSISDIR=<root>/usr/share/nsis). Without nsis-common, makensis dies on 'reading stub .../Stubs/zlib-x86-unicode'.
- scripts/build-generic-installer.sh accepts an unpacked NSIS via ~/.local/nsis or NSISDIR, and requires --server-url unless agent/installer.py has a default; lockdown-installer.nsi pins the Worker URL as its own default.
- The wrapper embeds agent + CLI installer (mandatory) and lockscreen (optional): 32.6 MB minimum, 41.2 MB with lockscreen.
- Cloudflare KV rejects >27 MiB with code 10024, so binary:installer cannot be refreshed at current payload sizes; it needs R2, a merged binary, or another host.

## Mistakes / Corrections
- mistake: passed --stage and --out as the same directory, so the build's mv replaced the staged CLI installer with the wrapper; correction: use separate stage/out dirs.

## Open Questions
- <none recorded>

## File References
- docs/artifacts/s291-installer-exceeds-kv.txt
- scripts/build-generic-installer.sh
- installer/generic/lockdown-installer.nsi
- .github/workflows/ci.yml

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
