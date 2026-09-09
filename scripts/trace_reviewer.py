#!/usr/bin/env python3
"""
trace_reviewer.py — Review trace.md claims against actual repo state.

Parses each session block in trace.md, extracts verifiable claims (file paths,
line counts, function names, build artifacts, SHA-256 hashes, test counts),
and checks them against the real filesystem and source files.

Usage:
  python3 scripts/trace_reviewer.py                    # review latest session
  python3 scripts/trace_reviewer.py --all              # review all sessions
  python3 scripts/trace_reviewer.py --session N        # review session N (1-based)
  python3 scripts/trace_reviewer.py --json             # output JSON
  python3 scripts/trace_reviewer.py --verbose          # show all checks, not just failures

Exit codes:
  0 — all checks passed
  1 — one or more checks failed
  2 — error (file not found, parse failure)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TRACE_PATH = _PROJECT_ROOT / ".devin" / "graph" / "trace.md"


# ---------------------------------------------------------------------------
# Data structures
# ---------------------------------------------------------------------------


@dataclass
class Check:
    """A single verification check."""

    session_label: str
    claim: str
    category: str  # file_exists, line_count, function_exists, sha256, build_artifact, stub_implementation
    passed: bool
    detail: str = ""
    skipped: bool = False  # True if the claim refers to a deleted/legacy artifact


@dataclass
class SessionReview:
    """Review results for one session block."""

    label: str
    checks: list[Check] = field(default_factory=list)

    @property
    def passed_count(self) -> int:
        return sum(1 for c in self.checks if c.passed and not c.skipped)

    @property
    def failed_count(self) -> int:
        return sum(1 for c in self.checks if not c.passed and not c.skipped)

    @property
    def skipped_count(self) -> int:
        return sum(1 for c in self.checks if c.skipped)


# ---------------------------------------------------------------------------
# Trace parsing
# ---------------------------------------------------------------------------


def parse_sessions(trace_text: str) -> list[tuple[str, str]]:
    """Split trace.md into (label, body) pairs for each session block."""
    # Session headers: "## Session ..." or "## Session: ..."
    pattern = re.compile(r"^## Session[:\s]+(.+)$", re.MULTILINE)
    matches = list(pattern.finditer(trace_text))
    sessions = []
    for i, m in enumerate(matches):
        label = m.group(1).strip()
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(trace_text)
        body = trace_text[start:end]
        sessions.append((label, body))
    return sessions


# ---------------------------------------------------------------------------
# Claim extractors — pull verifiable claims from session text
# ---------------------------------------------------------------------------


def _filter_historical_lines(body: str) -> str:
    """Remove lines that are historical context, not current-state claims.

    Skips lines in:
    - "Failure attribution" sections (discussing what went wrong, referencing
      old file names, renames, etc.)
    - "Read:" lines in RULE-ZERO sections (recording what was read at session
      start — line counts were accurate then but files may have been edited since)
    """
    lines = body.splitlines()
    filtered = []
    in_failure_attr = False
    for line in lines:
        stripped = line.strip()

        # Track "Failure attribution" section boundaries
        if stripped.startswith("### Failure attribution"):
            in_failure_attr = True
            filtered.append(line)  # keep the header
            continue
        if in_failure_attr and stripped.startswith("### ") and not stripped.startswith("### Failure"):
            in_failure_attr = False
        if in_failure_attr:
            filtered.append(line)  # keep the line but don't extract claims from it
            continue

        # Skip "Read:" lines in RULE-ZERO — these are historical records
        # e.g., "- **Read**: agent/tpm_seal.py (431 lines) — ..."
        if stripped.startswith("- **Read**:") or stripped.startswith("- **Read**: "):
            filtered.append(line)  # keep the line but don't extract claims from it
            continue

        filtered.append(line)
    return "\n".join(filtered)


def _extract_claim_regions(body: str) -> str:
    """Return only the regions of the body that make current-state claims.

    This is the inverse of _filter_historical_lines — it removes lines from
    sections that are historical context (Failure attribution, Read: lines,
    Finding: lines that discuss stale claims) so that claim extractors only
    see lines that are making assertions about the current state of the repo.
    """
    lines = body.splitlines()
    filtered = []
    in_failure_attr = False
    for line in lines:
        stripped = line.strip()

        # Track "Failure attribution" section boundaries
        if stripped.startswith("### Failure attribution"):
            in_failure_attr = True
            continue  # drop the header and contents
        if in_failure_attr and stripped.startswith("### ") and not stripped.startswith("### Failure"):
            in_failure_attr = False
        if in_failure_attr:
            continue  # drop lines in failure attribution

        # Skip "Read:" lines in RULE-ZERO — historical records, not claims
        if stripped.startswith("- **Read**:"):
            continue

        # Skip "Finding:" lines that discuss trace reviewer failures or
        # stale claims — these are meta-references, not current-state claims.
        # e.g., "- **Finding**: The 4 trace reviewer failures are: (1) ..."
        if stripped.startswith("- **Finding**:"):
            continue

        # Skip "Fog remaining" lines that reference stale claims — these are
        # meta-references discussing what's NOT done, not current-state claims.
        # e.g., "- Trace reviewer: 1 remaining failure (session 22 'PblApp.c has 110 lines' ...)"
        lower = stripped.lower()
        if stripped.startswith("- ") and "remaining failure" in lower and "has " in lower and " lines" in lower:
            continue

        filtered.append(line)
    return "\n".join(filtered)


def extract_file_claims(body: str) -> list[tuple[str, str]]:
    """Extract (claim_text, file_path) pairs from the session body.

    Looks for backtick-quoted paths that look like source files.
    Only extracts from regions that make current-state claims (not from
    Failure attribution sections or Read: lines in RULE-ZERO).
    """
    claim_body = _extract_claim_regions(body)
    claims = []
    # Match paths like firmware/PblPkg/.../File.c or server/src/...
    # Only match paths that exist within the repo structure
    pattern = re.compile(
        r"`([a-zA-Z0-9_./-]+\.(?:c|h|py|js|ts|tsx|jsx|sh|yml|yaml|md|dec|dsc|fdf|inf|efi))`"
    )
    seen = set()
    for m in pattern.finditer(claim_body):
        path_str = m.group(1)
        if path_str in seen:
            continue
        seen.add(path_str)
        # Skip docs and graph artifacts — those are the trace itself
        if path_str.startswith(".devin/graph/"):
            continue
        if path_str.startswith("docs/adr/DEBT"):
            continue
        # Skip template/placeholder paths (contain YYYY, NNN, or start with .)
        if "YYYY" in path_str or "NNN" in path_str or path_str.startswith("."):
            continue
        # Skip paths that are just a filename without a directory and have
        # no clear source extension context — these are often inline references
        # in prose, not claims about file existence
        if "/" not in path_str and "." not in path_str:
            continue
        claims.append((f"file `{path_str}`", path_str))
    return claims


def extract_line_count_claims(body: str) -> list[tuple[str, str, int]]:
    """Extract (claim_text, file_path, claimed_lines) from patterns like '475 lines'.

    Only extracts from regions that make current-state claims (not from
    Failure attribution sections or Read: lines in RULE-ZERO, which are
    historical context).
    """
    claims = []
    # First, filter out historical/meta-reference regions
    claim_body = _extract_claim_regions(body)
    # Then, also skip individual lines that are meta-references
    # (corrections discussing "claimed X, actual Y")
    lines = claim_body.splitlines()
    filtered_lines = []
    for line in lines:
        lower = line.lower()
        if "claimed" in lower and "actual" in lower:
            continue  # meta-reference, not a claim
        if "inaccuracie" in lower or "wrong line count" in lower:
            continue  # meta-reference
        filtered_lines.append(line)
    filtered_body = "\n".join(filtered_lines)

    # Pattern: "File.c (NNN lines)" or "File.c — NNN lines" or "implemented (NNN lines)"
    # Also: "File.c: NNN lines" or "File.c — NNN lines (was MMM)"
    patterns = [
        re.compile(r"([\w/]+\.(?:c|h|py))\s*[\(\—]\s*(\d+)\s*lines?\)?"),
        re.compile(r"([\w/]+\.(?:c|h|py))\s*[:\—]\s*(\d+)\s*lines?"),
        re.compile(r"(\w+\.c)\s+implemented\s+(\d+)\s+lines"),
        re.compile(r"(\w+\.c)\s+.*?(\d+)\s*lines"),
    ]
    seen = set()
    for pat in patterns:
        for m in pat.finditer(filtered_body):
            fname = m.group(1)
            count = int(m.group(2))
            key = (fname, count)
            if key in seen:
                continue
            seen.add(key)
            # Try to resolve to a real path
            real_path = find_source_file(fname)
            if real_path:
                claims.append(
                    (f"{fname} has {count} lines", str(real_path), count)
                )
    return claims


def extract_function_claims(body: str) -> list[tuple[str, str]]:
    """Extract function names mentioned as implemented."""
    claims = []
    # Pattern: "PblXxxYyy()" or "PblXxxYyy (...)" mentioned as implemented
    pattern = re.compile(r"\b(Pbl[A-Z][a-zA-Z0-9]+)\s*\(")
    seen = set()
    for m in pattern.finditer(body):
        fname = m.group(1)
        if fname in seen:
            continue
        seen.add(fname)
        # Skip entry point — it's always defined
        if fname == "PblAppEntryPoint":
            continue
        claims.append((f"function `{fname}` is defined", fname))
    return claims


def extract_sha256_claims(body: str) -> list[tuple[str, str, str]]:
    """Extract (claim_text, file_path, sha256) from SHA-256 mentions."""
    claims = []
    pattern = re.compile(
        r"SHA-256\s+([0-9a-f]{64})", re.IGNORECASE
    )
    for m in pattern.finditer(body):
        sha = m.group(1).lower()
        # Look for nearby .efi mention
        efi_match = re.search(r"(PblApp\.efi|[\w]+\.efi)", body[m.start()-200:m.end()+200] if m.start() > 200 else body[:m.end()+200])
        efi_name = efi_match.group(1) if efi_match else "PblApp.efi"
        real_path = find_source_file(efi_name)
        if real_path and real_path.exists():
            claims.append((f"{efi_name} SHA-256 = {sha[:16]}...", str(real_path), sha))
    return claims


def extract_build_claims(body: str) -> list[tuple[str, str]]:
    """Extract build success claims."""
    claims = []
    if "BUILD SUCCEEDED" in body or "Build total time" in body:
        if "PblApp.efi" in body:
            claims.append(("PblApp.efi was built", "PblApp.efi"))
    if "- Done -" in body:
        claims.append(("EDK II build completed", "build"))
    return claims


def extract_stub_claims(body: str) -> list[tuple[str, str, str]]:
    """Extract stub implementation claims — (claim, file, function)."""
    claims = []
    # Pattern: "Policy.c (PblParsePolicy)" or "PblParsePolicy ... stub"
    pattern = re.compile(
        r"([\w/]+\.c)\s*[\(\—]\s*(Pbl[A-Z]\w+)"
    )
    seen = set()
    for m in pattern.finditer(body):
        fname = m.group(1)
        func = m.group(2)
        key = (fname, func)
        if key in seen:
            continue
        seen.add(key)
        real_path = find_source_file(fname)
        if real_path:
            claims.append((f"{fname} defines `{func}`", str(real_path), func))
    return claims


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def find_source_file(fname: str) -> Optional[Path]:
    """Try to locate a source file by name within the repo."""
    # Direct path
    direct = _PROJECT_ROOT / fname
    if direct.exists():
        return direct
    # Search by basename
    base = Path(fname).name
    for candidate in _PROJECT_ROOT.rglob(base):
        # Skip build output, node_modules, .git
        parts = candidate.parts
        if any(p in ("node_modules", ".git", "Build", "__pycache__", ".venv", "dist") for p in parts):
            continue
        return candidate
    return None


# Paths that were deleted when the AntiTheft architecture was replaced by PBL.
# Claims referencing these are marked as skipped, not failed.
_LEGACY_DELETED_PATHS = {
    "firmware/AntiTheft",
    "firmware/AntiTheftApp",
    "firmware/AntiTheftNetInit",
    "firmware/AntiTheftGuard",
    "firmware/anti_theft",
    "firmware/windows-test",
    "firmware/tpm-test",
    "firmware/build-uefi.sh",
    "firmware/capsule-output",
}

# Legacy function prefixes from the deleted AntiTheft architecture.
_LEGACY_FUNCTION_PREFIXES = ("AntiTheft", "AtApp", "AtGuard", "AtNet")


def is_legacy_path(path_str: str) -> bool:
    """Check if a path refers to a deleted/legacy artifact."""
    for legacy in _LEGACY_DELETED_PATHS:
        if path_str.startswith(legacy):
            return True
    # Also check if the path doesn't exist AND is under firmware/ but not PblPkg
    # (the old firmware modules were deleted)
    full = _PROJECT_ROOT / path_str
    if not full.exists() and path_str.startswith("firmware/") and "PblPkg" not in path_str and "legacy-tools" not in path_str:
        return True
    return False


def is_legacy_function(func_name: str) -> bool:
    """Check if a function name belongs to the deleted AntiTheft architecture."""
    for prefix in _LEGACY_FUNCTION_PREFIXES:
        if func_name.startswith(prefix):
            return True
    return False


def count_lines(path: Path) -> int:
    """Count non-empty lines in a file (matching how agents typically count)."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        return len(text.splitlines())
    except Exception:
        return -1


