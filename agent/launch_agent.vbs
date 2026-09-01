' launch_agent.vbs — launches the lockdown agent fully detached
' wscript.exe runs in its own session, so the agent survives terminal close
Set sh = CreateObject("WScript.Shell")
sh.Run """C:\ProgramData\LockdownAgent\lockdown-agent.exe"" --silent --config ""C:\ProgramData\LockdownAgent\config.json""", 0, False
' 0 = hidden window, False = don't wait for exit
