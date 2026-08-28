"""
Duress Code + Hidden File Trigger
----------------------------------
Covert lockdown trigger mechanisms for the Remote Lockdown System.

Two covert mechanisms that let the owner trigger a *silent* lockdown
without going through the normal dashboard "Flag as Stolen" flow:

1. **Duress Code** — when the admin sends an unlock command with a
   ``duress_code`` field, the agent *pretends* to unlock (shows the
   normal desktop) but silently re-encrypts files with a new key after
   a short delay, sends the new key to the Worker, and re-locks after
   5 minutes.  This is invisible to anyone watching the screen — the
   machine appears fully unlocked.

   Use case: a thief forces the owner to unlock the machine, or the
   owner wants to remotely trigger a lockdown without the dashboard.

2. **Hidden File Trigger** — if a file named ``.system_cache_cleanup``
   appears in the agent's state directory, the agent immediately
   triggers lockdown.  The file name looks like a system cache file
   (not suspicious).  Only the owner knows to create this file (e.g.,
   via remote desktop, SSH, or another machine with access).  After
   triggering lockdown the file is deleted.

Design constraints:
  - The duress code path must be **completely invisible**: no UI
    indication, no logs visible to the user (agent logs go to stdout
    which is suppressed in ``--silent`` mode).
  - Normal unlock (no ``duress_code`` field) must work exactly as
    before — the duress check is a no-op when the field is absent.
  - Platform-specific code (lock screen, boot lockdown) is delegated
    back to ``agent.py`` via injected callbacks so this module stays
    platform-agnostic and testable on Linux.
"""

from __future__ import annotations

import json
import logging
import threading
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    pass

log = logging.getLogger("lockdown-duress")

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

# Hidden trigger file name — looks like a system cache cleanup marker.
# Placed in the agent's state directory (same dir as sentinel/deadman).
HIDDEN_TRIGGER_FILENAME = ".system_cache_cleanup"

# Duress re-encryption delay (seconds).  The agent waits this long after
# the fake unlock before silently re-encrypting files.  This gives the
# person watching the screen time to see the "unlocked" desktop and walk
# away.
DURESS_REENCRYPT_DELAY = 60

# Duress re-lock delay (seconds).  After re-encryption, the agent waits
# this long before re-applying the lock screen.  Total visible-unlocked
# window ≈ DURESS_REENCRYPT_DELAY + DURESS_RELOCK_DELAY.
DURESS_RELOCK_DELAY = 300


# ---------------------------------------------------------------------------
# Hidden file trigger
# ---------------------------------------------------------------------------


def hidden_trigger_path(state_dir: Path) -> Path:
    """Return the full path of the hidden trigger file in *state_dir*."""
    return Path(state_dir) / HIDDEN_TRIGGER_FILENAME


def check_hidden_trigger(state_dir: Path) -> bool:
    """Check whether the hidden trigger file exists.

    Returns ``True`` if the covert trigger file is present, ``False``
    otherwise.  This is called on every iteration of the agent's main
    loop — it must be cheap (a single ``stat``).
    """
    return hidden_trigger_path(state_dir).exists()


def consume_hidden_trigger(state_dir: Path) -> bool:
    """Delete the hidden trigger file after it has been acted upon.

    Returns ``True`` if the file was deleted, ``False`` if it did not
    exist.  Uses ``os.unlink`` directly (the file is a plain marker —
    no content to shred).
    """
    path = hidden_trigger_path(state_dir)
    try:
        path.unlink()
        return True
    except FileNotFoundError:
        return False
    except OSError as e:
        log.warning("Could not delete hidden trigger file %s: %s", path, e)
        return False


# ---------------------------------------------------------------------------
# Duress code detection
# ---------------------------------------------------------------------------


def is_duress_unlock(command: dict) -> bool:
    """Return ``True`` if *command* is a duress-code unlock.

    A duress unlock is an ``unlock`` command that carries a truthy
    ``duress_code`` field.  Normal unlocks omit the field entirely, so
    this function returns ``False`` for them — the existing unlock flow
    is unaffected.
    """
    return bool(command.get("duress_code"))


# ---------------------------------------------------------------------------
# Duress re-encryption engine
# ---------------------------------------------------------------------------

# Module-level handle so tests can join/cancel the background thread.
_duress_thread: threading.Thread | None = None
_duress_thread_stop: threading.Event | None = None


