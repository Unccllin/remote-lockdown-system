# GDPR Legitimate Interest Assessment (LIA)

**Document ID:** LIA-2026-001
**Date:** 2026-07-22
**Review date:** 2027-07-22 (annual review)

## 1. Purpose

This Legitimate Interest Assessment (LIA) documents the lawful basis under
Article 6(1)(f) of the General Data Protection Regulation (GDPR) for
processing personal data in the Remote Lockdown system.

Under GDPR, processing of personal data is lawful if it is "necessary for
the purposes of the legitimate interests pursued by the controller or by a
third party," except where such interests are "overridden by the interests
or fundamental rights and freedoms of the data subject."

This assessment follows the three-part test recommended by the UK Information
Commissioner's Office (ICO) and the Article 29 Working Party.

---

## 2. The Three-Part Test

### Part 1: Legitimate Interest Pursued

**What is the legitimate interest?**

The Remote Lockdown system serves two primary legitimate interests:

1. **Property protection** — The device owner or organization has a legitimate
   interest in protecting their property (laptops, servers, mobile devices)
   from theft and unauthorized access.

2. **Data security** — Organizations have a legitimate interest (and in many
   cases a legal obligation under GDPR Art. 32) to implement appropriate
   technical and organizational measures to secure personal data stored on
   devices. Remote lockdown and encryption are such measures.

**Is the interest legitimate?**

Yes. The protection of property and implementation of security measures are
well-established legitimate interests recognized by:
- Article 29 Working Party Opinion 06/2014 on legitimate interests
- ICO guidance on legitimate interests
- Case law of the Court of Justice of the European Union

The interest is not overridden by the data subject's interests because:
- The data subject (device user) benefits from the protection of their data
- Processing is limited to what is necessary for device recovery
- Location tracking is only activated when the device is reported stolen

---

### Part 2: Necessity Test

**Is the processing necessary for the legitimate interest?**

| Processing activity | Necessary? | Justification |
|---------------------|------------|---------------|
| Device identification (hostname, MAC, UUID) | Yes | Required to identify which device to lock/unlock and to prevent spoofing |
| Location collection (when stolen) | Yes | Required to locate and recover stolen devices; without it, recovery is impossible |
| Encryption key storage | Yes | Required to decrypt the device upon recovery; keys are encrypted at rest |
| BIOS/UEFI password storage | Yes | Required for boot-level protection; passwords are encrypted at rest |
| Audit logging | Yes | Required for accountability and to demonstrate compliance with Art. 32 |
| Check-in timestamps | Yes | Required to determine if the device is online and to trigger dead man's switch |

**Could the legitimate interest be achieved without processing personal data?**

No. The core functionality of the Service — remote lockdown, location tracking,
and device recovery — inherently requires processing of device identifiers
and, when stolen, location data. There is no less intrusive alternative that
achieves the same purpose.

**Minimization measures in place:**
- Location data is collected **only** when the device is flagged as stolen
- Location data is automatically purged after 90 days (configurable: 7–180 days)
- No browsing history, application usage, file contents, or communications are monitored
- The agent does not capture keystrokes, screen contents, audio, or video
- All sensitive data (keys, passwords, location) is encrypted at rest with AES-256-GCM

---

### Part 3: Balancing Test

**Would the data subject reasonably expect this processing?**

| Context | Reasonable expectation? |
|---------|------------------------|
| Personal device (owner enrolled it) | Yes — the owner is the data subject and consented by enrolling |
| Corporate device (employer enrolled) | Likely yes — if employees were notified per Art. 88 |
| Corporate device (no notification) | No — processing may not be justified without notification |
| Stolen device (tracking activated) | Yes — a thief has no reasonable expectation of privacy regarding a stolen device's location |

**Impact on data subject's rights:**

| Factor | Assessment |
|--------|------------|
| Type of data | Location data (special category when precise) + device identifiers |
| Sensitivity | Moderate — location is sensitive but only collected during theft recovery |
| Volume | Low — periodic check-ins (every 30s–5min), location only when stolen |
| Duration | Limited — 90-day retention for location, indefinite for device records (until release) |
| Transparency | High — privacy policy, EULA, in-app disclosures, audit logs |
| Control | High — device owner can release device, export data, request deletion |