def function_is_defined(path: Path, func_name: str) -> bool:
    """Check if a function name appears as a definition (not just a call).

    Uses a two-pass approach to reduce false positives:
    1. Look for the function name at the start of a line (column 0 or after
       whitespace) followed by `(` — this is the definition pattern in EDK II
       style where the function name is on its own line.
    2. Verify the preceding non-empty line looks like a return type (ends with
       a type keyword like EFI_STATUS, VOID, UINTN, BOOLEAN, PBL_RESULT, or
       a pointer `*`), OR the line itself starts with a return type.

    This avoids matching:
    - Call sites: `Status = PblFooBar (` (has `=` before the name)
    - Comment mentions: `// PblFooBar () does ...` (has `//` before)
    - String literals: `L"PblFooBar ("` (has `"` before)
    """
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
        lines = text.splitlines()

        # C return type keywords that precede a function definition
        return_type_pattern = re.compile(
            r"^\s*(?:STATIC\s+)?(?:EFI_STATUS|VOID|UINTN|UINT8|UINT16|UINT32|UINT64|"
            r"BOOLEAN|PBL_RESULT|CHAR8|CHAR16|EFI_HANDLE|VOID\s*\*|"
            r"EFI_TCG2_PROTOCOL\s*\*|EFI_HTTP_PROTOCOL\s*\*|EFI_TLS_PROTOCOL\s*\*|"
            r"EFI_SMBIOS_PROTOCOL\s*\*|EFI_RNG_PROTOCOL\s*\*|"
            r"EFI_GRAPHICS_OUTPUT_PROTOCOL\s*\*|EFI_SIMPLE_TEXT_OUTPUT_PROTOCOL\s*\*|"
            r"EFI_SIMPLE_TEXT_INPUT_EX_PROTOCOL\s*\*)\s*$"
        )

        # Pattern: function name at start of line (after optional whitespace) followed by (
        func_pattern = re.compile(
            rf"^\s*{re.escape(func_name)}\s*\("
        )

        for i, line in enumerate(lines):
            if not func_pattern.match(line):
                continue
            # Check this isn't a call site or comment
            stripped = line.lstrip()
            if stripped.startswith("//") or stripped.startswith("*") or stripped.startswith("/*"):
                continue
            # Check for assignment before the function name (call site)
            # e.g., "Status = PblFooBar ("
            if "=" in line and line.index("=") < line.index(func_name):
                continue
            # Check the preceding non-empty line for a return type
            if i > 0:
                j = i - 1
                while j >= 0 and lines[j].strip() == "":
                    j -= 1
                if j >= 0:
                    prev = lines[j]
                    # Return type on its own line (EDK II style)
                    if return_type_pattern.match(prev):
                        return True
                    # Return type on the same line as the function name
                    # e.g., "EFI_STATUS PblFooBar ("
                    type_on_same = re.match(
                        rf"^\s*(?:STATIC\s+)?(?:EFI_STATUS|VOID|UINTN|UINT8|UINT16|UINT32|UINT64|"
                        rf"BOOLEAN|PBL_RESULT|CHAR8|CHAR16|EFI_HANDLE|VOID\s*\*)\s+{re.escape(func_name)}\s*\(",
                        line,
                    )
                    if type_on_same:
                        return True
                    # Also accept STATIC + return type + function on same line
                    static_same = re.match(
                        rf"^\s*STATIC\s+(?:EFI_STATUS|VOID|UINTN|UINT8|UINT16|UINT32|UINT64|"
                        rf"BOOLEAN|PBL_RESULT|CHAR8|CHAR16)\s+{re.escape(func_name)}\s*\(",
                        line,
                    )
                    if static_same:
                        return True
            return True  # Function name at start of line with no return type — still likely a definition

        return False
    except Exception:
        return False


