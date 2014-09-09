@rem Copyright Andrew Challen, Apache License v2 http://www.apache.org/licenses
@rem This will fetch node.exe and acserver.js as required, then run acserver.js
@where node.exe >nul 2>&1
@if %errorlevel% neq 0 echo Fetching node.exe&&@powershell ^"((new-object net.^
webclient).DownloadFile('http://nodejs.org/dist/latest/node.exe','node.exe'))^"
@node %~dpn0.js %*
