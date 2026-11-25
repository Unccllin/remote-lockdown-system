# Key Custody and Transfer Schedule — Remote Lockdown System

**Document**: HND-03 · Version 1.0 · 24 November 2026
**Recipient**: [Recipient Legal Name]
**Classification**: Private and Confidential — Commercial in Confidence

**This document contains no credential values.** It records what each key protects, what its loss would
cost, and how it moves. All values travel in a separate sealed channel agreed at Phase 1, deposited and
countersigned under the signature block at section 5.

Severity means: **Critical** — the loss cannot be undone. **High** — recoverable only by re-enrolling
devices or re-validating an identity. **Medium** — an outage or a degraded capability. **Low** — a
functional loss with no security consequence.

---

## 1. Trust roots and data keys — transfer required

These seven must move. Five transfer because they protect data you are receiving; two transfer because
they are already trusted by machines in the field.

| Ref | Key | Protects | Severity | If it is lost | How it moves |
|---|---|---|---|---|---|
| K1 | Per-device key pepper | The hash of every device's own credential | **Critical** | Every device fails authentication and must be re-enrolled in person, one at a time | Sealed, with the database, if the database transfers. Otherwise generated fresh and the fleet re-enrolled |
| K2 | Field encryption key | Sensitive database fields at rest | **Critical** | Encrypted columns are unreadable permanently. No restore helps, because the backup is encrypted under the same failure | Sealed, with the database |
| K3 | Location field key | Location records at rest | **Critical** | All historical location data is unreadable, and because it is personal data, that is a disclosable deletion | Sealed, with the database. Must not be merged into K2 |
| K4 | Backup encryption key | Every backup the server writes | **Critical** | Every existing backup becomes an unreadable blob and the disaster-recovery procedure stops being executable | Sealed, with the backup set, before the first restore drill |
| K5 | Agent update signing key, private half | Authenticity of every agent update | **Critical** | Every deployed device pins the matching public half. Lose it and no device can be updated again; rotate it and every device must be re-enrolled | **Transfers even if the database does not.** Two-person custody |
| K6 | Recovery escrow key pair | Out-of-band unlock of a locked device | **Critical** | A locked device in the field has no software unlock path left | Two-person custody, never stored with K5 |
| K7 | Firmware platform signing keys | Firmware trust for the pre-boot component | **Critical** | Firmware stops trusting the platform; recovery is a manual enrolment visit per machine | With the signing authority decision recorded in document 5 |

### 1.1 The one key that cannot be regenerated into a working state

K5 deserves its own paragraph, because it is the only item in this package where "start fresh" is not
available. Each device pins the update-signing public key at enrolment. A device will refuse an update
signed by anything else. That is the correct behaviour — a channel-supplied hash alone would be
self-certifying — and it means the transfer of K5 is not optional, not deferrable, and not replaceable by
re-enrolment without a physical visit to every machine.

---

## 2. Service and platform credentials — re-issue rather than transfer

These should be re-issued to your entity. Transferring a live credential transfers its history as well.

| Ref | Credential | Protects | Severity | Recommended action |
|---|---|---|---|---|
| K8 | Session signing secret | Administrator session tokens | Medium | Generate fresh; administrators sign in again once |
| K9 | Legacy shared device key | Transitional device authentication | High | Count devices still using it first; if none, retire it rather than move it |
| K10 | Database credentials | Access to the database | High | Rotate after migration, with the host |
| K11 | Windows code-signing identity and certificate profile | Authenticity of Windows binaries | High | Move the subscription, or re-validate identity in your tenant and re-sign. Hashes change either way |
| K12 | Apple developer identity and notarisation credentials | macOS distribution | High | Enrol under your entity; notarisation requires it |
| K13 | Cloud release-download token | Fetching release binaries during installer generation | Medium | Issue a fine-grained, repository-scoped token |
| K14 | Serverless platform account and deployment token | The optional serverless deployment | Medium | Transfer account ownership; re-issue the deployment token |
| K15 | Geolocation service key | Network-based location lookup | Medium | Move the billing project or re-issue and regenerate every installer. Losing it silently degrades precision |
| K16 | Email and chat alerting credentials | Alert delivery | Medium | Create under your domain and workspace; do not transfer posting credentials |
| K17 | Monitoring login | Operational dashboards | Low | Reset on first login; the shipped default is a known default |
| K18 | Inventory integration credentials — directory service | Optional read-only device inventory | Low | Your tenant grants its own consent |
| K19 | Inventory integration credentials — management console | Optional read-only inventory | Low | Revoke and re-issue |
| K20 | Server host access | The server, its volume and its backups | High | Your accounts, your host. Our access revoked at Phase 4 |

---

## 3. Custody requirements

| Requirement | Applies to | Checked at |
|---|---|---|
| Two-person access, no single holder | K1–K7 | Escrow deposit, and quarterly thereafter |
| Sealed deposit with a recorded depositor and witness | K1–K7 | Phase 1 countersignature |
| Separate storage for K5 and K6 | K5, K6 | Phase 1. The separation is the control, not a preference |
| Documented restore test after receipt | K4 | Phase 3 restore drill |
| Documented update-signature test after receipt | K5 | Phase 3 update drill |
| Rotation schedule with an owner | K8, K9, K10, K13, K14 | Phase 4 appointment |

---

## 4. What happens if the database does not transfer

| Key | Outcome |
|---|---|
| K1, K2, K3 | Generated fresh in your environment. The fleet is enrolled from scratch |
| K4 | Generated fresh. Historical backups stay with us and are destroyed under the transfer agreement |
| K5 | **Still transfers.** Devices in the field already trust it |
| K6, K7 | Transfer, or are re-established with a per-device enrolment exercise |

---

## 5. Transfer signature block

**Escrow deposit — to be completed at Phase 1**

| Role | Name | Signature | Date |
|---|---|---|---|
| Depositing custodian (transferor) | | | |
| Witness (transferor) | | | |
| Receiving custodian 1 (recipient) | | | |
| Receiving custodian 2 (recipient) | | | |
| Witness (recipient) | | | |

**Countersignature — Phase 4**

> We confirm that every key in sections 1 and 2 is accounted for, that K1–K7 are in two-person custody as
> set out in section 3, and that the restore and update-signature tests in phases 3 have passed.

| Role | Name | Signature | Date |
|---|---|---|---|
| Recipient key custodian | | | |
| Recipient security lead | | | |
| Transferor representative | | | |

**Destroyed or revoked, not transferred** (list credential references and the date of revocation):

| Ref | Action | Date | Verified by |
|---|---|---|---|
| | | | |
| | | | |
