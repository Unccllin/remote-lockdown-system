# Session Capture — 2026-11-26 — sess-332

## Context
- Task: Rewrite TPM state sealing to address the key by certificate, verify it on MOLE after a reboot, then build, sign and publish release 1.0.5 and prove a device self-updates onto it
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
- TPM sealing works when the key is addressed by a certificate: New-SelfSignedCertificate -Provider 'Microsoft Platform Crypto Provider' creates a key whose export is REFUSED (TPM-resident), where CngKey.Create returns 'The requested operation is not supported'; both OAEP-SHA256 and PKCS#1 round-trip, so OAEP is used
- Deleting the certificate does NOT delete the persisted CNG key (te-<guid>): the two die independently and uninstall must remove both; the old [CngKey]::Delete('name') static overload does not exist on .NET Framework, so delete_tpm_key() had never deleted anything
- MOLE has Python 3.14.8 at C:\Python314\python.exe plus tkinter, so it is a build AND test host, not just a test host — the older 'MOLE has no Python' note is stale
- agent/build.ps1 stamps _buildinfo.py (build=20261126.69a3e4156d16); scripts/build-windows-artifacts.ps1 does not and yields build=unknown.unknown, which loses the build identity S286 requires for a published release
- MOLE runs lockdown-service.exe --service (the supervisor), so a published release auto-applies: it verified the ed25519 signature, swapped the binary and restarted on its own
- The Worker's module-level mutationChain (worker.ts:365) has no timeout: one stalled check-in handler wedges checkin AND command-ack for the isolate, and only a redeploy clears it (D-225)

## Mistakes / Corrections
- mistake: appended the D-225 entry to the end of GRAPH-SPEC.yaml, which sits after 'invariants:', so it parsed as an invariant and debt_items stayed at 64 while a text grep counted 65; correction: after editing that file, yaml.safe_load it and assert the item count, never trust a text count
- mistake: 'probed' the embedded version by decoding raw bytes of lockdown-agent.exe and read 0 occurrences of both 1.0.4 and 1.0.5; PyInstaller compresses the payload so the probe was meaningless; correction: run the binary with --version
- mistake: reported the first build as done although it carried build=unknown.unknown; correction: a published build must come through build.ps1 so two binaries cannot share an identity

## Open Questions
- <none recorded>

## File References
- agent/tpm_seal.py
- agent/tests/test_tpm_seal.py
- agent/agent.py
- docs/artifacts/s357-tpm-cert-seal.txt
- docs/artifacts/s357-release-1.0.5.txt
- docs/adr/PBL-DEBT-LEDGER.md
- .devin/graph/GRAPH-SPEC.yaml
- .gitignore

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
