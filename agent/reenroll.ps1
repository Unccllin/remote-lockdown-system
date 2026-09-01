# Re-enroll script — run as Admin
param([string]$Token = "")
$api = "https://lockdown-serverless.mainacollins196.workers.dev"
$apiPath = "$api/api"
$dir = "C:\ProgramData\LockdownAgent"

if ($Token -eq "") {
    Write-Host "Usage: .\reenroll.ps1 -Token 'your_token'"
    exit 1
}

# Enroll
$body = @{token=$Token; hostname=$env:COMPUTERNAME; owner_name="Hardware Test"} | ConvertTo-Json
$r = Invoke-RestMethod -Uri "$apiPath/enroll/claim" -Method POST -Body $body -ContentType "application/json"
Write-Host "Enrolled: $($r.device.id)"

# Write config
$cfg = @{
    server_url = $api
    api_key = $r.api_key
    hostname = $env:COMPUTERNAME
    device_id = $r.device.id
    poll_interval = 30
    lockdown_folder = "$dir\LockdownFolder"
    lock_sentinel = "$dir\.locked"
    pending_ack_file = "$dir\.pending_ack"
    recovery_key_file = "$dir\.recovery_key"
    boot_lock_enabled = $false
    verify_tls = $true
    server_supports_ack_dedup = $true
}
$cfg | ConvertTo-Json | Set-Content "$dir\config.json"
Write-Host "Config written"

# Restart agent
Stop-Process -Name "lockdown-agent" -Force -EA SilentlyContinue
Start-Sleep 2
Start-Process "$dir\lockdown-agent.exe" -ArgumentList "--silent","--config","$dir\config.json" -WindowStyle Hidden
Start-Sleep 3
$proc = Get-Process -Name "lockdown-agent" -EA SilentlyContinue
if ($proc) { Write-Host "Agent running (PID: $($proc.Id))" }
else { Write-Host "Agent NOT running — check crash.log" }
