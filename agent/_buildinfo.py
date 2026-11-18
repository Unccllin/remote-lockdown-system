"""Build identity — stamped by `agent/build.ps1` before PyInstaller runs.

The committed values describe a *source checkout*, not a build: a tree that was never
packaged says so instead of impersonating a release. `build.ps1` overwrites this module
in the build tree with the UTC build date and a hash of the source files, which is what
lets two binaries that both report `AGENT_VERSION = "1.0.0"` be told apart.

Why a separate module rather than more of `AGENT_VERSION`: the update path compares
versions numerically (`compareVersions` splits on '.' in server/src/routes/agent.js:1037),
so anything with dots or metadata in it would be parsed as numbers. The build id lives
beside the version, is reported in `--version` and the startup log, and never participates
in a comparison.

Keep the placeholder values as they are: `tests/test_version_identity.py` reads this file
and asserts the committed defaults stay `unknown`, so a stamped build cannot be committed
by accident.
"""

BUILD_COMMIT = "unknown"
BUILD_DATE = "unknown"
