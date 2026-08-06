@echo off
REM Backup: rebuild a native Roost.lnk next to this file (only needed if the
REM included Roost.lnk ever fails to launch). Double-click, then drag Roost.lnk anywhere.
set "HERE=%~dp0"
powershell -NoProfile -Command ^
  "$w=New-Object -ComObject WScript.Shell;" ^
  "$s=$w.CreateShortcut('%HERE%Roost.lnk');" ^
  "$s.TargetPath='%HERE%Start-Roost.bat';" ^
  "$s.WorkingDirectory='%HERE%';" ^
  "$s.IconLocation='%HERE%Roost.ico';" ^
  "$s.Description='Roost - commission ^& residual dashboard';" ^
  "$s.Save()"
echo Roost.lnk rebuilt in this folder.
pause
