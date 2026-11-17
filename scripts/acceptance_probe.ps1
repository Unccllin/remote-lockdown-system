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
    # Mirrors agent.py::_get_real_username exactly, including the registry fallback: the
    # probe must look at the account the AGENT will act on. With no console session,
    # `query user` returns nothing and the agent falls back to LastLoggedOnUser — a probe
    # that only asked `query user` reported "no interactive user" while the agent had
    # disabled one, which made the whole check unobservable (measured on MOLE, S271).
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
    try {
        $reg = & reg.exe query 'HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Authentication\LogonUI' /v LastLoggedOnUser 2>$null
        foreach ($line in $reg) {
            if ($line -match 'LastLoggedOnUser' -and $line -match 'REG_SZ') {
                $val = ($line -split 'REG_SZ')[-1].Trim()
                if ($val -match '\\') { $val = $val.Split('\')[1] }
                if (-not [string]::IsNullOrWhiteSpace($val) -and $val -ine $decoyName) { return $val }
            }
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
# The lockdown encrypts CONTENT into `NAME.ext.enc` siblings (agent.py::encrypt_folder), so
# counting the EFS attribute reports 0 for a folder that is genuinely encrypted — measured
# as a false failure on MOLE (S271).
$lockdownEncFiles = 0
$lockdownPlainFiles = 0
if (Test-Path -LiteralPath $lockdownFolder) {
    Get-ChildItem -LiteralPath $lockdownFolder -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Name -like '*.enc') { $lockdownEncFiles++ } else { $lockdownPlainFiles++ }
    }
}

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

# The account's enforcement bit, read through the same interface Windows uses to refuse a
# logon: the local account's UserFlags carries UF_ACCOUNTDISABLE (0x2).
#
# A LogonUserW probe with a deliberately wrong password was tried first and is useless here
# (measured on MOLE, S271): a NONEXISTENT user, an ENABLED user with a wrong password and a
# DISABLED user with a wrong password all return 1326 ERROR_LOGON_FAILURE. Windows reports
# 1331 ERROR_ACCOUNT_DISABLED only when the credentials are otherwise valid, which this
# probe must not have. So the flag is what gets read, and it is corroborated by
# `net user ... Account active`.
$accountProbe = [pscustomobject]@{ attempted = $false; disabled = $null; user_flags = $null; meaning = $null }

$realUser = Get-RealUserName

if ($realUser) {
    try {
        $acct = [ADSI]"WinNT://$env:COMPUTERNAME/$realUser,user"
        $flags = [int]$acct.UserFlags.Value
        $accountProbe.attempted = $true
        $accountProbe.user_flags = $flags
        $accountProbe.disabled = (($flags -band 0x2) -eq 0x2)
        $accountProbe.meaning = if ($accountProbe.disabled) { 'UF_ACCOUNTDISABLE set' } else { 'account enabled' }
    } catch {
        $accountProbe.attempted = $false
        $accountProbe.meaning = "UserFlags unreadable: $($_.Exception.Message)"
    }
}

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
    lockdown_enc_files  = $lockdownEncFiles
    lockdown_plain_files = $lockdownPlainFiles
    real_user           = $realUser
    real_user_active    = Get-AccountActive $realUser
    decoy_name          = $decoyName
    decoy_exists        = Get-AccountExists $decoyName
    decoy_active        = Get-AccountActive $decoyName
    account_probe       = $accountProbe
    efs_paths           = $efsPaths
    tracking_state      = $trackingState
    agent_binary_sha256 = $agentSha
    installer_runs      = $installRuns
    observed_at         = (Get-Date).ToUniversalTime().ToString('o')
}

# One line, so the caller can parse stdout without stripping banners.
$snapshot | ConvertTo-Json -Depth 8 -Compress
