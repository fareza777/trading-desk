' Launches the V7 adaptive observer watchdog with no console window at all.
' Called by Task Scheduler via wscript.exe //B.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Trading System V7\paper-agent\adaptive"
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File ""C:\Trading System V7\paper-agent\adaptive\watchdog.ps1"""
WScript.Quit sh.Run(cmd, 0, True)