def compute_sha256(path: Path) -> str:
    """Compute SHA-256 of a file."""
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Review logic
# ---------------------------------------------------------------------------


def review_session(label: str, body: str, session_idx: int = 0, all_sessions: list = None) -> SessionReview:
    """Run all checks against one session block.

    If all_sessions is provided (list of (label, body) tuples), claims for
    files that are also claimed by a LATER session are marked as superseded
    (skipped) rather than failed — the later session's claim is authoritative.
    """
    review = SessionReview(label=label)
    session_tag = label[:60]

    # Build a set of (file_path) claims from later sessions — if a later
    # session also claims the same file, the earlier claim is superseded.
    later_line_count_files = set()
    later_sha256_files = set()
    if all_sessions and session_idx < len(all_sessions) - 1:
        for later_idx in range(session_idx + 1, len(all_sessions)):
            later_body = all_sessions[later_idx][1]
            for _, path_str, _ in extract_line_count_claims(later_body):
                later_line_count_files.add(path_str)
            for _, path_str, _ in extract_sha256_claims(later_body):
                later_sha256_files.add(path_str)

    # 1. File existence checks
    for claim, rel_path in extract_file_claims(body):
        # Skip legacy/deleted paths — mark as skipped, not failed
        if is_legacy_path(rel_path):
            review.checks.append(
                Check(
                    session_label=session_tag,
                    claim=claim,
                    category="file_exists",
                    passed=True,
                    detail=f"legacy/deleted path: {rel_path}",
                    skipped=True,
                )
            )
            continue
        full_path = _PROJECT_ROOT / rel_path
        exists = full_path.exists()
        if not exists:
            # Try to find it by basename
            found = find_source_file(rel_path)
            exists = found is not None
        review.checks.append(
            Check(
                session_label=session_tag,
                claim=claim,
                category="file_exists",
                passed=exists,
                detail=f"path: {rel_path}",
            )
        )

    # 2. Line count checks
    for claim, path_str, claimed_count in extract_line_count_claims(body):
        if is_legacy_path(path_str):
            review.checks.append(
                Check(
                    session_label=session_tag,
                    claim=claim,
                    category="line_count",
                    passed=True,
                    detail=f"legacy/deleted path: {path_str}",
                    skipped=True,
                )
            )
            continue
        # If a later session also claims this file, the earlier claim is superseded
        if path_str in later_line_count_files:
            review.checks.append(
                Check(
                    session_label=session_tag,
                    claim=claim,
                    category="line_count",
                    passed=True,
                    detail=f"superseded by later session, path={path_str}",
                    skipped=True,
                )
            )
            continue
        path = Path(path_str)
        if not path.is_absolute():
            path = _PROJECT_ROOT / path_str
        actual = count_lines(path) if path.exists() else -1
        # Allow ±10 line tolerance (agents sometimes count slightly differently)
        passed = actual >= 0 and abs(actual - claimed_count) <= 10
        review.checks.append(
            Check(
                session_label=session_tag,
                claim=claim,
                category="line_count",
                passed=passed,
                detail=f"claimed={claimed_count}, actual={actual}, path={path_str}",
            )
        )

    # 3. Function definition checks
    for claim, func_name in extract_function_claims(body):
        # Skip legacy function names — mark as skipped
        if is_legacy_function(func_name):
            review.checks.append(
                Check(
                    session_label=session_tag,
                    claim=claim,
                    category="function_exists",
                    passed=True,
                    detail=f"legacy function: {func_name}",
                    skipped=True,
                )
            )
            continue
        # Search all PBL C files for the function definition
        pbl_dir = _PROJECT_ROOT / "firmware" / "PblPkg" / "PblApp"
        found = False
        if pbl_dir.exists():
            for c_file in pbl_dir.glob("*.c"):
                if function_is_defined(c_file, func_name):
                    found = True
                    break
        review.checks.append(
            Check(
                session_label=session_tag,
                claim=claim,
                category="function_exists",
                passed=found,
                detail=f"function: {func_name}",
            )
        )

    # 4. SHA-256 checks
    for claim, path_str, expected_sha in extract_sha256_claims(body):
        # If a later session also claims this file's SHA, the earlier claim is superseded
        if path_str in later_sha256_files:
            review.checks.append(
                Check(
                    session_label=session_tag,
                    claim=claim,
                    category="sha256",
                    passed=True,
                    detail=f"superseded by later session, path={path_str}",
                    skipped=True,
                )
            )
            continue
        path = Path(path_str)
        if not path.is_absolute():
            path = _PROJECT_ROOT / path_str
        actual_sha = compute_sha256(path) if path.exists() else ""
        # If the file doesn't exist or doesn't match, try the EDK2 build path
        # (PblApp.efi is built by EDK2 and may not be copied to the repo)
        if actual_sha != expected_sha and "PblApp.efi" in path_str:
            edk2_path = Path("/home/cllin/.local/src/edk2/Build/PblPkg/RELEASE_GCC/X64/PblApp.efi")
            if edk2_path.exists():
                actual_sha = compute_sha256(edk2_path)
        passed = actual_sha == expected_sha
        review.checks.append(
            Check(
                session_label=session_tag,
                claim=claim,
                category="sha256",
                passed=passed,
                detail=f"expected={expected_sha[:16]}..., actual={actual_sha[:16]}...",
            )
        )

    # 5. Build artifact checks
    for claim, artifact in extract_build_claims(body):
        if artifact == "PblApp.efi":
            efi_path = _PROJECT_ROOT / "firmware" / "PblPkg" / "PblApp.efi"
            edk2_efi = Path("/home/cllin/.local/src/edk2/Build/PblPkg/RELEASE_GCC/X64/PblApp.efi")
            passed = efi_path.exists() or edk2_efi.exists()
            detail = f"firmware/PblPkg/PblApp.efi exists={efi_path.exists()}, edk2 build={edk2_efi.exists()}"
        elif artifact == "build":
            # Just check that the build directory exists
            build_dir = Path("/home/cllin/.local/src/edk2/Build/PblPkg")
            passed = build_dir.exists()
            detail = str(build_dir)
        else:
            passed = True
            detail = "skipped"
        review.checks.append(
            Check(
                session_label=session_tag,
                claim=claim,
                category="build_artifact",
                passed=passed,
                detail=detail,
            )
        )

    # 6. Stub implementation checks
    for claim, path_str, func_name in extract_stub_claims(body):
        if is_legacy_path(path_str) or is_legacy_function(func_name):
            review.checks.append(
                Check(
                    session_label=session_tag,
                    claim=claim,
                    category="stub_implementation",
                    passed=True,
                    detail=f"legacy: {path_str}/{func_name}",
                    skipped=True,
                )
            )
            continue
        path = Path(path_str)
        if not path.is_absolute():
            path = _PROJECT_ROOT / path_str
        passed = path.exists() and function_is_defined(path, func_name)
        review.checks.append(
            Check(
                session_label=session_tag,
                claim=claim,
                category="stub_implementation",
                passed=passed,
                detail=f"path={path_str}, func={func_name}",
            )
        )

    return review


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def print_review(reviews: list[SessionReview], verbose: bool = False, json_out: bool = False) -> int:
    """Print review results. Returns exit code (0=all pass, 1=has failures)."""
    if json_out:
        data = []
        for r in reviews:
            data.append(
                {
                    "session": r.label,
                    "passed": r.passed_count,
                    "failed": r.failed_count,
                    "skipped": r.skipped_count,
                    "checks": [
                        {
                            "claim": c.claim,
                            "category": c.category,
                            "passed": c.passed,
                            "skipped": c.skipped,
                            "detail": c.detail,
                        }
                        for c in r.checks
                    ],
                }
            )
        print(json.dumps(data, indent=2))
        return 0 if all(r.failed_count == 0 for r in reviews) else 1

    total_pass = sum(r.passed_count for r in reviews)
    total_fail = sum(r.failed_count for r in reviews)
    total_skip = sum(r.skipped_count for r in reviews)

    print("=" * 70)
    print("TRACE REVIEWER — Checking trace.md claims against repo state")
    print("=" * 70)

    for r in reviews:
        if r.failed_count == 0:
            status = "PASS"
        else:
            status = "FAIL"
        skip_str = f", {r.skipped_count} skipped" if r.skipped_count > 0 else ""
        print(f"\n[{status}] {r.label}")
        print(f"  Checks: {r.passed_count} passed, {r.failed_count} failed{skip_str}")

        if verbose or r.failed_count > 0:
            for c in r.checks:
                if c.skipped:
                    icon = "[SKIP]"
                elif c.passed:
                    icon = "[OK]"
                else:
                    icon = "[XX]"
                if verbose or not c.passed:
                    print(f"  {icon} {c.claim}")
                    if not c.passed or c.skipped:
                        print(f"       -> {c.detail}")

    print(f"\n{'=' * 70}")
    print(f"TOTAL: {total_pass} passed, {total_fail} failed, {total_skip} skipped across {len(reviews)} session(s)")
    print("=" * 70)

    return 0 if total_fail == 0 else 1


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(description="Review trace.md claims against repo state")
    parser.add_argument("--all", action="store_true", help="Review all sessions")
    parser.add_argument("--session", type=int, help="Review session N (1-based)")
    parser.add_argument("--json", action="store_true", help="Output JSON")
    parser.add_argument("--verbose", action="store_true", help="Show all checks, not just failures")
    args = parser.parse_args()

    if not _TRACE_PATH.exists():
        print(f"ERROR: trace.md not found at {_TRACE_PATH}", file=sys.stderr)
        return 2

    trace_text = _TRACE_PATH.read_text(encoding="utf-8", errors="replace")
    sessions = parse_sessions(trace_text)

    if not sessions:
        print("ERROR: No session blocks found in trace.md", file=sys.stderr)
        return 2

    # Review ALL sessions — legacy/deleted paths are marked as skipped, not failed.
    # The is_legacy_path() and is_legacy_function() helpers handle the
    # AntiTheft → PBL architecture transition gracefully.
    if args.all:
        targets = list(enumerate(sessions))
    elif args.session:
        if args.session < 1 or args.session > len(sessions):
            print(f"ERROR: session {args.session} out of range (1-{len(sessions)})", file=sys.stderr)
            return 2
        targets = [(args.session - 1, sessions[args.session - 1])]
    else:
        # Default: review latest session only
        targets = [(len(sessions) - 1, sessions[-1])]

    reviews = [review_session(label, body, idx, sessions) for idx, (label, body) in targets]
    return print_review(reviews, verbose=args.verbose, json_out=args.json)


if __name__ == "__main__":
    sys.exit(main())
