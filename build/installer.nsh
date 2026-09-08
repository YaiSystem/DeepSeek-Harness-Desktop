!macro customInit
  # 1. 终止残留的 DeepSeek Harness 主进程（静默无窗口）
  nsExec::Exec `taskkill /F /T /IM "DeepSeek Harness.exe"`
  nsExec::Exec `taskkill /F /T /IM "DeepSeek-Harness*.exe"`

  # 2. 清理注册表中旧版本的 UninstallString，平滑直接覆盖，跳过调用老旧有 bug 的卸载程序
  DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  !ifdef UNINSTALL_REGISTRY_KEY_2
    DeleteRegValue HKCU "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
    DeleteRegValue HKLM "${UNINSTALL_REGISTRY_KEY_2}" "UninstallString"
  !endif

  # 3. 删除旧安装目录下可能残留的老旧卸载程序文件，确保绝不被触发
  ${if} ${FileExists} "$INSTDIR\Uninstall DeepSeek Harness.exe"
    Delete "$INSTDIR\Uninstall DeepSeek Harness.exe"
  ${endIf}

  # 4. 缓冲等待系统释放文件锁
  Sleep 500
!macroend

!macro customUnInstall
  nsExec::Exec `taskkill /F /T /IM "DeepSeek Harness.exe"`
  nsExec::Exec `taskkill /F /T /IM "DeepSeek-Harness*.exe"`
  Sleep 500
!macroend
