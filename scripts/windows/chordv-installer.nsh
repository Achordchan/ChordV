!ifndef CHORDV_INSTALLER_INCLUDED
!define CHORDV_INSTALLER_INCLUDED
!ifndef CHORDV_MYGO_PASSIVE_PAGES
  !error "ChordV passive page callbacks must be injected by the locked MyGo NSIS build wrapper"
!endif
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"

Var ChordVGate
Var ChordVUpdate
Var ChordVRestart
Var ChordVRestartArgs
Var ChordVRawCommand
Var ChordVDirectoryCheck
Var ChordVPassive

!macro ChordVStop MESSAGE
  ${If} $ChordVDirectoryCheck == 1
    StrCpy $ChordVDirectoryCheck 0
    Abort
  ${EndIf}
  DetailPrint "${MESSAGE}"
  IfSilent +2
    MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}"
  SetErrorLevel 2
  Quit
!macroend

!macro ChordVCheckQAProfile
  !ifdef CHORDV_INSTALLER_QA_ONLY
    ; Accidental-install guard only. The Windows harness validates SID and lease contents.
    ${IfNot} ${FileExists} "$PROFILE\.chordv-installer-qa-lease.json"
      !insertmacro ChordVStop "此验收包仅可在具备有效测试租约的专用账户中运行。"
    ${EndIf}
  !endif
!macroend

!include "${__FILEDIR__}/chordv-install-actions.nsh"

!include "${__FILEDIR__}/chordv-paths.nsh"
!include "${__FILEDIR__}/chordv-registry.nsh"

!macro ChordVAcquireGate
  System::Call 'kernel32::CreateMutexW(p0, i0, w "Local\ChordV.Update.InProgress") p.r0 ?e'
  Pop $1
  StrCpy $ChordVGate $0
  ${If} $0 == 0
  ${OrIf} $1 == 183
    !insertmacro ChordVStop "另一个 ChordV 安装或卸载任务正在运行。"
  ${EndIf}
!macroend

!macro ChordVReleaseGate
  ${If} $ChordVGate != 0
    System::Call 'kernel32::CloseHandle(p $ChordVGate)'
    StrCpy $ChordVGate 0
  ${EndIf}
!macroend

!macro ChordVReadFlag FLAG TARGET
  StrCpy ${TARGET} 0
  ${GetOptions} $ChordVRawCommand "${FLAG}" $0
  ${IfNot} ${Errors}
    ${If} $0 != ""
      !insertmacro ChordVStop "安装参数 ${FLAG} 格式不正确。"
    ${EndIf}
    StrCpy ${TARGET} 1
  ${EndIf}
!macroend

Function ChordVParseParameters
  ; Use the original command line to retain /D= (NSIS removes it from
  ; $CMDLINE), and the same quote-aware GetOptions as the old Tauri template.
  System::Call 'kernel32::GetCommandLineW() p.r0'
  System::Call 'kernel32::lstrlenW(p r0) i.r1'
  ${If} $1 > 900
    !insertmacro ChordVStop "安装参数过长，未截断或忽略参数。"
  ${EndIf}
  System::Call '*$0(&w${NSIS_MAX_STRLEN} .r1)'
  StrCpy $ChordVRawCommand $1
  !insertmacro ChordVReadFlag "/P" $ChordVPassive
  ${If} $ChordVPassive == 1
  ${AndIf} ${Silent}
    !insertmacro ChordVStop "/P 和 /S 不能同时使用；未把进度界面改成静默安装。"
  ${EndIf}
  !insertmacro ChordVReadFlag "/UPDATE" $ChordVUpdate
  !insertmacro ChordVReadFlag "/R" $ChordVRestart
  StrCpy $ChordVRestartArgs ""
  ${GetOptions} $ChordVRawCommand "/ARGS" $ChordVRestartArgs
  ${IfNot} ${Errors}
  ${AndIf} $ChordVRestart != 1
    !insertmacro ChordVStop "/ARGS 必须与 /R 和 /UPDATE 一起使用。"
  ${EndIf}
  ${If} $ChordVRestart == 1
    ${If} $ChordVUpdate != 1
      !insertmacro ChordVStop "/R 必须与 /UPDATE 一起使用。"
    ${EndIf}
    ${IfNot} ${Silent}
    ${AndIf} $ChordVPassive != 1
      !insertmacro ChordVStop "/R 仅支持显式 /P 或 /S 更新，交互安装使用完成页启动选项。"
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ChordVCheckTarget
  StrCpy $ChordVPath $INSTDIR
  Call ChordVValidateRoot
  ${If} ${Errors}
    !insertmacro ChordVStop "$ChordVReason"
  ${EndIf}
  ${If} $ChordVLegacyRoot != ""
  ${AndIf} $INSTDIR != $ChordVLegacyRoot
    !insertmacro ChordVStop "安装目录与已确认的旧版目录不一致，未建立第二套安装。"
  ${EndIf}
  ${If} $ChordVNewRoot != ""
  ${AndIf} $INSTDIR != $ChordVNewRoot
    !insertmacro ChordVStop "安装目录与现有 ChordV 目录不一致。"
  ${EndIf}
  ${If} $ChordVLegacyRoot == ""
  ${AndIf} $ChordVNewRoot == ""
    ${If} ${FileExists} "$INSTDIR\*"
      !insertmacro ChordVStop "目标目录非空且没有可确认的安装记录，未覆盖目录内容。"
    ${EndIf}
  ${EndIf}
  !insertmacro ChordVPayloadCheck ""
  !insertmacro ChordVLegacyPaths ""
