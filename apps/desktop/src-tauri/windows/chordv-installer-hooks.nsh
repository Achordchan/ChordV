; The installer owns the launch gate only while replacing files. Kernel handles
; are released even if installation is cancelled or crashes; no stale lock file.
Var ChordVUpdateGate
!macro NSIS_HOOK_PREINSTALL
  System::Call 'kernel32::CreateMutexW(p0, i0, w "Local\ChordV.Update.InProgress") p.r0 ?e'
  Pop $1
  StrCpy $ChordVUpdateGate $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    MessageBox MB_OK|MB_ICONEXCLAMATION "另一个 ChordV 安装任务正在运行，请稍后重试。"
    SetErrorLevel 2
    Abort
  ${EndIf}
  ; Older installations used the crate name. Use Tauri's normal process guard
  ; for both historical paths rather than killing unrelated processes by name.
  !insertmacro CheckIfAppIsRunning "$INSTDIR\chordv-desktop.exe" "ChordV"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\chordv_desktop.exe" "ChordV"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  Delete "$INSTDIR\chordv-desktop.exe"
  Delete "$INSTDIR\chordv_desktop.exe"
  System::Call 'kernel32::CloseHandle(p $ChordVUpdateGate)'
  StrCpy $ChordVUpdateGate 0
!macroend
