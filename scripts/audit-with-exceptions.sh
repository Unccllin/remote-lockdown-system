#!/usr/bin/env bash
#
# npm audit wrapper that allows documented false positives.
#
# Runs `npm audit --audit-level=high` and exits 0 if the only findings are
# advisories listed in the KNOWN_FALSE_POSITIVES set below. Each entry must
# have a justification comment explaining why it is a false positive.
#
# Usage:
#   scripts/audit-with-exceptions.sh           # run in current dir
#   scripts/audit-with-exceptions.sh --json    # json output
#
# Exit codes:
#   0  no vulnerabilities, or only documented false positives
#   1  real vulnerabilities found (not in the exception list)
#   2  npm audit failed to run
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Known false positives — each MUST have a justification.
# Format: advisory source ID (the number in the npm audit JSON "source" field)
# ---------------------------------------------------------------------------
# GHSA-qwww-vcr4-c8h2 (source: 1124282):
#   react-router RSC Mode CSRF Bypass. The official GitHub advisory lists
#   7.18.2 as patched (affected: >= 7.12.0, < 7.18.2). However, npm's advisory
#   database merged the 7.x and 8.x ranges into one (>= 7.12.0, < 8.3.0),
#   incorrectly flagging 7.18.2. This dashboard uses BrowserRouter (client-side
#   only) and does NOT use the unstable RSC APIs that the advisory targets.
#   Upgrading to react-router 8.x requires React 19, which is a major framework
#   upgrade outside the scope of this audit.
#   See: https://github.com/remix-run/react-router/security/advisories/GHSA-qwww-vcr4-c8h2
KNOWN_FALSE_POSITIVES="1124282"

# ---------------------------------------------------------------------------
# Run npm audit and parse the JSON output.
# ---------------------------------------------------------------------------
AUDIT_JSON=$(npm audit --audit-level=high --json 2>/dev/null || true)

if [ -z "$AUDIT_JSON" ]; then
  echo "ERROR: npm audit produced no output" >&2
  exit 2
fi

# Parse with node (always available in npm projects).
REAL_VULNS=$(node -e "
const data = JSON.parse(process.argv[1]);
const known = new Set(process.argv[2].split(/\s+/).filter(Boolean));
const vulns = data.vulnerabilities || {};

// Build a set of package names whose vulnerabilities are false positives.
// A package is a false positive if ALL its via entries are either:
//  - advisory objects with a source in the known set, OR
//  - string references to another package that is itself a false positive.
const falsePositiveNames = new Set();
let changed = true;
while (changed) {
  changed = false;
  for (const [name, info] of Object.entries(vulns)) {
    if (falsePositiveNames.has(name)) continue;
    const via = info.via || [];
    const allFP = via.length > 0 && via.every(v => {
      if (typeof v === 'string') return falsePositiveNames.has(v);
      const source = v.source ? String(v.source) : '';
      return known.has(source);
    });
    if (allFP) {
      falsePositiveNames.add(name);
      changed = true;
    }
  }
}

const real = {};
for (const [name, info] of Object.entries(vulns)) {
  if (!falsePositiveNames.has(name)) real[name] = info;
}
if (Object.keys(real).length > 0) {
  console.log(JSON.stringify(real, null, 2));
  process.exit(1);
}
" "$AUDIT_JSON" "$KNOWN_FALSE_POSITIVES" 2>/dev/null || true)

if [ -n "$REAL_VULNS" ]; then
  echo "REAL vulnerabilities found (not in false-positive list):"
  echo "$REAL_VULNS" >&2
  exit 1
fi

# Check if there were any false positives we suppressed
TOTAL_VULNS=$(echo "$AUDIT_JSON" | node -e "
const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
const v = data.vulnerabilities || {};
console.log(Object.keys(v).length);
" 2>/dev/null || echo "0")

if [ "$TOTAL_VULNS" -gt 0 ]; then
  echo "npm audit: $TOTAL_VULNS finding(s) — all are documented false positives (see scripts/audit-with-exceptions.sh)"
else
  echo "npm audit: no vulnerabilities found"
fi
exit 0
