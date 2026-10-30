# Session Capture — 2026-10-30 — sess-155

## Context
- Task: Build the on-wire verdict-request harness for D-200: capture a PBL POST whose device_id matches the AK-Name-derived value
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
- PBL needs exactly this to post: policy.cose on \EFI\PBL with key 70 = https:// URI and key 73 = SHA-256 of a leaf cert whose CN equals the URI host. No verdict-signing keys (71/76/77) are needed to capture the request; the dev build has no policy root of trust so PblVerifyPolicySignature returns EFI_UNSUPPORTED and accepts the blob.
- PblTlsVerifyCert compares the CN against the host parsed from the URI and ignores SAN. A SAN-only cert fails the pin check for reasons unrelated to the pin.
- PBL rejects http:// with EFI_INVALID_PARAMETER, so any working verdict harness must terminate TLS; the existing test-d205 mock serves plain http on 8080 and therefore cannot drive a real fetch.
- Result so far: 3 of 6 checks pass (policy loaded, device_id derived, POST attempted). DHCP succeeds; EC and RSA certs fail identically; binding 127.0.0.1 or 0.0.0.0 both receive nothing. The abort is EFI_ABORTED inside the OVMF HTTP/TLS stack before any TCP connection.
- A provisioner container running as root and a harness container running unprivileged is a real defect: swtpm then reports 'Could not lock access to lockfile', which looks like a leftover process but is a permissions problem. chmod a+rwX the state when handing it over.

## Mistakes / Corrections
- Spent two iterations guessing (ECDSA then RSA; loopback then wildcard bind) where one -object filter-dump pcap would have split the hypothesis space in a single run. Instrument to discriminate instead of enumerating causes one at a time.
- Announced 'this is my last iteration on this path' and then ran two more; if the exit condition is 'one run to instrument', say that rather than setting an iteration budget I then exceed.
- Forgot chmod +x on a new script and read EXIT=126 as a mysterious failure until checking permissions.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/test-d131-wire-harness.sh
- firmware/PblPkg/d131-wire-capture.py
- scripts/provision-qemu-tpm.sh
- firmware/PblPkg/artifacts/d200-wire-attempt-serial.log
- firmware/PblPkg/artifacts/d200-wire-attempt-results.txt
- docs/adr/PBL-DEBT-LEDGER.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
