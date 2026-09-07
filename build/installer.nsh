!macro customInit
  # 1. 强制终止任何正在运行的 DeepSeek Harness 客户端及子进程树
  nsExec::Exec `taskkill /F /T /IM "DeepSeek Harness.exe"`
  nsExec::Exec `taskkill /F /T /IM "DeepSeek-Harness*.exe"`

  # 2. 如果之前已存在安装目录，强制关闭任何依然占用该目录的后台服务进程（如内置 node 等）
  ${if} ${FileExists} "$INSTDIR"
    nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process | Where-Object { $$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase') } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force }"`
  ${endIf}

  # 3. 核心修复：彻底解决安装进度走到 55% 时调用老旧有 bug 的旧卸载程序导致卡死与报错的问题
  # 提前清理注册表中旧版本的 UninstallString，让新安装程序平滑直接覆盖，跳过调用老旧卸载程序
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
  !endif

  # 4. 删除旧安装目录下可能残留的老旧卸载程序文件，确保绝不被触发
  ${if} ${FileExists} "$INSTDIR\Uninstall DeepSeek Harness.exe"
    Delete "$INSTDIR\Uninstall DeepSeek Harness.exe"
  ${endIf}

  # 5. 等待操作系统完全释放所有文件句柄
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
