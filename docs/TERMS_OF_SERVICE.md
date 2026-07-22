# Terms of Service

**Last updated:** 2026-07-22

These Terms of Service ("Terms") govern your use of the Remote Lockdown
system ("Service"). By installing the agent software on a device or using
the admin application, you agree to these Terms.

---

## 1. Definitions

- **"Service"** — the Remote Lockdown system, including the admin application
  (desktop or cloud), server software, and device agent.
- **"Agent"** — the software installed on enrolled devices that communicates
  with the server.
- **"Administrator"** — the person who manages devices through the admin
  application.
- **"Device Owner"** — the person who owns or is authorized to manage the
  enrolled device.
- **"You"** — the Administrator or Device Owner using the Service.

---

## 2. Acceptable Use

### 2.1 Authorized Use Only
You may only install the Agent on devices that you own or have explicit
authorization to manage. Installing monitoring software on a device without
the owner's consent may be illegal in your jurisdiction.

### 2.2 Prohibited Uses
You agree NOT to:
- Install the Agent on devices you do not own or have authorization to manage
- Use the Service to stalk, harass, or monitor individuals without consent
- Use the Service for any illegal purpose
- Reverse engineer, decompile, or attempt to extract encryption keys from the
  Agent (except for legitimate security research with responsible disclosure)
- Use the Service to violate any applicable law, including privacy laws,
  computer fraud laws, or surveillance regulations

### 2.3 Corporate/Institutional Use
For corporate or institutional deployments:
- Ensure compliance with your organization's policies and applicable labor laws
- Notify employees if monitoring devices assigned to them (required in many
  jurisdictions, including EU member states under GDPR Art. 88)
- Obtain written consent where required by local law
- Document the legitimate business purpose for device monitoring

---

## 3. Your Responsibilities

### 3.1 Account Security
- You are responsible for maintaining the security of your admin credentials
- You must not share your admin password or API keys with unauthorized parties
- You are responsible for all actions taken through your admin account

### 3.2 Device Consent
- Before enrolling a device, ensure you have the legal right to do so
- For shared or corporate devices, obtain consent from all users of the device
- For personal devices (e.g., your own laptop), no additional consent is needed

### 3.3 Compliance with Laws
- You are responsible for complying with all applicable laws, including:
  - GDPR (EU/EEA)
  - CCPA (California)
  - Electronic Communications Privacy Act (US)
  - Computer Fraud and Abuse Act (US)
  - Local surveillance and monitoring laws
- The Service provider is not liable for your misuse of the Service

---

## 4. Service Description

### 4.1 Core Features
The Service provides:
- **Remote lockdown** — encrypt device data and prevent boot without password
- **Device tracking** — collect location data when a device is flagged as stolen
- **Recovery** — decrypt and restore access to a recovered device
- **Audit logging** — record all administrative actions

### 4.2 Limitations
- The Service is not guaranteed to prevent all forms of unauthorized access
- A sufficiently sophisticated attacker may bypass software-based lockdown
- Location tracking depends on network connectivity and may not work if the
  device is offline or has been factory-reset
- Boot-level protection (BIOS/UEFI lockdown) is only available on supported
  hardware (HP UEFI, Windows BCD)

### 4.3 No Guarantee of Recovery
We do not guarantee that a stolen device will be recovered. The Service
provides tools to assist in recovery, but recovery depends on factors outside
our control (law enforcement cooperation, device connectivity, etc.).

---

## 5. Data and Privacy

See our [Privacy Policy](PRIVACY_POLICY.md) for details on data collection,
use, retention, and your privacy rights.

---

## 6. Intellectual Property

### 6.1 Software License
The Service is provided under the license terms in the repository's LICENSE
file. The source code is available at:
https://github.com/unccllin/remote-lockdown-system

### 6.2 Open Source
The Service incorporates open-source software components, each governed by
their respective licenses. See the repository for a list of dependencies.

---

## 7. Disclaimers

### 7.1 "As Is" Basis
The Service is provided "AS IS" and "AS AVAILABLE," without warranties of any
kind, express or implied, including but not limited to:
- Merchantability
- Fitness for a particular purpose
- Non-infringement
- That the Service will be error-free or uninterrupted

### 7.2 No Professional Advice
These Terms and the Service do not constitute legal advice. Consult a
qualified attorney regarding your legal obligations when monitoring devices.

---

## 8. Limitation of Liability

To the maximum extent permitted by law:
- The Service provider shall not be liable for any indirect, incidental,
  special, consequential, or punitive damages
- The Service provider's total liability shall not exceed the amount paid
  for the Service in the 12 months preceding the claim (or $0 if the Service
  is provided free of charge)
- The Service provider is not liable for data loss, device damage, or failure
  to recover a stolen device

---

## 9. Indemnification

You agree to indemnify and hold harmless the Service provider from any claims,
damages, or expenses (including legal fees) arising from:
- Your misuse of the Service
- Your violation of these Terms
- Your violation of applicable laws, including privacy and surveillance laws
- Claims by third parties (e.g., device users) regarding unauthorized monitoring

---

## 10. Termination

### 10.1 Termination by You
You may stop using the Service at any time. To remove the Agent from a device:
- Use the uninstall script provided in the installer package
- On Windows: use Add/Remove Programs
- On Linux: `systemctl stop lockdown-agent && systemctl disable lockdown-agent`

### 10.2 Termination by Us
We may terminate or suspend access to the Service if:
- You violate these Terms
- We are required to do so by law
- The Service is being discontinued

---

## 11. Changes to Terms

We may update these Terms from time to time. Material changes will be
communicated through the admin dashboard or by email. Continued use of the
Service after changes constitutes acceptance of the updated Terms.

---

## 12. Governing Law

These Terms are governed by the laws of the jurisdiction in which the Service
provider is established, without regard to conflict of law principles.

---

## 13. Contact

For questions about these Terms:
- **Email:** research@remotelockdown.com
- **Repository:** https://github.com/unccllin/remote-lockdown-system

---

*This document is a template and should be reviewed by a qualified legal
professional before public release. It is provided as a starting point based
on industry best practices and common SaaS terms of service.*
