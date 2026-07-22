# Privacy Policy

**Last updated:** 2026-07-22

This Privacy Policy describes how Remote Lockdown ("we", "us", "our") collects,
uses, and protects data when you use our remote device lockdown system (the
"Service"). The Service consists of an admin application (desktop or cloud)
and a software agent installed on enrolled devices.

By installing the agent on a device and enrolling it in the Service, you
acknowledge that you have read and understood this Privacy Policy.

---

## 1. Data We Collect

### 1.1 Device Information
When a device is enrolled, we collect:
- **Hostname** — the device's computer name
- **Owner name** — the name entered during enrollment
- **MAC address** — the device's network interface hardware address
- **Hardware UUID** — the device's manufacturer-assigned unique identifier

### 1.2 Location Data
When a device is in "tracking" mode (flagged as stolen), we collect:
- **GPS coordinates** (latitude/longitude) — if available
- **IP-based geolocation** — approximate location derived from IP address
- **Wi-Fi access points** — nearby SSIDs/signal strengths for WiFi-based positioning
- **Accuracy radius** — estimated accuracy of the location reading
- **City/region/country** — derived from the location data

Location data is only collected when the device is flagged as stolen or
explicitly placed in tracking mode by an authorized administrator.

### 1.3 Security Data
- **Encryption keys** — generated on the device during lockdown, stored encrypted
- **BIOS/UEFI passwords** — generated during lockdown for boot-level protection
- **Boot lock status** — whether the device's boot loader is locked
- **Dead man's switch key** — recovery key material for emergency access

### 1.4 Audit Data
- **Check-in timestamps** — when the device last contacted the server
- **Command history** — lockdown, unlock, track, stop_track commands issued
- **Administrative actions** — who flagged a device, when, and why

### 1.5 Data We Do NOT Collect
- We do **not** collect browsing history, application usage, or screen contents
- We do **not** capture keystrokes or mouse input
- We do **not** access personal files, photos, or documents
- We do **not** record audio or video from the device
- We do **not** monitor email, chat, or social media activity

---

## 2. How We Use Data

### 2.1 Legitimate Purposes
- **Device recovery** — location data is used to help recover stolen devices
- **Access protection** — encryption keys and BIOS passwords prevent unauthorized
  access to locked devices
- **Operational integrity** — audit logs ensure accountability for administrative
  actions
- **Service functionality** — device identifiers ensure commands reach the
  correct device

### 2.2 Legal Basis (GDPR)
- **Legitimate interests** (Art. 6(1)(f)) — protecting property and recovering
  stolen devices. See our [GDPR Legitimate Interest Assessment](GDPR_LIA.md).
- **Consent** (Art. 6(1)(a)) — the device owner or authorized administrator
  consents to monitoring by enrolling the device
- **Legal obligation** (Art. 6(1)(c)) — where required by law enforcement
  requests or regulatory requirements

---

## 3. Data Retention

| Data type | Retention period | Configurable? |
|-----------|-----------------|---------------|
| Location reports | 90 days (default) | Yes (7–180 days) |
| Audit logs | 365 days | No |
| Encryption keys | Until device is recovered and unlocked | No |
| Device records | Until device is released from account | No |
| Command history | 365 days | No |

Location data is automatically purged by a scheduled job. The retention period
can be configured via `LOCATION_RETENTION_DAYS` (minimum: 7, maximum: 180).

---

## 4. Data Sharing

### 4.1 Law Enforcement
We may share location data and audit logs with law enforcement when:
- Presented with a valid subpoena, court order, or search warrant
- Required by applicable law
- The device owner requests assistance with recovery

### 4.2 No Third-Party Sale
We do **not** sell, rent, or trade your data to third parties. We do not use
your data for advertising.

### 4.3 Service Providers
We use the following third-party services:
- **GitHub** — for software distribution and auto-updates
- **Let's Encrypt** — for TLS certificates (cloud deployments)
- **Azure Trusted Signing / Apple Developer** — for code signing certificates

These providers may process minimal data necessary to provide their services.

---

## 5. Data Security

### 5.1 Encryption
- **At rest** — all sensitive database fields (encryption keys, BIOS passwords,
  location data) are encrypted with AES-256-GCM
- **In transit** — all client-server communication uses HTTPS/TLS
- **Agent communication** — authenticated with per-device API keys and
  HMAC-SHA256 request signing

### 5.2 Access Control
- Admin access requires JWT-based authentication
- Per-device API keys prevent cross-device access
- Rate limiting prevents brute-force attacks

### 5.3 Data Minimization
- The agent only collects data when needed (location only during tracking)
- Location data is automatically purged after the retention period
- Devices can be released from the system, deleting all associated data

---

## 6. Your Rights

### 6.1 GDPR Rights (EU/EEA/UK)
- **Access** — request a copy of your personal data
- **Rectification** — request correction of inaccurate data
- **Erasure** — request deletion of your data ("right to be forgotten")
- **Restriction** — request limitation of processing
- **Portability** — receive your data in a machine-readable format
- **Objection** — object to processing based on legitimate interests
- **Withdrawal of consent** — withdraw consent at any time

To exercise these rights, contact us at: privacy@remotelockdown.com

### 6.2 CCPA Rights (California)
- **Know** — what personal information is collected
- **Delete** — request deletion of personal information
- **Opt-out** — of the sale of personal information (we do not sell data)
- **Non-discrimination** — equal service regardless of rights exercised

### 6.3 Device Owner Rights
- **Release device** — remove a device from your account at any time
- **View audit log** — see all administrative actions taken on your devices
- **Data export** — export all data associated with your account

---

## 7. International Transfers

If you are located outside the United States, your data may be transferred to
and processed in the United States. We rely on:
- **Standard Contractual Clauses (SCCs)** — for transfers from the EU/EEA/UK
- **Adequacy decisions** — where applicable (e.g., EU-US Data Privacy Framework)

---

## 8. Children's Privacy

The Service is not directed to children under 16. We do not knowingly collect
data from children. If you believe a child's device has been enrolled, contact
us to have it removed.

---

## 9. Changes to This Policy

We may update this Privacy Policy from time to time. We will notify users of
material changes by:
- Posting the updated policy on our website
- Including a notification in the admin dashboard
- Updating the "Last updated" date at the top of this document

---

## 10. Contact

For privacy questions or requests:
- **Email:** privacy@remotelockdown.com
- **Data Protection Officer (EU):** dpo@remotelockdown.com

For security vulnerability reports:
- **Email:** security@remotelockdown.com

---

*This document is a template and should be reviewed by a qualified legal
professional before public release. It is provided as a starting point based
on industry best practices (Prey Project, Absolute Software) and GDPR/CCPA
requirements.*
