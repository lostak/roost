@echo off
setlocal
REM Rebuilds Roost.lnk as a real, taskbar-pinnable Windows shortcut.
REM Double-click once, then right-click Roost.lnk and choose "Pin to taskbar"
REM (on Win11 it may be under "Show more options"), or drag it onto the taskbar.
set "HERE=%~dp0"
set "PS=%TEMP%\_mkroost.ps1"
> "%PS%" echo $h = '%HERE%'
>>"%PS%" echo $w = New-Object -ComObject WScript.Shell
>>"%PS%" echo $s = $w.CreateShortcut($h + 'Roost.lnk')
>>"%PS%" echo $s.TargetPath = $env:ComSpec
>>"%PS%" echo $s.Arguments = '/c "' + $h + 'Start-Roost.bat"'
>>"%PS%" echo $s.WorkingDirectory = $h
>>"%PS%" echo $s.IconLocation = $h + 'Roost.ico'
>>"%PS%" echo $s.Description = 'Roost - commission and residual dashboard'
>>"%PS%" echo $s.WindowStyle = 1
>>"%PS%" echo $s.Save()
powershell -NoProfile -ExecutionPolicy Bypass -File "%PS%"
del "%PS%" >nul 2>&1
echo.
echo Roost.lnk rebuilt - now pinnable to the taskbar.
pause
