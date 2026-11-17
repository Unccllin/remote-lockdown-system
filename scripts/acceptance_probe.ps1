<#
.SYNOPSIS
Read-only state snapshot of a machine with the Lockdown agent installed.

.DESCRIPTION
Emits ONE JSON object on stdout and changes nothing. It exists because every defect the
live lifecycle run on MOLE found was the same shape: the agent's *report* and the
machine's *state* disagreed.

  * `tracking_state.json` recorded `decoy_account: "GuestUser"` while
    `Get-LocalUser GuestUser` said the account did not exist.
  * `agent_lockdown_confirmed` was sent after every BCD layer had rolled back.
  * `verify_tls` was announced as patched by a script whose own copy step had already
    aborted the run.

So the acceptance harness reads the machine, not the agent's opinion of it. Anything
unreadable is reported as `null` with a note rather than guessed — a probe that lies is
worse than a probe that fails.

.PARAMETER RealUser
The interactive user to inspect. Defaults to the same source the agent uses
(`query user`), minus the decoy account.
#>
param([string]$RealUser = '')

$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$inst = Join-Path $env:ProgramData 'LockdownAgent'
$cfg = Join-Path $inst 'config.json'
$decoyName = 'GuestUser'

function Get-AccountActive([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) { return $null }
    try {
        $out = & net.exe user $name 2>$null
        if ($LASTEXITCODE -ne 0) { return $false }   # no such account
        $line = $out | Where-Object { $_ -match 'Account active' }
        if (-not $line) { return $null }
        return [bool]($line -match 'Yes')
    } catch { return $null }
}

function Get-AccountExists([string]$name) {
    try {
        $null = & net.exe user $name 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $null }
}

function Get-EncryptedFileCount([string]$path) {
    if (-not (Test-Path -LiteralPath $path)) { return 0 }
    $count = 0
    try {
        Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue |
            ForEach-Object {
                # 0x4000 = FILE_ATTRIBUTE_ENCRYPTED, the same bit agent.py counts.
                if ($_.Attributes -band [System.IO.FileAttributes]::Encrypted) { $count++ }
            }
    } catch { }
    return $count
}

