# Session Capture — 2026-10-30 — sess-156

## Context
- Task: Fix D-132: make the policy-pinned CA reach the TLS layer so the verdict request completes and lands on the wire
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
- EDK2's HTTP client hard-codes VerifyMethod = EFI_TLS_VERIFY_PEER (HttpDxe/HttpsSupport.c:660) and validates chains against DER certificates in the platform TlsCaCertificate variable. A SHA-256 pin can never satisfy it, which is why PblTlsVerifyCert had no caller and the handshake was always reset by the client.
- EfiTlsConfigDataTypeCACertificate is not an escape hatch: TlsConfigProtocol applies it to that instance's TlsConn, so an app cannot influence the session HttpDxe creates for itself.
- Working fix: C4 key 78 carries the CA DER; PBL builds an EFI_SIGNATURE_LIST (EFI_CERT_X509_GUID) and SetVariable's it over TlsCaCertificate before each fetch. SetVariable replaces outright, so the store is exactly the policy's CA every boot and a T2 OS admin cannot leave a CA behind.
- EDK2 needs a real CA (keyUsage keyCertSign, BasicConstraints CA:TRUE) plus a leaf it signs with a SAN. A self-signed leaf passes openssl verify locally but is rejected by the firmware.
- Python evaluates the RIGHT-hand side of `out[key] = value` before the subscript, so writing `out[self.read()] = self.read()` consumes the value as the key and shifts every key one element. This bug in the in-image CBOR reader made correct firmware report a false failure for several runs.

## Mistakes / Corrections
- Added EFIAPI to a declaration that never had it (and to my new definition whose declaration lacked it), producing conflicting-types errors. Match the surrounding convention, not the spec's usual shape.
- Spliced the generator with string indices and corrupted the function (dangling def, undefined now); rewriting the whole function was faster and safer than patching the pieces.
- Trusted the harness's own reader for several runs before decoding the captured bytes with cbor2 on the host. Independent decoding is what exposed the evaluation-order bug.

## Open Questions
- <none recorded>

## File References
- firmware/PblPkg/PblApp/TlsVerify.c
- firmware/PblPkg/PblApp/PblApp.c
- firmware/PblPkg/PblApp/PblApp.h
- firmware/PblPkg/PblApp/CborDecode.c
- firmware/PblPkg/PblApp/PblApp.inf
- firmware/PblPkg/d131-wire-capture.py
- firmware/PblPkg/artifacts/d200-wire-verified-results.txt
- firmware/PblPkg/artifacts/d132-mismatched-ca-results.txt
- docs/adr/PBL-C4-Policy-Blob.md

## Optional Fields (applied to consolidated memories)
- evidence_sources: <none>
- impact: <none>
- response: <none>
