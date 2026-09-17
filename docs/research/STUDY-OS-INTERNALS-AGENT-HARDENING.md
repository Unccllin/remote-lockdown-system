# Modern Operating Systems (Tanenbaum & Bos) — Agent-Hardening Study Notes

> **Scope filter.** This is NOT a general summary of *Modern Operating Systems* (MOS).
> Only material that maps to hardening `agent/agent.py` — a host-resident Python agent
> that must survive a thief who has **physical and administrator/root control** of the
> machine — is extracted here. Chapters with no lockdown relevance are skipped and
> named as skipped. Windows-specific internals already covered in
> `STUDY-WINDOWS-NT-INTERNALS.md` are cross-referenced, not duplicated.

## Source

- **Primary text:**
  - Tanenbaum, A.S. & Bos, H., *Modern Operating Systems*, 4th ed., Pearson, 2014/2015.
    Full TOC (all chapters + sections): <https://ebin.pub/download/modern-operating-systems-fourth-edition-013359162x-9780133591620.html> and publisher TOC at <https://www.pearson.com/en-us/subject-catalog/p/redirected-product/P200000003311/9780133591620>. Book-preview TOC PDF: <https://api.pageplace.de/preview/DT0400.9781292061955_A24588869/preview-9781292061955_A24588869.pdf>.
  - *Modern Operating Systems*, 5th ed. (Tanenbaum & Bos) — TOC changes noted where
    relevant (ch. 7 virtualization re-numbered; Windows 11 case study replaces the
    Windows 8 case study). 5e preview TOC: <https://api.pageplace.de/preview/DT0400.9781292727899_A46720136/preview-9781292727899_A46720136.pdf>; 5e description: <https://www.pearson.com/content/dam/one-dot-com/one-dot-com/us/en/files/14939-Tanenbaum-ModernOperatingSystems-5E.pdf>.
  - Tanenbaum's own book-resource page (figures/slides for earlier editions):
    <https://www.cs.vu.nl/~ast/books/book_software.html>. Companion-slide mirror for
    ch. 9 (3e deck — rootkit taxonomy figure is unchanged in 4e):
    <https://www.slideserve.com/lorin/modern-operating-systems-third-edition-andrew-s-tanenbaum-chapter-9-security-powerpoint-ppt-presentation>.

- **Labeled substitutions** — where the book is thin for agent-hardening purposes,
  primary sources for the same concept are used instead and marked **[SUB]**:
  - procfs: <https://man7.org/linux/man-pages/man5/procfs.5.html> (esp. `hidepid=`) and
    kernel doc <https://www.kernel.org/doc/html/latest/filesystems/proc.html>.
    Kernel task-list iteration (`for_each_process`):
    <https://elixir.bootlin.com/linux/latest/source/include/linux/sched/signal.h>.
  - Windows process enumeration: <https://learn.microsoft.com/en-us/windows/win32/toolhelp/snapshots-of-the-system>,
    <https://learn.microsoft.com/en-us/windows/win32/api/tlhelp32/nf-tlhelp32-createtoolhelp32snapshot>,
    <https://learn.microsoft.com/en-us/windows/win32/toolhelp/process-walking>.
  - ETW: <https://learn.microsoft.com/en-us/windows/win32/etw/about-event-tracing>.
  - Memory protection: <https://man7.org/linux/man-pages/man2/mprotect.2.html>,
    <https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-virtualprotect>,
    <https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-writeprocessmemory>,
    <https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights>.
  - NTFS streams: <https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams>,
    <https://learn.microsoft.com/en-us/sysinternals/downloads/streams>.
  - Forensic residue (slack space): NIST SP 800-86,
    <https://csrc.nist.gov/publications/detail/sp/800-86/final>.
  - Lock/session APIs: <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation>,
    <https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-blockinput>,
    <https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-and-desktop-creation>
    (window stations/desktops; the Winlogon "secure desktop").
  - Camera/mic consent gates: <https://learn.microsoft.com/en-us/windows/apps/develop/camera/camera-privacy-setting>,
    <https://support.microsoft.com/en-us/windows/privacy/windows-privacy-settings-that-apps-use>,
    Apple AVFoundation authorization: <https://developer.apple.com/documentation/avfoundation/capture-setup/requesting-authorization-to-capture-and-save-media>.
  - Scheduling: <https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities>,
    <https://man7.org/linux/man-pages/man7/sched.7.html>.
  - Watchdogs/service supervision: <https://www.kernel.org/doc/html/latest/watchdog/watchdog-api.html>,
    <https://www.freedesktop.org/software/systemd/man/250/sd_notify.html> (`WATCHDOG=1`),
    <https://man7.org/linux/man-pages/man3/sd_watchdog_enabled.3.html>,
    <https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa>,
    macOS launchd jobs: <https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>.
  - Atomic commit / journaling substitutes: <https://sqlite.org/atomiccommit.html>,
    <https://sqlite.org/wal.html>.
  - Hypervisor detection: Microsoft TLFS feature discovery,
    <https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/tlfs/feature-discovery>;
    Popek & Goldberg 1974 criteria: <https://dl.acm.org/doi/10.1145/361011.361073>;
    SubVirt (VM rootkit paper, King & Chen, IEEE S&P 2006):
    <https://web.eecs.umich.edu/virtual/papers/king06.pdf>; BH-USA-06 hardware-VM
    rootkit survey: <https://blackhat.com/presentations/bh-usa-06/BH-US-06-Zovi.pdf>.
  - Safe-mode/service whitelisting (`SafeBoot\Minimal` hive):
    <https://learn.microsoft.com/en-us/answers/questions/2782457/(fcu)-how-to-run-the-%22schedule%22-service-in-safe-mode>.
  - MITRE ATT&CK for adversary-technique naming: T1014 (Rootkit)
    <https://attack.mitre.org/techniques/T1014/>, T1562 (Impair Defenses)
    <https://attack.mitre.org/techniques/T1562/>, T1497 (Virtualization/Sandbox
    Evasion) <https://attack.mitre.org/techniques/T1497/>.
  - Capabilities (Linux): <https://man7.org/linux/man-pages/man7/capabilities.7.html>.
  - EFS/`cipher`: <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cipher>.