def start_duress_relock(
    cfg: dict,
    command: dict,
    *,
    encrypt_fn: Callable[[Path, bytes], list[str]],
    generate_key_fn: Callable[[], bytes],
    apply_lock_screen_fn: Callable[[], None],
    start_lock_guardian_fn: Callable[[], None],
    sentinel_path: Path,
    lockdown_folder: Path,
    report_key_fn: Callable[[str, str], bool] | None = None,
    reencrypt_delay: float = DURESS_REENCRYPT_DELAY,
    relock_delay: float = DURESS_RELOCK_DELAY,
) -> threading.Thread:
    """Launch a background thread that silently re-encrypts and re-locks.

    This is the core of the duress-code flow.  It is called from
    ``handle_unlock`` *after* the fake unlock (decrypt + remove lock
    screen) has completed, so the desktop appears normal.  The thread
    then:

    1. Waits ``reencrypt_delay`` seconds (default 60s).
    2. Generates a new Fernet key and re-encrypts ``lockdown_folder``.
    3. Writes the sentinel so the lock persists across reboots.
    4. Reports the new key to the Worker via ``report_key_fn``.
    5. Waits ``relock_delay`` seconds (default 300s).
    6. Re-applies the lock screen + lock guardian.

    All callbacks are injected so this module stays platform-agnostic
    and testable without Windows-specific imports.

    Args:
        cfg: The agent config dict (passed through to callbacks).
        command: The original unlock command dict (for command_id).
        encrypt_fn: ``agent.encrypt_folder`` — ``(folder, key) -> blocked_files``.
        generate_key_fn: ``agent.generate_key`` — ``() -> bytes``.
        apply_lock_screen_fn: ``agent.apply_lock_screen``.
        start_lock_guardian_fn: ``agent.start_lock_guardian``.
        sentinel_path: Path to the lock sentinel file.
        lockdown_folder: Path to the folder to re-encrypt.
        report_key_fn: Optional callback ``(command_id, key_b64) -> bool``
            that uploads the new key to the Worker.  If ``None`` the key
            is not reported (used in tests).
        reencrypt_delay: Seconds to wait before re-encrypting (test override).
        relock_delay: Seconds to wait before re-locking (test override).

    Returns:
        The started ``threading.Thread`` (daemon).
    """
    global _duress_thread, _duress_thread_stop

    # Cancel any previously running duress thread (defensive — should
    # not happen in practice).
    stop_duress_thread()

    stop_event = threading.Event()
    _duress_thread_stop = stop_event
    command_id = command.get("id", "duress")

    def _duress_worker() -> None:
        try:
            # Phase 1: visible-unlock window — wait before re-encrypting.
            if stop_event.wait(reencrypt_delay):
                return  # cancelled

            log.info("Duress: re-encrypting files with new key")
            new_key = generate_key_fn()
            key_b64 = new_key.decode()

            try:
                encrypt_fn(lockdown_folder, new_key)
            except Exception as e:
                log.error("Duress: re-encryption failed: %s", e)
                return
            finally:
                # Zero the key bytes (best-effort).
                try:
                    import ctypes

                    buf = (ctypes.c_char * len(new_key)).from_buffer(new_key)
                    ctypes.memset(buf, 0, len(new_key))
                except Exception:  # noqa: S110 - best-effort key wipe, failure is non-critical
                    pass

            # Write sentinel so lock persists across reboots.
            try:
                _atomic_write_json(sentinel_path, {"locked": True, "duress": True})
            except Exception as e:
                log.warning("Duress: could not write sentinel: %s", e)

            # Report the new key to the Worker so the admin can recover.
            if report_key_fn is not None:
                try:
                    report_key_fn(command_id, key_b64)
                except Exception as e:
                    log.warning("Duress: could not report new key to server: %s", e)
            del key_b64

            # Phase 2: wait before re-applying the lock screen.
            if stop_event.wait(relock_delay):
                return  # cancelled

            log.info("Duress: re-applying lock screen")
            apply_lock_screen_fn()
            start_lock_guardian_fn()
        except Exception as e:
            log.error("Duress thread crashed: %s", e)

    _duress_thread = threading.Thread(target=_duress_worker, daemon=True)
    _duress_thread.start()
    log.info(
        "Duress re-lock thread started (reencrypt=%ds, relock=%ds)",
        reencrypt_delay,
        relock_delay,
    )
    return _duress_thread


def stop_duress_thread() -> None:
    """Signal the duress background thread to stop (if running)."""
    global _duress_thread, _duress_thread_stop
    if _duress_thread_stop is not None:
        _duress_thread_stop.set()
    if _duress_thread is not None and _duress_thread.is_alive():
        _duress_thread.join(timeout=5)
    _duress_thread = None
    _duress_thread_stop = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    """Write a JSON dict to *path* atomically (temp + rename)."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)