**Safeguards to reduce impact:**
1. **Purpose limitation** — data is used only for device security and recovery
2. **Data minimization** — only necessary data is collected (no content monitoring)
3. **Time limitation** — location data auto-purged after retention period
4. **Encryption** — all sensitive data encrypted at rest and in transit
5. **Access control** — admin authentication + per-device API keys
6. **Audit trail** — all administrative actions logged
7. **Right to object** — data subjects can object to processing (Art. 21)
8. **Right to erasure** — device release deletes all associated data

**Conclusion of balancing test:**

The legitimate interests of property protection and data security outweigh
the data subject's rights and freedoms, **provided that:**
- The device owner has consented to enrollment (or was notified per Art. 88
  for corporate devices)
- Location tracking is only activated when the device is reported stolen
- Data is retained only for the period necessary
- All safeguards listed above are implemented

---

## 3. Corporate Deployment Considerations

For employers deploying the Service on employee devices:

### 3.1 Notification Requirement (Art. 88)
GDPR Article 88 allows member states to provide rules on processing employees'
personal data in the employment context. Most EU member states require:
- **Prior notification** to employees about monitoring
- **Clear policy** on what is monitored and when
- **Works council approval** (in Germany, France, and other countries)

### 3.2 Recommended Practices
- Include the Service in the employee handbook or IT policy
- Obtain written acknowledgment from employees
- Limit tracking to company-owned devices only
- Do not activate location tracking unless the device is reported stolen
- Document the business need for each enrolled device

### 3.3 BYOD (Bring Your Own Device)
If employees use personal devices:
- Obtain explicit consent (Art. 6(1)(a)) rather than relying on legitimate
  interests
- Clearly separate personal and corporate data
- Allow employees to remove the agent when they leave the organization

---

## 4. Law Enforcement Requests

When a device is stolen and location data is collected:
- The data subject (the thief) has no reasonable expectation of privacy
- Sharing location data with law enforcement is justified under Art. 6(1)(c)
  (legal obligation) and Art. 6(1)(f) (legitimate interest in crime prevention)
- All law enforcement requests should be documented in the audit log

---

## 5. Review and Accountability

### 5.1 Regular Review
This LIA must be reviewed:
- Annually (by the date noted above)
- When significant changes are made to the Service's data processing
- When new guidance is issued by supervisory authorities
- When there are significant changes to applicable law

### 5.2 Accountability
- **Data Controller:** The organization deploying the Service (not the Service
  provider, unless the provider is also the controller)
- **Data Protection Officer:** Must be appointed if required by Art. 37
  (large-scale monitoring, special category data)
- **Records of Processing:** Must be maintained per Art. 30

### 5.3 Data Subject Rights
Data subjects have the right to:
- Object to processing (Art. 21)
- Access their data (Art. 15)
- Erasure ("right to be forgotten") (Art. 17)
- Data portability (Art. 20)
- Lodge a complaint with a supervisory authority (Art. 77)

---

## 6. Conclusion

The Remote Lockdown system's processing of personal data is justified under
Article 6(1)(f) (legitimate interests) for the purposes of property protection
and data security, subject to the safeguards and conditions documented in this
assessment.

**Key conditions for validity:**
1. ✅ Device owner has consented to enrollment
2. ✅ Location tracking only when device is reported stolen
3. ✅ Data retention limited (90 days for location, configurable)
4. ✅ All sensitive data encrypted at rest
5. ✅ No content monitoring (no files, browsing, keystrokes, audio, video)
6. ✅ Transparency (privacy policy, EULA, audit logs)
7. ✅ Data subject rights respected (access, erasure, objection)

---

*This document is a template and should be reviewed by a qualified Data
Protection Officer or legal professional before public release. It is based
on ICO guidance and Article 29 Working Party opinions as of 2026.*