- **Local files mapped:** `agent/agent.py`, `agent/watchdog.py`,
  `agent/tamper_protection.py`, `agent/service_installer.py`, `agent/state_crypto.py`,
  `agent/duress.py`, `agent/bcd_lockdown.py`,
  `.devin/graph/GRAPH-SPEC.yaml` (enforcement-path definitions).

> **Source fidelity note:** MOS is a generic OS textbook. Section numbers cited
> below (e.g., "§9.9.5") are from the 4e TOC (linked above); 5e re-numbers some
> sections — noted where it matters. Claims attributed to MOS are chapter/section
> level; no page numbers are fabricated. Every mechanism that maps to running code
> is additionally anchored to a primary API/doc source ([SUB]).

## One-paragraph technical overview

MOS teaches the standard layered picture: the CPU runs in at least two hardware
protection modes (kernel/supervisor and user); processes are entries in a kernel
process table; each process owns a private virtual address space enforced by the
MMU via page tables; files are names over disk blocks managed by a (usually
journaled) file system; devices are driven by kernel-resident drivers; the
scheduler decides which runnable thread gets the CPU; hypervisors virtualize the
whole machine below the OS; and the security chapter defines the TCB — everything
an attacker must compromise to break the system. The single most important
agent-hardening consequence falls out of the first four of those facts: **a
ring-3 agent cannot defend itself against an adversary inside the TCB.** An
admin/root thief can list, suspend, starve, debug, patch, or kill the agent;
can read and write its memory; can read and delete its files; and can change
the system clock the deadman switch measures. MOS's own rootkit taxonomy
(§9.9.5 — firmware, hypervisor, kernel, library, application) shows that the
agent sits at the *weakest* hiding layer, while the agent's covert-tracking
mode (E-TRACK) is itself spyware-shaped. The viable design is therefore not
prevention but **fail-secure detection + re-assertion + an out-of-band root
of trust**: multiple persistence surfaces, mutual watchdogs, ACL friction,
tamper-evident state (HMAC/DPAPI/TPM), a deadman switch that inverts the
heartbeat requirement, and the PBL firmware app as the layer the thief cannot
reach from the OS at all.

## Key technical facts/mechanisms

1. **The kernel/user split is a hardware feature, not a software policy.** MOS
   §1.3.1/§1.5-1.6: the CPU has a mode bit; privileged instructions (I/O control,
   page-table manipulation, timer programming) trap in user mode; user code
   reaches the kernel only via system calls. [SUB] Intel SDM ring levels:
   <https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html>;
   Windows syscall path is detailed in `STUDY-WINDOWS-NT-INTERNALS.md` (KTRAP_FRAME,
   `PreviousMode`, SSDT). **Agent consequence:** everything the agent does —
   lock screen, encryption, state files — is one syscall away from being undone
   by an admin, because the admin can load kernel code or issue the same calls.

