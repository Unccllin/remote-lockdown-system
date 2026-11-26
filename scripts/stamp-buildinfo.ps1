# Stamp agent/_buildinfo.py with the identity of the tree being built.
#
# Why this file is only a wrapper
# -------------------------------
# Three build paths ship binaries to three places:
#
#   agent/build.ps1                     Windows, interactive and MOLE
#   scripts/build-windows-artifacts.ps1 Windows, what CI runs on a v* tag (published to KV)
#   agent/build.sh                      Linux and macOS, what release.yml bundles into the
#                                       Electron release
#
# Only the first stamped at first, so the Windows CI path published build=unknown.unknown (S359)
# and the Linux/macOS binaries would have done the same (S361). The computation now lives in
# scripts/stamp_buildinfo.py -- one implementation, three entry points -- and this file exists
# because the two .ps1 callers already invoke it and would otherwise need rewriting.
#
# The committed _buildinfo.py keeps its `unknown` placeholders: a source checkout must not
# impersonate a release, and agent/tests/test_version_identity.py pins that.
#
# Usage:
#   pwsh -File scripts/stamp-buildinfo.ps1                            # stamp from the source hash
#   pwsh -File scripts/stamp-buildinfo.ps1 -BuildCommit abc1234       # stamp with a known commit
#   pwsh -File scripts/stamp-buildinfo.ps1 -Python C:\Python314\python.exe
#
# Output: rewrites agent/_buildinfo.py and prints `Build identity: <date>.<commit>`.

[CmdletBinding()]
param(
    # Override the build id, e.g. the commit that produced the tree. Without it the id is a
    # hash of the agent sources, which is what a build host without git can still compute.
    [string]$BuildCommit = '',
    # For a build that does not happen in a normal checkout (the tests pass a temp tree).
    [string]$AgentDir = '',
    # Interpreter for the shared implementation; the callers pass their own.
    [string]$Python = 'python'
)

$ErrorActionPreference = 'Stop'

# Passing an empty --commit would override the source hash with nothing, so only forward it
# when a build id was given.
$commitArgs = @()
if ($BuildCommit) { $commitArgs = @('--commit', $BuildCommit) }

if (-not $AgentDir) {
    $repoRoot = Split-Path -Parent $PSScriptRoot
    $AgentDir = Join-Path $repoRoot 'agent'
}

# The computation lives in stamp_buildinfo.py so the Windows entry points and agent/build.sh
# (Linux/macOS, used by release.yml) cannot drift into two identities for one tree. This file is
# only the PowerShell-shaped entry point the two .ps1 build scripts already call.
& $Python (Join-Path $PSScriptRoot 'stamp_buildinfo.py') --agent-dir $AgentDir @commitArgs
if ($LASTEXITCODE -ne 0) {
    # `throw`, not `exit`: this script is invoked with `&`, so an exit would take the caller's
    # whole build down instead of failing the stamp step.
    throw "could not stamp the build identity under '$AgentDir'"
}
