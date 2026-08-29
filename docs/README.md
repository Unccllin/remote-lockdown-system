# Project Documentation Index

This is the central index for all documentation in the Remote Lockdown System.
Every document is listed below with a one-line description and a relative link.

---

## Architecture

| File | Description |
|------|-------------|
| [ARCHITECTURE-V2.md](ARCHITECTURE-V2.md) | Firmware-persistent anti-theft system architecture (V2), synthesized from primary UEFI/bootkit sources. |
| [SECURITY.md](SECURITY.md) | Security architecture and threat model — assets, threats, and mitigations. |
| [RBAC_ACCESS_MATRIX.md](RBAC_ACCESS_MATRIX.md) | Role-based access control matrix mapping admin roles (viewer, operator, super-admin) to API endpoints and dashboard features. |
| [FLEETGUARD-DASHBOARD-PLAN.md](FLEETGUARD-DASHBOARD-PLAN.md) | Frontend-only dashboard improvement plan derived from the FleetGuard design reference. |
| [API.md](API.md) | Full REST API reference — every endpoint, auth requirements, request/response shapes, and rate limiting. |
| [openapi.yaml](openapi.yaml) | OpenAPI 3.0 specification covering all API endpoints with request/response schemas. |

## ADRs (Architecture Decision Records)

| File | Description |
|------|-------------|
| [adr/GRAPH-SPEC.md](adr/GRAPH-SPEC.md) | ADR for the node graph architecture — the center and heart of the project's phase/enforcement tracking. |
| [adr/DEBT-LEDGER.md](adr/DEBT-LEDGER.md) | Single source of truth for production-readiness debt items, close criteria, and status. |
| [adr/archive/REFACTOR-LOG.md](adr/archive/REFACTOR-LOG.md) | Archived refactor log listing every refactor needed to make the node graph the project center. |

## Deployment

| File | Description |
|------|-------------|
| [DEPLOYMENT.md](DEPLOYMENT.md) | Production deployment guide using Docker Compose — step-by-step from build to running stack. |
| [CODE_SIGNING.md](CODE_SIGNING.md) | Code signing guide for Windows (SmartScreen) and macOS (Gatekeeper) production distribution. |
| [BACKUP.md](BACKUP.md) | Backup and restore procedures for the database (encryption keys, device data, audit logs). |

## Testing

| File | Description |
|------|-------------|
| [E2E_TEST.md](E2E_TEST.md) | End-to-end test guide — full flow from admin install to device lockdown and recovery. |
| [LOAD_TESTING.md](LOAD_TESTING.md) | Load testing guide using k6 — verifies 1000+ device fleet polling at ~33 req/s. |
| [HARDWARE-TEST-CAPSULE.md](HARDWARE-TEST-CAPSULE.md) | Hardware test instructions for UEFI capsule updates on real target hardware. |

## Operations

| File | Description |
|------|-------------|
| [DR_RUNBOOK.md](DR_RUNBOOK.md) | Disaster recovery runbook — concrete recovery procedures for likely production failure scenarios. |
| [PBA_RECOVERY_RUNBOOK.md](PBA_RECOVERY_RUNBOOK.md) | Step-by-step runbook for recovering a device with Pre-Boot Authentication (PBA) active after a reboot. |
| [AUDIT_KB.md](AUDIT_KB.md) | System audit knowledge base and remediation plan — every finding verified by running actual test suites. |

## Research

| File | Description |
|------|-------------|
| [RESEARCH-HP-HARDWARE.md](RESEARCH-HP-HARDWARE.md) | Research on HP hardware — BIOS setting names and Sure Admin/Start/Run awareness. |
| [RESEARCH-TPM-KEY-STORAGE.md](RESEARCH-TPM-KEY-STORAGE.md) | TPM 2.0 key storage prototype — verified using swtpm + tpm2-tools on Linux. |
| [RESEARCH-UEFI-STUDY-NOTES.md](RESEARCH-UEFI-STUDY-NOTES.md) | Refined UEFI study notes (spec 2.11) cross-referenced with project enforcement paths. |
| [RESEARCH-UEFI-VARS-TPM.md](RESEARCH-UEFI-VARS-TPM.md) | Research on Windows UEFI variable access and TPM key sealing for the anti-theft system. |

## Legal & Compliance

| File | Description |
|------|-------------|
| [GDPR_LIA.md](GDPR_LIA.md) | GDPR Legitimate Interest Assessment (LIA-2026-001) for data processing activities. |
| [PRIVACY_POLICY.md](PRIVACY_POLICY.md) | Privacy policy describing data collection, usage, and retention practices. |
| [TERMS_OF_SERVICE.md](TERMS_OF_SERVICE.md) | Terms of Service governing use of the Remote Lockdown System. |

## Wayfinder (Process Hardening)

| File | Description |
|------|-------------|
| [wayfinder/harness-engineering-map.md](wayfinder/harness-engineering-map.md) | Wayfinder map for harness engineering hardening — tracking process improvements. |
| [wayfinder/tickets/Q1-goodhart-law-defense.md](wayfinder/tickets/Q1-goodhart-law-defense.md) | Ticket: Goodhart's Law defense — preventing metric gaming in the verification harness. |
| [wayfinder/tickets/T1-archive-and-trace-restructure.md](wayfinder/tickets/T1-archive-and-trace-restructure.md) | Ticket: Archive and trace restructure for compact session history. |
| [wayfinder/tickets/T2-process-hardening.md](wayfinder/tickets/T2-process-hardening.md) | Ticket: Process hardening improvements for the agent development workflow. |
| [wayfinder/tickets/T3-error-messages-fix-instructions.md](wayfinder/tickets/T3-error-messages-fix-instructions.md) | Ticket: Error message fix instructions for actionable user-facing errors. |
| [wayfinder/archive/README.md](wayfinder/archive/README.md) | README for the wayfinder archive directory. |
| [wayfinder/archive/pba-hardening-map.md](wayfinder/archive/pba-hardening-map.md) | Archived wayfinder map for PBA hardening. |
