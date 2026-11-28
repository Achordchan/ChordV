!ifndef CHORDV_REGISTRY_INCLUDED
!define CHORDV_REGISTRY_INCLUDED
!define CHORDV_LEGACY_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ChordV"
!define CHORDV_MYGO_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\app.chordv.desktop"

Var ChordVLegacyRoot
Var ChordVNewRoot
Var ChordVOtherLegacyRoot
Var ChordVOtherNewRoot
Var ChordVLegacyAliases

; Exact known uninstall entries only. Never execute UninstallString or infer
; ownership from a folder name, manufacturer key, missing value or executable.
!macro ChordVReadRegistration PREFIX KEY LEGACY TARGET
  StrCpy ${TARGET} ""
  ReadRegStr $0 HKCU "${KEY}" "InstallLocation"
  ReadRegStr $1 HKCU "${KEY}" "DisplayName"
  ReadRegStr $2 HKCU "${KEY}" "UninstallString"
  ${If} "$0$1$2" != ""
    ${If} $1 != "ChordV"
    ${OrIf} $0 == ""
      !insertmacro ChordVStop "发现无法确认归属的 ChordV 安装记录，未覆盖任何文件。"
    ${EndIf}
    !if ${LEGACY} == 1
      StrCpy $1 $0 1
      ${If} $1 == '$\"'
        StrCpy $1 $0 1 -1
        ${If} $1 != '$\"'
          !insertmacro ChordVStop "旧安装目录记录格式不完整，未开始迁移。"
        ${EndIf}
        StrCpy $0 $0 -1 1
      ${EndIf}
      ReadRegStr $1 HKCU "${KEY}" "MainBinaryName"
      ${If} $1 != "ChordV.exe"
      ${AndIf} $1 != "chordv-desktop.exe"
      ${AndIf} $1 != "chordv_desktop.exe"
        !insertmacro ChordVStop "旧安装主程序不在已知入口范围内，未开始迁移。"
      ${EndIf}
    !else
      StrCpy $1 "ChordV.exe"
    !endif
    ${If} $2 != '$\"$0\Uninstall.exe$\"'
      !insertmacro ChordVStop "卸载入口与安装目录不一致，未开始迁移。"
    ${EndIf}
    StrCpy $ChordVPath $0
    Call ${PREFIX}ChordVValidateRoot
    ${If} ${Errors}
      !insertmacro ChordVStop "$ChordVReason"
    ${EndIf}
    ${IfNot} ${FileExists} "$0\$1"
      !insertmacro ChordVStop "安装记录中的主程序不存在，未猜测其他安装位置。"
    ${EndIf}
    StrCpy ${TARGET} $0
    !if ${LEGACY} == 0
      ReadRegDWORD $1 HKCU "${KEY}" "ChordVLegacyAliases"
      ${If} $1 == 1
        StrCpy $ChordVLegacyAliases 1
      ${EndIf}
    !endif
  ${EndIf}
!macroend

!macro ChordVRegistryFunctions PREFIX
Function ${PREFIX}ChordVReadRegistry
  StrCpy $ChordVLegacyAliases 0
  SetRegView 32
  !insertmacro ChordVReadRegistration "${PREFIX}" "${CHORDV_LEGACY_KEY}" 1 $ChordVLegacyRoot
  !insertmacro ChordVReadRegistration "${PREFIX}" "${CHORDV_MYGO_KEY}" 0 $ChordVNewRoot
  ${If} ${RunningX64}
    SetRegView 64
    !insertmacro ChordVReadRegistration "${PREFIX}" "${CHORDV_LEGACY_KEY}" 1 $ChordVOtherLegacyRoot
    !insertmacro ChordVReadRegistration "${PREFIX}" "${CHORDV_MYGO_KEY}" 0 $ChordVOtherNewRoot
    !insertmacro ChordVMergeRoot $ChordVLegacyRoot $ChordVOtherLegacyRoot
    !insertmacro ChordVMergeRoot $ChordVNewRoot $ChordVOtherNewRoot
  ${EndIf}
  SetRegView 32
  ${If} $ChordVLegacyRoot != ""
  ${AndIf} $ChordVNewRoot != ""
  ${AndIf} $ChordVLegacyRoot != $ChordVNewRoot
    !insertmacro ChordVStop "发现两个不同的 ChordV 安装目录，未选择其中任意一个。"
  ${EndIf}
FunctionEnd
!macroend

!macro ChordVMergeRoot TARGET OTHER
  ${If} ${TARGET} != ""
  ${AndIf} ${OTHER} != ""
  ${AndIf} ${TARGET} != ${OTHER}
    !insertmacro ChordVStop "32 位与 64 位安装记录冲突，未开始迁移。"
  ${EndIf}
  ${If} ${TARGET} == ""
    StrCpy ${TARGET} ${OTHER}
  ${EndIf}
!macroend

!insertmacro ChordVRegistryFunctions ""
!insertmacro ChordVRegistryFunctions "un."
!endif
