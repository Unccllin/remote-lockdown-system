' watchdog.vbs — checks if agent is running, restarts if not
' This is launched by the scheduled task every 5 minutes
Set sh = CreateObject("WScript.Shell")
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT * FROM Win32_Process WHERE Name='lockdown-agent.exe'")
If procs.Count = 0 Then
    sh.Run """C:\ProgramData\LockdownAgent\lockdown-agent.exe"" --silent --config ""C:\ProgramData\LockdownAgent\config.json""", 0, False
End If
