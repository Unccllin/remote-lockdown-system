# Integration Ownership

**Status**: accepted (2026-10-27)
**Decision owner**: project owner
**Related**: `docs/adr/GRAPH-SPEC.md`, `docs/openapi.yaml`, `docs/SECURITY.md`

## Context

We reviewed [MeshCentral](https://github.com/Ylianst/MeshCentral) (Apache-2.0,
7.5k stars) as an adjacent RMM that has already solved device inventory, agent
distribution, remote desktop, file transfer, KVM and Intel AMT out-of-band
control. [MeshCentralDocs](https://github.com/Ylianst/MeshCentralDocs) documents
it well and gives a usable information architecture.

Two facts constrain what we may do with that work:

1. **MeshCentral's *code* is Apache-2.0** — reusable with the licence, a NOTICE,
   and modification markers.
2. **MeshCentralDocs has no licence at all** — default all-rights-reserved. Its
   prose and images are not copyable; only the *structure* of its navigation and
   the ideas it documents are.

There is also a product requirement, stated by the owner: **if we integrate, the
integration must be ours.** Shipping a MeshCentral plugin would put our product
inside someone else's runtime, release cadence and permission model.

Note: this repository currently has **no LICENSE, no NOTICE and no `license`
field in any package.json**. Nothing from an Apache-2.0 project may enter the
tree until that is fixed.

## Decision

**We own the integration contract. MeshCentral is an optional upstream, never a
host.**

Concretely:

1. **Connector, not plugin.** Any MeshCentral interoperability is implemented
   inside *our* server as a connector that consumes MeshCentral's public API.
   We do not ship a MeshCentral plugin, do not fork MeshCentral, and do not put
   MeshCentral code on our request path.
2. **No hard dependency.** The product must remain fully functional with
   MeshCentral absent. The connector is disabled by default and its failure is
   never fatal — a missing or broken upstream degrades a panel, not the service.
3. **Authority never leaves our system.** Inventory and online state may be
   *read* from upstream. Every lockdown, unlock and policy action is issued
   through **our** command queue with **our** audit log; we never proxy a
   destructive action to a third-party API and call it ours.
4. **A MeshCentral-side artifact, if ever needed, is ours.** Thin, optional,
   shipped from this repository, under our licence, with no fork. It is an
   adapter for *their* users, not a home for our logic.
5. **Our own surface comes first.** The connector is documented in
   `docs/openapi.yaml` like any other feature, and supports other RMMs
   (MeshCentral, Tactical RMM, Intune) through the same internal shape rather
   than a vendor-specific code path.
6. **Licensing gate.** Before any Apache-2.0 code is copied: add `LICENSE`,
   `THIRD-PARTY-NOTICES.md`, `license` fields in every package.json, and mark
   modified files. Reuse is limited to self-contained units we can attribute
   (e.g. AMT plumbing), never bulk-vendored trees.

## Consequences

**Positive**

- The integration is ours: our architecture, our roadmap, our audit trail.
- No coupling to MeshCentral's plugin API churn or release cadence.
- The same connector shape serves several RMMs, so a customer on Intune is not
  a second codebase.
- Their installed base becomes a *distribution* channel for our product, not a
  runtime we live inside.

**Negative**

- More work than dropping a plugin into their ecosystem: we must write and
  maintain the connector, and their API is not a stability contract.
- We forgo plugin-marketplace discoverability in the short term.
- If we later choose a MeshCentral plugin anyway, it must be additive and
  still thin — the decision above stays in force for the core.

## Non-goals

Explicitly **not** building, because MeshCentral already has them and they are
not our differentiator: remote desktop, file transfer, KVM, mesh routing / NAT
traversal, and general-purpose RMM policy.

Our differentiator is what theirs structurally cannot do: **persistence that
survives OS reinstall and disk swap** — PBL in firmware, plus BootNext/BCD and
TPM-backed state. Where a MeshCentral agent dies with the OS, ours persists.

## Capitalisation map

What to take from their work, and how:

| Their asset | What we do | Ownership |
|---|---|---|
| `amt/` (Intel AMT out-of-band) | Candidate second enforcement path (`E-AMT`) — reaches machines with the OS down | Reuse under Apache-2.0 **after** the licensing gate; wrapper is ours |
| `translate/` (i18n structure) | Adopt the flat key→JSON-per-language shape for our dashboard | Structure only; our strings |
| `codesigning` / `agent-releases` docs | Cross-check our agent update signing (E-AUTO-UPDATE is unit-test-only) | Ideas; our implementation |
| Docs information architecture | Mirror the sectioning for `make docs-site` | Structure only — **their prose is unlicensed** |
| Installed base | Publish "MeshCentral manages; PBL persists" as our positioning | Ours |

## Open questions

- Which upstream does the connector target first, and is it read-only inventory
  or inventory plus status mirroring?
- Do we want an `E-AMT` enforcement path at all, or is PBL plus BCD/TPM enough
  for the target fleet?
- Licence choice for this repository (needed before any code reuse).
