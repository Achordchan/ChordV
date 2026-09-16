; The installer owns the launch gate only while replacing files. Kernel handles
; are released even if installation is cancelled or crashes; no stale lock file.
Var ChordVUpdateGate
!macro ChordVAcquireInstallGate
  System::Call 'kernel32::CreateMutexW(p0, i0, w "Local\ChordV.Update.InProgress") p.r0 ?e'
  Pop $1
  StrCpy $ChordVUpdateGate $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    ${If} $ChordVUpdateGate != 0
      System::Call 'kernel32::CloseHandle(p $ChordVUpdateGate)'
      StrCpy $ChordVUpdateGate 0
    ${EndIf}
    MessageBox MB_OK|MB_ICONEXCLAMATION "另一个 ChordV 安装或卸载任务正在运行，请稍后重试。"
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro ChordVAcquireInstallGate
  ; Older installations used the crate name. Use Tauri's normal process guard
  ; for both historical paths rather than killing unrelated processes by name.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\chordv-desktop.exe" "ChordV"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\chordv_desktop.exe" "ChordV"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "ChordV"
  InitPluginsDir
  File /oname=$PLUGINSDIR\ChordV-maintenance.exe "${MAINBINARYSRCPATH}"
  nsExec::ExecToStack /TIMEOUT=45000 '"$PLUGINSDIR\ChordV-maintenance.exe" --installer-maintenance'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "未能安全清理旧连接，安装尚未开始。请退出客户端后重试。$\r$\n$1"
    SetErrorLevel 2
    Abort
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro ChordVKeepLegacyEntry "chordv-desktop.exe"
  !insertmacro ChordVKeepLegacyEntry "chordv_desktop.exe"
  System::Call 'kernel32::CloseHandle(p $ChordVUpdateGate)'
  StrCpy $ChordVUpdateGate 0
!macroend

; Preserve arbitrary legacy shortcuts without retaining the old version. NTFS
; uses hard links; other supported volumes fall back to a current-binary copy.
!macro ChordVKeepLegacyEntry NAME
  ClearErrors
  Delete "$INSTDIR\${NAME}"
  System::Call 'kernel32::CreateHardLinkW(w "$INSTDIR\${NAME}", w "$INSTDIR\${MAINBINARYNAME}.exe", p0) i.r0'
  ${If} $0 == 0
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\${MAINBINARYNAME}.exe" "$INSTDIR\${NAME}"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONEXCLAMATION "旧快捷方式入口迁移失败，请关闭客户端后重试安装。"
      SetErrorLevel 2
      Abort
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro ChordVAcquireInstallGate
  !insertmacro CheckIfAppIsRunning "$INSTDIR\chordv-desktop.exe" "ChordV"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\chordv_desktop.exe" "ChordV"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "ChordV"
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 chordv_uninstall_cleanup_done
  nsExec::ExecToStack /TIMEOUT=45000 '"$INSTDIR\${MAINBINARYNAME}.exe" --installer-maintenance'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "未能安全清理连接，卸载尚未开始。请退出客户端后重试。$\r$\n$1"
    SetErrorLevel 2
    Abort
  ${EndIf}
  chordv_uninstall_cleanup_done:
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  Delete "$INSTDIR\chordv-desktop.exe"
  Delete "$INSTDIR\chordv_desktop.exe"
  ; Tauri's earlier RMDir cannot remove a folder containing generated aliases.
  RMDir "$INSTDIR"
  System::Call 'kernel32::CloseHandle(p $ChordVUpdateGate)'
  StrCpy $ChordVUpdateGate 0
!macroend
