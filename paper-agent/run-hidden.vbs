' Launches the V7 paper-agent watchdog with no console window at all.
' Called by Task Scheduler via wscript.exe //B.
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""C:\Trading System V7\paper-agent\watchdog.ps1"""
WScript.Quit sh.Run(cmd, 0, True)
