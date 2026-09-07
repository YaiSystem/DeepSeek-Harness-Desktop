!macro customInit
  # 1. 强制终止任何正在运行的 DeepSeek Harness 主进程及所有子进程树
  # 彻底解决覆盖安装时报“无法关闭，请手动关闭”的问题
  nsExec::Exec `taskkill /F /T /IM "DeepSeek Harness.exe"`
  nsExec::Exec `taskkill /F /T /IM "DeepSeek-Harness*.exe"`

  # 2. 如果之前已存在安装目录，强制关闭任何依然占用该目录的残留后台进程（如内置 node 服务）
  ${if} ${FileExists} "$INSTDIR"
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  ${endIf}

  # 3. 等待操作系统完全释放文件句柄
  Sleep 1000
!macroend

!macro customUnInstall
  nsExec::Exec `taskkill /F /T /IM "DeepSeek Harness.exe"`
  nsExec::Exec `taskkill /F /T /IM "DeepSeek-Harness*.exe"`
  ${if} ${FileExists} "$INSTDIR"
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  ${endIf}
  Sleep 1000
!macroend