FunctionEnd

!macro customInit
  SetShellVarContext current
  !insertmacro ChordVCheckQAProfile
  Call ChordVParseParameters
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 != 0
    !insertmacro ChordVStop "请以当前普通用户运行此安装器，不使用管理员身份。"
  ${EndIf}
  !insertmacro ChordVAcquireGate
  Call ChordVReadRegistry
  ${If} $ChordVLegacyRoot != ""
    ${If} $ChordVUpdate != 1
      !insertmacro ChordVStop "检测到旧版 ChordV；此受限迁移必须显式使用 /UPDATE。"
    ${EndIf}
    ${GetOptions} $ChordVRawCommand "/D=" $0
    ${IfNot} ${Errors}
    ${AndIf} $INSTDIR != $ChordVLegacyRoot
      !insertmacro ChordVStop "/D 指定目录与旧版安装记录冲突。"
    ${EndIf}
    StrCpy $INSTDIR $ChordVLegacyRoot
    StrCpy $ChordVLegacyAliases 1
  ${ElseIf} $ChordVNewRoot != ""
    ${GetOptions} $ChordVRawCommand "/D=" $0
    ${IfNot} ${Errors}
    ${AndIf} $INSTDIR != $ChordVNewRoot
      !insertmacro ChordVStop "/D 指定目录与现有安装记录冲突。"
    ${EndIf}
    StrCpy $INSTDIR $ChordVNewRoot
  ${ElseIf} $ChordVUpdate == 1
    !insertmacro ChordVStop "没有可确认的已安装版本，未将更新当作全新安装。"
  ${EndIf}
  Call ChordVCheckTarget
  ${If} $ChordVUpdate == 1
    !insertmacro ChordVWaitWritable "ChordV.exe"
    !insertmacro ChordVWaitWritable "chordv-desktop.exe"
    !insertmacro ChordVWaitWritable "chordv_desktop.exe"
  ${EndIf}
!macroend

; Directory-page changes must receive the same checks as silent installs.
Function .onVerifyInstDir
  StrCpy $ChordVDirectoryCheck 1
  Call ChordVCheckTarget
  StrCpy $ChordVDirectoryCheck 0
FunctionEnd

; These are native MUI PRE callbacks, injected before the locked generator
; expands DIRECTORY/FINISH. Abort skips a page; it does not make /P silent.
Function ChordVDirectoryPre
  Call ChordVCheckTarget
  ${If} $ChordVPassive == 1
    Abort
  ${EndIf}
FunctionEnd

Function ChordVFinishPre
  ${If} $ChordVPassive == 1
    Abort
  ${EndIf}
FunctionEnd

Function .onInstSuccess
  ${If} $ChordVRestart == 1
    ClearErrors
    Exec '$\"$INSTDIR\ChordV.exe$\" $ChordVRestartArgs'
    ${If} ${Errors}
      !insertmacro ChordVStop "安装已完成，但程序重启失败。"
    ${EndIf}
  ${EndIf}
  !insertmacro ChordVReleaseGate
FunctionEnd

Function .onGUIEnd
  !insertmacro ChordVReleaseGate
FunctionEnd

Function un.onInit
  SetShellVarContext current
  !insertmacro ChordVCheckQAProfile
  System::Call 'shell32::IsUserAnAdmin() i.r0'
  ${If} $0 != 0
    !insertmacro ChordVStop "请以当前普通用户运行卸载程序，不使用管理员身份。"
  ${EndIf}
  !insertmacro ChordVAcquireGate
  Call un.ChordVReadRegistry
  ${If} $ChordVLegacyRoot != ""
    !insertmacro ChordVStop "旧版迁移尚未完成，请先修复安装；未调用旧卸载器或删除目录。"
  ${EndIf}
  ${If} $ChordVNewRoot == ""
  ${OrIf} $ChordVNewRoot != $INSTDIR
    !insertmacro ChordVStop "卸载目录与已确认的 ChordV 安装记录不一致，未删除文件。"
  ${EndIf}
  !insertmacro ChordVPayloadCheck "un."
  !insertmacro ChordVLegacyPaths "un."
FunctionEnd

Function un.onGUIEnd
  !insertmacro ChordVReleaseGate
FunctionEnd
!endif
