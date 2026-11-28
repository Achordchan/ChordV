!ifndef CHORDV_PATHS_INCLUDED
!define CHORDV_PATHS_INCLUDED

Var ChordVPath
Var ChordVReason

!macro ChordVCheckOwned PREFIX NAME
  StrCpy $ChordVPath "$INSTDIR\${NAME}"
  Call ${PREFIX}ChordVCheckPath
  ${If} ${Errors}
    !insertmacro ChordVStop "安装文件路径无法确认或含链接，尚未继续操作。"
  ${EndIf}
!macroend

!macro ChordVPathFunctions PREFIX
; Checks every existing component, not just the leaf: a safe-looking file
; below a junction must not authorize overwriting/deleting another directory.
Function ${PREFIX}ChordVCheckPath
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $0 $ChordVPath
  ClearErrors
  ${Do}
    System::Call 'kernel32::GetFileAttributesW(w r0) i.r1 ?e'
    Pop $2
    ${If} $1 == -1
      ${If} $2 != 2
      ${AndIf} $2 != 3
        Goto invalid_path
      ${EndIf}
    ${Else}
      IntOp $3 $1 & 0x400
      ${If} $3 != 0
        Goto invalid_path
      ${EndIf}
    ${EndIf}
    ${GetParent} $0 $1
    ${If} $1 == ""
    ${OrIf} $1 == $0
      ${ExitDo}
    ${EndIf}
    StrCpy $0 $1
  ${Loop}
  ClearErrors
  Goto path_done
  invalid_path:
  SetErrors
  path_done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd

; Deliberately per-user only. Custom paths outside the current profile,
; profile base folders, non-canonical paths and junctions remain unsupported.
Function ${PREFIX}ChordVValidateRoot
  Push $0
  Push $1
  Push $2
  StrCpy $ChordVReason "安装目录必须是当前用户目录内的独立应用目录，且不能含链接。"
  StrLen $0 $ChordVPath
  ${If} $0 > 800
  ${OrIf} $0 == 0
    Goto invalid_root
  ${EndIf}
  ; GetFullPathName alone does not reject ADS, wildcards, trailing-dot/space
  ; components or embedded quotes. Do not let Win32 normalize a different file.
  StrCpy $1 0
  ${Do}
    StrCpy $2 $ChordVPath 1 $1
    ${If} $2 == ""
      ${ExitDo}
    ${EndIf}
    ${If} $2 == ':'
      ${If} $1 != 1
        Goto invalid_root
      ${EndIf}
    ${ElseIf} $2 == '*'
    ${OrIf} $2 == '?'
    ${OrIf} $2 == '$\"'
    ${OrIf} $2 == '<'
    ${OrIf} $2 == '>'
    ${OrIf} $2 == '|'
    ${OrIf} $2 == '/'
    ${OrIf} $2 == '$\r'
    ${OrIf} $2 == '$\n'
    ${OrIf} $2 == '$\t'
      Goto invalid_root
    ${EndIf}
    ${If} $2 == '\'
      ; Check the preceding component's final character, not only the root.
      IntOp $2 $1 - 1
      StrCpy $2 $ChordVPath 1 $2
      ${If} $2 == '.'
      ${OrIf} $2 == ' '
        Goto invalid_root
      ${EndIf}
    ${EndIf}
    IntOp $1 $1 + 1
  ${Loop}
  StrCpy $2 $ChordVPath 1 -1
  ${If} $2 == '.'
  ${OrIf} $2 == ' '
    Goto invalid_root
  ${EndIf}
  GetFullPathName $0 $ChordVPath
  ${If} $0 != $ChordVPath
    Goto invalid_root
  ${EndIf}
  StrLen $1 "$PROFILE\"
  StrCpy $2 $0 $1
  ${If} $2 != "$PROFILE\"
    Goto invalid_root
  ${EndIf}
  !insertmacro ChordVRejectBase "$PROFILE"
  !insertmacro ChordVRejectBase "$PROFILE\AppData"
  !insertmacro ChordVRejectBase "$APPDATA"
  !insertmacro ChordVRejectBase "$LOCALAPPDATA"
  !insertmacro ChordVRejectBase "$LOCALAPPDATA\Programs"
  !insertmacro ChordVRejectBase "$TEMP"
  !insertmacro ChordVRejectBase "$DESKTOP"
  !insertmacro ChordVRejectBase "$DOCUMENTS"
  !insertmacro ChordVRejectBase "$SMPROGRAMS"
  !insertmacro ChordVRejectBase "$STARTMENU"
  !insertmacro ChordVRejectBase "$SMSTARTUP"
  !insertmacro ChordVRejectBase "$PROFILE\Downloads"
  !insertmacro ChordVRejectBase "$PROFILE\Pictures"
  !insertmacro ChordVRejectBase "$PROFILE\Videos"
  !insertmacro ChordVRejectBase "$PROFILE\Music"
  System::Call 'kernel32::GetFileAttributesW(w r0) i.r1'
  ${If} $1 != -1
    IntOp $2 $1 & 0x10
    ${If} $2 == 0
      Goto invalid_root
    ${EndIf}
  ${EndIf}
  Call ${PREFIX}ChordVCheckPath
  Goto root_done
  invalid_root:
  SetErrors
  root_done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!macroend

!macro ChordVRejectBase BASE
  ${If} $0 == "${BASE}"
    Goto invalid_root
  ${EndIf}
!macroend

!insertmacro ChordVPathFunctions ""
!insertmacro ChordVPathFunctions "un."
!endif