2. **Processes are rows in a kernel table; "listing processes" is reading that
   table through an OS-defined lens.** MOS §2.1.5-2.1.6 (process states,
   implementation via the process table). [SUB] On Linux the lens is procfs — a
   pseudo-filesystem exposing kernel `task_struct`s as `/proc/<pid>` directories
   (<https://man7.org/linux/man-pages/man5/procfs.5.html>); the kernel iterates
   `for_each_process` (<https://elixir.bootlin.com/linux/latest/source/include/linux/sched/signal.h>).
   On Windows the user-mode lens is the Toolhelp snapshot
   (`CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS)` + `Process32First/Next`,
   <https://learn.microsoft.com/en-us/windows/win32/toolhelp/process-walking>);
   `tasklist`, WMI, and ETW process-start/stop events are alternate lenses
   (<https://learn.microsoft.com/en-us/windows/win32/etw/about-event-tracing>).

3. **Process hiding is a kernel-layer operation; a ring-3 process cannot hide
   from the kernel.** Kernel rootkits hide processes by unlinking them from the
   enumeration lists (classic DKOM against `EPROCESS.ActiveProcessLinks` / Linux
   task list — MITRE T1014 <https://attack.mitre.org/techniques/T1014/>; ReactOS
   `PspCidTable`/active-process list covered in `STUDY-WINDOWS-NT-INTERNALS.md`).
   [SUB] procfs `hidepid=2` can hide a process's `/proc/<pid>` directory from
   *other users* but never from root (<https://man7.org/linux/man-pages/man5/procfs.5.html>).
   **Agent consequence:** `STEALTH_TASK_NAME = "SystemHealthMonitor"`
   (agent.py:2625) and the `--silent` flag are camouflage, not concealment —
   any admin running `tasklist`/`schtasks`/`ps` or watching ETW sees the agent.
   Accept this; invest instead in *re-assertion* (mutual watchdog,
   agent.py:3201-3211; `check_watchdog_health`) and *tamper-evidence*
   (`_run_tamper_check`, agent.py:3214-3278). Corollary for detection: an agent
   that wants to spot a thief-installed rootkit can diff two independent process
   listings (e.g., Toolhelp vs. `EnumProcesses` vs. ETW history) — a row present
   in one and missing in the other is a hiding process.

4. **Page-table memory protection does not apply to admin.** MOS ch. 3
   (§3.2-3.3): per-process address spaces are enforced by page-table protection
   bits; `mprotect(2)`/`VirtualProtect` let a process change *its own* pages'
   protections. [SUB] But an admin can open another process's address space:
   `OpenProcess(PROCESS_VM_OPERATION|PROCESS_VM_WRITE)` +
   `VirtualProtectEx`/`WriteProcessMemory`
   (<https://learn.microsoft.com/en-us/windows/win32/procthread/process-security-and-access-rights>,
   <https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-writeprocessmemory>);
   on Linux, `CAP_SYS_PTRACE` root reads/writes `/proc/<pid>/mem`
   (<https://www.kernel.org/doc/html/latest/filesystems/proc.html>,
   <https://man7.org/linux/man-pages/man7/capabilities.7.html>).
   **Agent consequence:** `wipe_key()` (agent.py:488-501) only removes key
   material the *agent itself* chooses to zero — it cannot stop an admin from
   dumping agent memory mid-operation (e.g., while the Fernet key is live during
   `encrypt_folder`, agent.py:523-545, or while `key_b64` is written to
   `pending_ack`, agent.py:1735). Runtime key secrecy against an admin is
   unattainable; the design already compensates by persisting keys to disk
   (File A pending-ack + File B RSA-wrapped recovery blob, agent.py:1732-1738)
   rather than relying on memory secrecy.

5. **Journaled file systems trade recoverability for forensic residue.** MOS
   §4.3.5-4.3.6 (log-structured and journaling file systems), §4.4.3 (FS
   consistency). Journaling writes metadata (and sometimes data) to a log before
   committing it — so a crash mid-write replays cleanly, **and** "deleted" or
   overwritten content can survive in the journal or in slack space. [SUB]
   NIST SP 800-86 documents slack/journal residue as a forensics source
   (<https://csrc.nist.gov/publications/detail/sp/800-86/final>); SQLite achieves
   atomic commits via rollback journal or WAL (<https://sqlite.org/atomiccommit.html>,
   <https://sqlite.org/wal.html>). **Agent consequence (double-edged):**
   (a) *defense* — `_atomic_write_text` (tmp+fsync+rename, agent.py:1414-1423),
   `write_pending_ack` (agent.py:1426-1469), and the SQLite `offline_queue`
   (agent.py:1306-1396) are exactly the stable-storage pattern (MOS §5.4.5):
   crash at any point leaves either old or new state, never corruption, which is
   what makes `drain_pending_ack`/`drain_offline_queue` safe to replay.
   (b) *exposure* — `DEADMAN_KEY_FILE.write_text(key_b64)` (agent.py:2935) and
   the plaintext `.pending_ack`/`key_material` leave journal-resident copies an
   offline disk-analysis thief could recover; conversely a thief's `delete` of
   state files may be recoverable from `$LogFile`, aiding forensics.

6. **NTFS Alternate Data Streams are a covert-storage primitive the agent
   neither uses nor scans for.** MOS ch. 4 covers named-attribute file
   systems generically; the Windows 8 case study (ch. 11, 4e) covers NTFS.
   [SUB] NTFS files are collections of named `$DATA` streams; `file:stream`
   syntax creates streams invisible to `dir` size and Explorer
   (<https://learn.microsoft.com/en-us/windows/win32/fileio/file-streams>,
   <https://learn.microsoft.com/en-us/sysinternals/downloads/streams>);
   EFS itself stores per-file key material in the `$EFS:$LOGGED_UTILITY_STREAM`
   stream — which is why `cipher /e` works invisibly to directory listings.
   **Agent consequence:** (a) opportunity — tracking state, the hidden-trigger
   file mechanism (duress.py:76-105, `.system_cache_cleanup`), or the deadman
   file could live in ADS to raise the discovery bar; (b) risk — an attacker
   can equally hide payloads/tools in ADS, and `check_tamper`
   (tamper_protection.py) only checks named files, not their streams.

7. **Screen-lock is a session/GUI-layer construct; true input lockout is a
   kernel or pre-OS concern.** MOS ch. 5 (§5.3 drivers, §5.6 input software):
   devices are driven by kernel code; a user-mode "lock screen" is just a window
   the window manager draws and an input policy the session enforces. [SUB]
   `LockWorkStation` asks Winlogon to switch to the secure desktop
   (<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation>);
   window stations/desktops isolate input (<https://learn.microsoft.com/en-us/windows/win32/winstation/window-station-and-desktop-creation>);
   `BlockInput` exists but is a hint, not a barrier
   (<https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-blockinput>);
   Ctrl+Alt+Del (SAS) is reserved for the system and cannot be trapped by a
   user-mode app. **Agent consequence:** `_lock_workstation`
   (agent.py:646-725), the overlay `apply_lock_screen` (agent.py:728-749) and
   the guardian re-lock loop (agent.py:791-807) are all defeatable by an admin
   who kills the overlay process, logs the session off, or uses a second
   session — D-007 already hit the Session-0 variant of this. A thief with a
   boot menu/USB bypasses the OS lock entirely, which is why `bcd_lockdown.py`
   (`recoveryenabled No`, `bootmenupolicy Standard`, WinRE disable —
   bcd_lockdown.py:320-332) and PBL exist. Device-level lockout would require a
   kernel filter driver — out of scope for a Python agent.

8. **Webcam/mic are gated by OS consent layers, not hardware locks.** MOS §5.1
   (I/O devices) + §5.3 (drivers): the device driver arbitrates access. [SUB]
   Windows exposes a camera/mic privacy switch that returns `E_ACCESSDENIED` to
   capture APIs (<https://learn.microsoft.com/en-us/windows/apps/develop/camera/camera-privacy-setting>);
   the toggle is per-capability, and desktop apps aren't listed individually but
   device-wide "off" still blocks (<https://support.microsoft.com/en-us/windows/privacy/windows-privacy-settings-that-apps-use>);
   macOS requires explicit AVFoundation authorization (<https://developer.apple.com/documentation/avfoundation/capture-setup/requesting-authorization-to-capture-and-save-media>).
   **Agent consequence:** the agent has no webcam/mic capture today (only
   WiFi/IP geolocation, agent.py:904-1050). If covert photo evidence is ever
   added for E-TRACK, expect `E_ACCESSDENIED` on machines where the owner left
   camera access off — and on macOS, an unavoidable OS consent prompt that
   breaks covertness. Treat as best-effort telemetry, never a blocking step.

9. **The scheduler gives no uptime guarantee to any user-mode process.** MOS
   §2.4 (scheduling, incl. real-time §2.4.4): threads are preemptively
   multiplexed; priorities are advisory inputs the kernel can ignore or
   override. [SUB] Windows priority classes (<https://learn.microsoft.com/en-us/windows/win32/procthread/scheduling-priorities>)
   and Linux `SCHED_*` policies/nice (<https://man7.org/linux/man-pages/man7/sched.7.html>)
   let *the admin* starve, suspend (`SIGSTOP`, `NtSuspendProcess`, cgroup
   freezer), or de-prioritize the agent. **Agent consequence:** the agent's
   heartbeat (`HEARTBEAT_FILE.touch`, agent.py:3434) and deadman check
   (agent.py:2890-2941) only run while the OS schedules the agent. Correct
   design is to source liveness from outside the process: scheduled-task
   restart (`ensure_tracking_stealth`, agent.py:2629-2673; service_installer.py
   creates `schtasks /RU SYSTEM` entries), the separate watchdog process
   (watchdog.py:234-257 restart loop), service recovery actions
   ([SUB] `SERVICE_FAILURE_ACTIONS`, <https://learn.microsoft.com/en-us/windows/win32/api/winsvc/ns-winsvc-service_failure_actionsa>),
   `systemd WatchdogSec=`/`sd_notify("WATCHDOG=1")`
   (<https://man7.org/linux/man-pages/man3/sd_watchdog_enabled.3.html>), and
   `launchd KeepAlive` (<https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html>).
   Currently the Linux/macOS paths rely on pgrep-based babysitting only —
   systemd/launchd supervision is the OS-correct mechanism the book's model
   points to.

10. **The deadman switch is an inverted watchdog, and its clock is
    attacker-controlled.** MOS §5.5 covers clock software/soft timers; the
    watchdog concept itself (a timer that must be patted or it fires) is an
    embedded-systems primitive the book only brushes past — [SUB] kernel
    watchdog API <https://www.kernel.org/doc/html/latest/watchdog/watchdog-api.html>
    and systemd watchdog (above) are the canonical implementations.
    `check_deadman` (agent.py:2890-2941) computes `elapsed = time.time() -
    last_seen` — i.e., it reads the *wall clock*, which an admin can set
    arbitrarily. Setting the clock forward makes `last_seen` future-dated
    → `elapsed` negative → deadman never fires; setting it backward
    accelerates firing. Note the design already inverts correctly for
    *missing* heartbeats (no server contact → fire), but not for *forged*
    time. Mitigation candidates: store last-seen alongside a monotonic-ish
    anchor (boot time + TickCount, NTP time seen at last checkin), or treat
    `time.time() < last_seen` as tamper → fire (fail-secure, consistent with
    `_read_deadman_state`'s corrupt→stolen rule, agent.py:2799-2802).

11. **Safe Mode is a whitelist for services — and the agent isn't on it.** MOS
    doesn't cover Windows Safe Mode (it's in the case-study scope). [SUB] Safe
    Mode loads only drivers/services listed under
    `HKLM\SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal|Network`; the Task
    Scheduler service is not a safe-boot service, so scheduled tasks don't run
    (<https://learn.microsoft.com/en-us/answers/questions/2782457/(fcu)-how-to-run-the-%22schedule%22-service-in-safe-mode>).
    **Agent consequence:** the thief's cheapest persistence bypass is
    boot-to-Safe-Mode — the agent's `SystemHealthMonitor` task (agent.py:2625)
    and watchdog never start. The agent's own countermeasures are already the
    right ones per this model: `bcd_lockdown.py` removes the F8 boot menu and
    WinRE (the on-ramp to Safe Mode), `startup_check` (agent.py:2697-2763)
    re-locks on the *next* normal boot via sentinel+deadman cross-check, and
    E-ENCRYPT means the folder is ciphertext regardless of boot mode. Residual
    gap: a thief who images/mounts the disk offline never boots the OS at all —
    only encryption + PBL help there, not any agent-side mechanism.

12. **Popek-Goldberg + the CPUID hypervisor bit make VM detection trivial from
    inside.** MOS ch. 7 (4e §7.2-7.4; 5e §7.2-7.4): a machine is virtualizable
    iff sensitive instructions are a subset of privileged instructions
    (Popek & Goldberg, <https://dl.acm.org/doi/10.1145/361011.361073>); modern
    hypervisors deliberately expose themselves via `CPUID.1:ECX[31]`
    ("hypervisor present") and leaves `0x40000000+` (vendor signature,
    `Microsoft Hv`, `KVMKVMKVM`, `VMwareVMware`...) — [SUB]
    <https://learn.microsoft.com/en-us/virtualization/hyper-v-on-windows/tlfs/feature-discovery>.
    **Agent consequence:** (a) a thief can move the disk/system into a VM for
    safe analysis — the agent can detect this with one `cpuid` call or via
    MAC OUI/device strings and report `vm_present` in `checkin` telemetry;
    today there is no VM detection in agent.py. (b) **Do not** take the
    malware route of refusing to run under a hypervisor (MITRE T1497) — the
    agent *wants* to run and phone home; detection is telemetry, not a kill
    switch. (c) VM snapshot-rollback interacts safely with the deadman
    switch: reverting to an older snapshot restores an older `last_seen` →
    `elapsed` grows → deadman fires *sooner* (fail-secure), provided the
    snapshot's deadman status was `stolen`. (d) The flip side — a hypervisor
    rootkit *above* the OS (SubVirt, <https://web.eecs.umich.edu/virtual/papers/king06.pdf>;
    Blue Pill/Vitriol survey <https://blackhat.com/presentations/bh-usa-06/BH-US-06-Zovi.pdf>)
    is invisible to any agent-side check; only PBL-level (pre-OS) measurement
    can catch it — see `STUDY-UEFI-BOOTKITS.md`.

13. **The TCB framing explains why agent self-protection is friction, not
    prevention.** MOS §9.2.1-9.2.2: the Trusted Computing Base is the set of
    hardware/software an attacker must defeat; if the attacker *is* inside
    (admin/root), the boundary is gone. §9.3.2 ACLs vs §9.3.3 capabilities:
    ACLs are enforced by the object manager at access time — and the admin can
    take ownership (`SeTakeOwnershipPrivilege`) and rewrite them.
    **Agent consequence:** `tamper_protection.py`'s `icacls /deny
    Everyone:(DE)` (tamper_protection.py:73-98) plus `SYSTEM:(F)` grant is
    exactly an ACL-layer speed bump — it forces the thief through
    take-ownership → reset-DACL → delete, buying time for `check_tamper`
    (agent.py:3214) or the watchdog to notice, and making the attempt
    *noisy and attributable*. Model it as "delay + detection," never as
    "protection." The real TCB floor for this system is PBL in firmware +
    the server-side flag, both outside the thief's OS-level control.

14. **TOCTOU is the design pattern the agent already uses — and must keep
    using.** MOS §9.7.7 (Time-of-Check-to-Time-of-Use): decisions made on
    state that can change between check and use are exploitable. **Agent
    consequence:** `handle_lockdown` uses `os.open(sentinel, O_CREAT|O_EXCL)`
    so the sentinel itself is the atomic claim (agent.py:1712-1723) —
    concurrent lockdown triggers can't double-encrypt; `_atomic_write_text`
    (agent.py:1414) prevents torn state; `download_update` hashes-then-renames
    (agent.py:3064-3097) so a partial/mismatched binary is never signal-worthy.
    Watch for regressions: any `if path.exists(): path.open()` pattern in new
    code is a §9.7.7 hole — e.g., a thief racing `handle_unlock` vs. the
    guardian loop.

15. **The agent is spyware-shaped; the book's malware taxonomy is the attack
    surface inventory, read defensively.** MOS §9.9 (trojan/virus/worm/spyware/
    rootkit): covert tracking (silent checkins, geolocation, persistence,
    decoy account) *is* the spyware feature set — which has two consequences.
    (a) AV/EDR may classify the agent as malware; benign code-signing +
    consistent publisher identity is the §9.10.2/§9.10.3 defense to adopt.
    (b) The *thief's* counter-attack toolkit is the same taxonomy: delete the
    binary (persistence attack), boot Safe Mode (§11 above), replace the binary
    (auto-update channel abuse), or rootkit the OS. §9.9.5's five hiding
    layers — firmware → hypervisor → kernel → library → application — are also
    a *defender's* ladder: the agent is application-layer (weakest), the
    scheduled task/registry are library-layer equivalents, and PBL is the
    firmware layer. Every hardening step should push enforcement *down* that
    ladder.

16. **Authentication, HMAC, and TPM are the crypto the agent already uses.**
    MOS §9.5 (secret/public-key, one-way functions, digital signatures,
    §9.5.5 TPM) + §9.6 (authentication). **Agent consequence:**
    `sign_headers` HMAC-signs every request (agent.py:1099-1124); state files
    are DPAPI-encrypted + HMAC keyed to the machine GUID (state_crypto.py:5-13,
    so a file copied to another machine won't verify) and optionally TPM-sealed
    (agent.py:2874-2879) — these are the §9.5 building blocks applied to
    tamper-evidence. The recovery-key file wraps the Fernet key under the
    server's RSA public key (agent.py:1548-1571) — classic §9.5.2 public-key
    envelope. Gap vs §9.10.3 (code signing): `check_for_update`/
    `download_update` verify a SHA-256 delivered over the same authenticated
    TLS channel that delivers the update URL (agent.py:3024-3040) — there is no
    *independent* signature on the binary, so server compromise ⇒ agent
    replacement. A detached signature (or signed manifest bound to a pinned
    pubkey) is the book-consistent fix for E-AUTO-UPDATE.

17. **Covert channels cut both ways.** MOS §9.4.2 (covert channels):
    information can leak through shared-resource side effects, not just files.
    **Agent consequence:** (a) the agent's own covertness — checkin cadence,
    DNS lookups, and TLS flows are observable to a thief watching the network;
    `--silent` hides console output, not traffic. (b) The duress hidden-file
    trigger (duress.py:76-105, `.system_cache_cleanup` in the state dir) is a
    deliberate *covert channel into* the agent — anyone with filesystem write
    access to the state dir can trigger lockdown; ACL-hardening the state dir
    (tamper_protection.py) is what keeps that channel owner-only. (c) A thief
    could plant the same trigger — the file is unauthenticated; a forged
    lockdown is fail-secure here, but it is a denial-of-use vector worth noting.

18. **Checkpointing = the agent's crash-consistency story.** MOS 4e §7.11.3 /
    5e §7.9.3 cover VM checkpointing (snapshot state so a failure can resume);
    the same primitive at file granularity is stable storage (§5.4.5) +
    journaling (§4.3.6). **Agent consequence:** the agent implements it as
    layered checkpoints: `write_pending_ack` before `encrypt_folder` (durability
    boundary, agent.py:1732-1738), RSA-wrapped recovery blob (long-lived
    checkpoint), SQLite offline queue (persistent outbox,
    agent.py:1306-1396), `tracking_state.json` enabling reversal
    (agent.py:2259-2270), and watchdog `.bak` restore on failed update
    (watchdog.py:165-193). The remaining fragility is that several of these
    live in the same `_STATE_DIR` — a thief who finds the directory finds the
    whole checkpoint set; ADS (fact 6) or an unlinked/obfuscated second
    location would spread the risk.

## Glossary terms (agent-relevant subset)

- **TCB (Trusted Computing Base):** the hardware/software set whose compromise
  breaks security. The agent sits *outside* the TCB; the admin thief sits inside.
- **Process table / task list:** kernel data structure enumerating all
  processes; every user-mode "list processes" call is a filtered view of it.
- **procfs / `/proc`:** Linux pseudo-filesystem exposing kernel task data as
  `/proc/<pid>`; `hidepid=2` hides others' PIDs from users, never from root.
- **Toolhelp snapshot:** Windows `CreateToolhelp32Snapshot` — read-only copy of
  the kernel's process/thread/module/heap lists.
- **ETW:** kernel-level event tracing; process/file/registry events are
  observable to any admin consumer — agent stealth can't hide from it.
- **Page-table protection bits / `mprotect` / `VirtualProtect`:** per-process
  page permissions; meaningless against an admin who can open the process from
  outside.
- **Journaling / stable storage:** write-ahead log that makes metadata updates
  atomic; also preserves deleted data in the journal (forensic residue).
- **ADS (Alternate Data Stream):** named `$DATA` streams on an NTFS file —
  storage invisible to normal directory listings; used legitimately by EFS
  (`$EFS:$LOGGED_UTILITY_STREAM`) and abusively by malware/thieves.
- **Slack space:** bytes between end-of-file and end-of-cluster; retains old
  content — both a hiding place and a forensics source.
- **Secure desktop / SAS:** the Winlogon-owned desktop that receives
  Ctrl+Alt+Del; user-mode code cannot intercept it — the ceiling on what a
  user-mode lock screen can do.
- **Priority class / nice / `SCHED_*`:** scheduler inputs the kernel (or an
  admin) can override; no user-mode uptime guarantee.
- **Watchdog timer:** a countdown that must be patted or it fires; `watchdog.py`
  is the classic form, `check_deadman` is the inverted form (absence of
  heartbeat ⇒ fire).
- **Safe Mode / `SafeBoot\Minimal`:** a service whitelist boot; scheduled tasks
  don't run — the thief's cheapest persistence bypass.
- **Popek-Goldberg criteria:** sensitive ⊑ privileged instructions ⇒
  virtualizable; hypervisor presence is detectable via `CPUID.1:ECX[31]` +
  leaves `0x40000000+`.
- **Covert channel:** information flow outside intended channels — the duress
  trigger file is one *into* the agent; checkin traffic is one *out of* it.
- **TOCTOU:** check-then-use race; neutralized by atomic `O_CREAT|O_EXCL`
  sentinel and tmp+rename writes.
- **Capabilities (Linux) / privileges (Windows):** fine-grained rights
  (`CAP_SYS_PTRACE`, `SeTakeOwnershipPrivilege`) that make "admin" mean "can
  undo the agent."

## Security implications

- **User-mode agent vs. admin is an asymmetric fight the agent cannot win
  outright** — every agent self-defense is friction (ACL denial, restart loops,
  tamper detection), and every attacker action is at most one extra step
  (take ownership, boot Safe Mode, snapshot the VM). The architecture's real
  anchors are: (a) fail-secure defaults (`startup_check`: missing sentinel +
  deadman "stolen" ⇒ re-lock, agent.py:2725-2757; corrupt deadman ⇒ treat as
  stolen, agent.py:2799-2802), (b) redundancy of state (sentinel + deadman +
  tracking_state + pending_ack + recovery blob), and (c) out-of-band truth
  (server-side stolen flag; PBL pre-OS enforcement).
- **The deadman clock is spoofable.** `time.time()` is admin-controlled;
  treat `now < last_seen` as tamper (fire) rather than benign.
- **Auto-update is a binary-replacement channel.** SHA-256-over-TLS verifies
  transport integrity, not provenance; §9.10.3 code signing is the missing
  primitive for E-AUTO-UPDATE.
- **Stealth ≠ concealment.** A thief running `tasklist`, `schtasks /query`,
  or ETW sees `SystemHealthMonitor` and `lockdown-watchdog.exe`; stealth buys
  time against a *casual* thief only. Any process-level "am I hidden" check is
  pointless — invest in restart-and-report instead.
- **Encryption is the only control that survives offline disk access.**
  Safe Mode, boot-from-USB, and disk-imaging all bypass every user-mode
  mechanism; E-ENCRYPT + PBL/BCD boot lockdown are the compensations.
- **Key-at-rest exposure is inherent.** `key_material` in `.pending_ack` and
  `DEADMAN_KEY_FILE` are plaintext on a journaled FS; they exist precisely
  because the agent cannot trust memory or connectivity — acceptable only
  because the recovery path needs them; journal residue means "deleted" keys
  may still be recoverable.
- **VM relocation is detectable and rollback-safe.** `CPUID` hypervisor bit +
  vendor leaves are one cheap syscall's worth of telemetry; snapshot rollback
  moves `last_seen` backward ⇒ deadman fires sooner, provided status was
  already `stolen`.

## PBL/agent-specific relevance (function → mechanism → enforcement path)

| Agent code | MOS concept | Enforcement path |
|---|---|---|
| `encrypt_folder` / `decrypt_folder` (agent.py:504-583); `cipher /e` EFS (`_run_cipher`, :2378) | FS implementation (§4.3), EFS `$EFS` stream, journaling | E-ENCRYPT, E-DECRYPT, E-TRACK (layer 3) |
| `_lock_workstation` + overlay + `_lock_guardian_loop` (:646-807) | I/O device model (ch. 5), session/desktop isolation, SAS ceiling | E-LOCK-SCREEN, E-GUARDIAN |
| `handle_track` (:2237), `apply_tracking_data_protection` (:2464), decoy account (:2494-2517) | spyware taxonomy (§9.9.4), insider/back-door analog (§9.8.2) | E-TRACK |
| `ensure_tracking_stealth` (:2629), `service_installer` schtasks `/RU SYSTEM` | scheduling/persistence; SafeBoot whitelist bypass risk | E-TRACK, E-GUARDIAN |
| `_is_watchdog_running` tasklist/pgrep (:3132-3155), `check_watchdog_health` (:3201), `watchdog.py` heartbeat (:59-62, :234-257) | process table visibility (§2.1.6); watchdog timers ([SUB] kernel/systemd) | E-GUARDIAN, E-DEADMAN |
| `check_deadman` / `update_deadman_timer` / `_read_deadman_state` (:2766-2941) | inverted watchdog; stable storage; fail-secure on corrupt | E-DEADMAN |
| `queue_offline` / `drain_offline_queue` (:1306-1396), `_atomic_write_text` (:1414), `write_pending_ack` (:1426) | journaling (§4.3.6), stable storage (§5.4.5), atomic commit | E-OFFLINE-QUEUE, E-ACK |
| `check_for_update` / `download_update` (:3003-3107), watchdog hot-swap (:127-202) | code signing (§9.10.3) — currently hash-only | E-AUTO-UPDATE |
| `check_tamper` + `icacls DENY DELETE` (tamper_protection.py:73-98) | ACLs (§9.3.2) as friction; model-based IDS (§9.10.5) | all E-* (meta-protection) |
| `sign_headers` HMAC (:1099), DPAPI+HMAC state (state_crypto), `tpm_seal` | crypto basics (§9.5), TPM (§9.5.5 → see STUDY-TPM-2.0) | E-ACK, E-DEADMAN, E-RECOVERY |
| `os.open(O_CREAT\|O_EXCL)` sentinel (:1712), tmp+fsync+rename | TOCTOU (§9.7.7) | E-ENCRYPT, E-GUARDIAN |
| hidden trigger `.system_cache_cleanup` (duress.py:76-105) | covert channels (§9.4.2) | covert lockdown path |
| (absent) VM detection, `CPUID.1:ECX[31]` | virtualization (ch. 7), Popek-Goldberg | new telemetry for E-TRACK |
| `bcd_lockdown` recovery/F8/WinRE disable (bcd_lockdown.py:320-332) | SafeBoot whitelist (Safe Mode kills agent) | E-BCD — closes the agent's weakest bypass |

## Chapters deliberately skipped

- **Ch. 6 Deadlocks** — skipped except starvation/livelock (§6.7.3-6.7.4):
  the mutual watchdog can in principle livelock (both killed in the same
  window — the thief's ideal attack is killing agent *and* watchdog *and*
  disabling the task in one Safe Mode session).
- **Ch. 8 Multiple Processor Systems** — no lockdown relevance (SMP
  scheduling/multicomputers/middleware); multiprocessor scheduling changes
  nothing about the admin-can-kill-you asymmetry.
- **Ch. 10/11 case studies** — partially used (Linux `/proc`, NTFS streams,
  Windows security) but detailed Windows internals are already covered in
  `STUDY-WINDOWS-NT-INTERNALS.md`; not duplicated here. 5e swaps the Windows 8
  case study for Windows 11.
- **Ch. 12/13 OS design + reading list** — design philosophy only.
- **Multimedia chapter** — moved online in 4e; no relevance.
- **Ch. 1** — used only for the mode-bit/syscall/TCB framing (facts 1, 13).

## Known limitations / unverified

1. **Section numbers are 4e.** 5e re-numbers ch. 7 subsections (e.g.,
   checkpointing 4e §7.11.3 → 5e §7.9.3; VMware case study 4e §7.12 → 5e
   §7.11) and adds §7.10 OS-level virtualization (containers). Claims are
   anchored to section *topics* visible in the linked TOCs, not to page
   numbers (none fabricated).
2. **MOS does not cover watchdog timers, Safe Mode, Toolhelp, ETW, ADS, DPAPI,
   or service-recovery APIs** — every one of those sections above is a labeled
   substitution ([SUB]) with a primary source, not book content.
3. **VM-detection claim is a design recommendation, not verified** — there is
   no `cpuid`/VM check in agent.py today; effectiveness of `CPUID` detection
   against a thief who configures the hypervisor to mask it is untested.
4. **Deadman clock-spoof analysis is theoretical** — `time.time() <
   last_seen` ⇒ tamper is a proposed check; not implemented in
   `check_deadman` (agent.py:2906 uses simple subtraction).
5. **ADS storage for state files is a proposal** — agent does not currently
   write state into alternate streams; feasibility (icacls on streams,
   antivirus scanning of ADS) unverified.
6. **"AV may flag the agent" is a risk statement, not observed** — no
   empirical AV-detection data in the repo.
7. **Camera/mic capture is not implemented** — the privacy-gate analysis
   applies only to a hypothetical evidence-capture feature.
8. **Journal-residue exposure of `key_material`/`DEADMAN_KEY_FILE` is inferred**
   from journaling FS behavior (§4.3.6) + NIST SP 800-86; not demonstrated on
   the deployment targets.

## Cross-references to previously studied sources

- `STUDY-WINDOWS-NT-INTERNALS.md` — the kernel-side details this note defers
  to: object manager, SRM/`SeAccessCheck`, process/active-list internals
  (DKOM substrate), VAD/memory manager, boot-start driver ordering, BCD.
- `STUDY-TPM-2.0.md` — TPM sealing behind `tpm_seal.py` (MOS §9.5.5 is the
  textbook version; that note is the spec-level version).
- `STUDY-UEFI-BOOTKITS.md` — the firmware/hypervisor tiers of the §9.9.5
  rootkit ladder (LoJax, MoonBounce, CosmicStrand) that host-side checks
  cannot detect; PBL's reason to exist.
- `.devin/graph/GRAPH-SPEC.yaml` — enforcement-path definitions (E-TRACK,
  E-DEADMAN, E-GUARDIAN, E-AUTO-UPDATE, E-OFFLINE-QUEUE, E-BCD) mapped above.

## Self-test (OS internals → agent hardening)

| # | Question | Answer | Confidence |
|---|----------|--------|------------|
| 1 | Why can't the agent prevent an admin from killing it? | Process killing is a kernel service; the admin can issue the same syscalls or load kernel code — the agent is outside the TCB it's trying to defend. | High |
| 2 | Why does stealth naming (`SystemHealthMonitor`) still show up to a thief? | All process listings (Toolhelp snapshot, `/proc`, ETW) are views of the kernel process table; only a kernel rootkit removes a row. | High |
| 3 | Why is `wipe_key` hygiene rather than defense? | An admin can read the agent's memory at any time via `WriteProcessMemory`/`ReadProcessMemory` or `/proc/pid/mem`; wiping only narrows the window. | High |
| 4 | What makes `pending_ack` crash-safe? | tmp-file + fsync + atomic rename — the stable-storage/journaling pattern: never a torn state, replayable on restart. | High |
| 5 | What is the thief's cheapest persistence bypass? | Safe Mode — the Task Scheduler isn't a `SafeBoot\Minimal` service, so neither the agent task nor watchdog starts; countered by BCD lockdown (no F8/WinRE) and sentinel re-lock on next normal boot. | High |
| 6 | Why is `check_deadman` an "inverted watchdog"? | A watchdog fires when a heartbeat *stops*; the deadman fires when a *server contact* has been absent for 24h while flagged stolen — the absence of the pat is the trigger. | High |
| 7 | How can a thief defeat the deadman timer without deleting anything? | Set the wall clock forward so `time.time() - last_seen` goes negative — the timer never reaches 24h. Fix: treat `now < last_seen` as tamper ⇒ fire. | Medium (proposed, unimplemented) |
| 8 | Why is auto-update a binary-replacement risk? | The SHA-256 is fetched over the same TLS channel as the binary — provenance isn't independently signed; §9.10.3 code signing is the missing primitive. | High |
| 9 | Can the agent detect being moved into a VM? | Yes — `CPUID.1:ECX[31]` hypervisor bit + vendor leaves `0x40000000+`; should be telemetry (report), never a refusal-to-run (that's T1497 malware behavior). | Medium (not implemented) |
| 10 | What does §9.9.5's rootkit ladder mean for the agent? | Firmware > hypervisor > kernel > library > application: the agent lives at the weakest layer, so hardening means pushing enforcement down (scheduled task/service → ACLs → PBL firmware) and accepting detection+re-assertion at the top. | High |

## Outstanding questions

1. Should `check_deadman` add `now < last_seen ⇒ tamper` (clock rollback/forward
   detection)? Needs a decision on false-positive risk when the RTC is wrong at
   install time.
2. Should agent state files move into an ADS or a second obfuscated location so
   that `check_tamper`'s file list isn't a single-directory map for the thief?
3. Should `checkin` report `vm_present` (CPUID bit + vendor leaf + MAC OUI) as
   telemetry for E-TRACK, and should the deadman timer treat snapshot-rollback
   (heartbeat file age regression) as a signal?
4. Should E-AUTO-UPDATE gain a detached-signature check (pinned public key in
   the agent) instead of channel-delivered SHA-256?
5. On Linux/macOS, should `service_installer` emit a `systemd` unit with
   `WatchdogSec=`/`Restart=always` and a `launchd` plist with `KeepAlive` to
   replace the pgrep-based babysitter?
6. Is AV/EDR classification of the agent an observed problem on real targets?
   (Determines whether code-signing + publisher consistency is P0.)