function Get-RealUserName {
    if (-not [string]::IsNullOrWhiteSpace($RealUser)) { return $RealUser }
    try {
        $out = & query.exe user 2>$null
        foreach ($line in ($out | Select-Object -Skip 1)) {
            $name = ($line -split '\s+')[0]
            if ([string]::IsNullOrWhiteSpace($name)) { continue }
            if ($name -match '\\') { $name = $name.Split('\')[1] }
            if ($name -ieq $decoyName) { continue }
            if ($name -match '^>') { $name = $name.Substring(1) }
            return $name
        }
    } catch { }
    return $null
}

# --- config ---
$configParses = $false
$config = $null
if (Test-Path -LiteralPath $cfg) {
    try {
        $config = Get-Content -LiteralPath $cfg -Raw | ConvertFrom-Json
        $configParses = $true
    } catch {
        $configParses = $false
    }
}

# --- service ---
$service = $null
try {
    $svc = Get-Service -Name 'LockdownAgent' -ErrorAction SilentlyContinue
    if ($svc) { $service = [string]$svc.Status }
} catch { }

# --- lock state ---
$sentinelPath = if ($config -and $config.lock_sentinel) { $config.lock_sentinel } else { Join-Path $inst '.locked' }
$sentinel = Test-Path -LiteralPath $sentinelPath
$lockdownFolder = if ($config -and $config.lockdown_folder) { $config.lockdown_folder } else { Join-Path $inst 'lockdown_folder' }
$lockdownFiles = 0
if (Test-Path -LiteralPath $lockdownFolder) {
    $lockdownFiles = @(Get-ChildItem -LiteralPath $lockdownFolder -Recurse -File -ErrorAction SilentlyContinue).Count
}
$lockdownEncrypted = Get-EncryptedFileCount $lockdownFolder

# --- tracking state (the file that lied) ---
# Both locations: the agent's default is %ProgramData%\LockdownSystem\tracking_state.json
# (agent.py:2710), while config.json may point elsewhere. Reading only the install
# directory silently reported "no tracking state" for a machine that had one.
$trackingState = $null
foreach ($candidate in @(
    (Join-Path $inst 'tracking_state.json'),
    (Join-Path $env:ProgramData 'LockdownSystem\tracking_state.json')
)) {
    if (Test-Path -LiteralPath $candidate) {
        try {
            $trackingState = Get-Content -LiteralPath $candidate -Raw | ConvertFrom-Json
            break
        } catch { }
    }
}

$realUser = Get-RealUserName
$realProfile = if ($realUser) { Join-Path 'C:\Users' $realUser } else { $null }
$efsPaths = @()
if ($realProfile -and (Test-Path -LiteralPath $realProfile)) {
    foreach ($sub in @('Documents', 'Downloads', 'Pictures', 'Desktop')) {
        $p = Join-Path $realProfile $sub
        if (Test-Path -LiteralPath $p) {
            $efsPaths += [pscustomobject]@{
                path      = $p
                encrypted = Get-EncryptedFileCount $p
            }
        }
    }
}

# --- evidence trail (agent.log tail, install.log ledger) ---
$installRuns = @()
if (Test-Path -LiteralPath (Join-Path $inst 'install.log')) {
    try {
        $lines = Get-Content -LiteralPath (Join-Path $inst 'install.log') -ErrorAction SilentlyContinue
        for ($i = 0; $i -lt $lines.Count; $i++) {
            if ($lines[$i] -match '=== installer run started (.+) ===') {
                $started = $Matches[1]
                $code = $null
                for ($j = $i + 1; $j -lt $lines.Count; $j++) {
                    if ($lines[$j] -match '=== installer exited (-?\d+) ===') { $code = [int]$Matches[1] }
                    if ($lines[$j] -match '=== installer run started') { break }
                }
                $installRuns += [pscustomobject]@{ started = $started; exit_code = $code }
            }
        }
    } catch { }
}

# Computed before the object literal: Windows PowerShell 5.1 rejects `try {}` and `if`
# as a hashtable VALUE (`IncompleteHashLiteral`), which is how this probe first failed on
# MOLE — the parser, not the machine, was the problem.
$configDeviceId = $null
$configServerUrl = $null
$configPollInterval = $null
$configVerifyTls = $null
if ($config) {
    $configDeviceId = $config.device_id
    $configServerUrl = $config.server_url
    $configPollInterval = $config.poll_interval
    $configVerifyTls = $config.verify_tls
}

$agentSha = $null
try {
    $exePath = Join-Path $inst 'lockdown-agent.exe'
    if (Test-Path -LiteralPath $exePath) {
        $agentSha = (Get-FileHash -LiteralPath $exePath -Algorithm SHA256).Hash
    }
} catch { $agentSha = $null }

$snapshot = [pscustomobject]@{
    hostname            = $env:COMPUTERNAME
    service             = $service
    config_parses       = $configParses
    config_device_id    = $configDeviceId
    config_server_url   = $configServerUrl
    poll_interval       = $configPollInterval
    verify_tls          = $configVerifyTls
    lock_sentinel       = $sentinel
    lockdown_folder     = $lockdownFolder
    lockdown_files      = $lockdownFiles
    lockdown_encrypted  = $lockdownEncrypted
    real_user           = $realUser
    real_user_active    = Get-AccountActive $realUser
    decoy_name          = $decoyName
    decoy_exists        = Get-AccountExists $decoyName
    decoy_active        = Get-AccountActive $decoyName
    efs_paths           = $efsPaths
    tracking_state      = $trackingState
    agent_binary_sha256 = $agentSha
    installer_runs      = $installRuns
    observed_at         = (Get-Date).ToUniversalTime().ToString('o')
}

# One line, so the caller can parse stdout without stripping banners.
$snapshot | ConvertTo-Json -Depth 8 -Compress
