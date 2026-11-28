!ifndef CHORDV_INSTALL_ACTIONS_INCLUDED
!define CHORDV_INSTALL_ACTIONS_INCLUDED

!macro ChordVLegacyPaths PREFIX
  ${If} $ChordVLegacyAliases == 1
    !insertmacro ChordVCheckOwned "${PREFIX}" "chordv-desktop.exe"
    !insertmacro ChordVCheckOwned "${PREFIX}" "chordv_desktop.exe"
    !insertmacro ChordVCheckOwned "${PREFIX}" "bin\xray.exe"
    !insertmacro ChordVCheckOwned "${PREFIX}" "bin\geoip.dat"
    !insertmacro ChordVCheckOwned "${PREFIX}" "bin\geosite.dat"
  ${EndIf}
!macroend

!macro ChordVWaitWritable NAME
  ${If} ${FileExists} "$INSTDIR\${NAME}"
    StrCpy $2 0
    ${Do}
      ; OPEN_EXISTING never creates or changes an old executable. Only a
      ; bounded wait: do not kill arbitrary processes based on a name.
      System::Call 'kernel32::CreateFileW(w "$INSTDIR\${NAME}", i0x40000000, i7, p0, i3, i0x80, p0) p.r0'
      ${If} $0 != -1
        System::Call 'kernel32::CloseHandle(p r0)'
        ${ExitDo}
      ${EndIf}
      IntOp $2 $2 + 1
      ${If} $2 >= 60
        !insertmacro ChordVStop "旧版程序仍被占用或不可写；安装尚未替换文件。"
      ${EndIf}
      Sleep 250
    ${Loop}
  ${EndIf}
!macroend

!macro ChordVRefreshAlias NAME
  ClearErrors
  Delete "$INSTDIR\${NAME}"
  ${If} ${Errors}
    !insertmacro ChordVStop "旧入口无法替换；主程序已安装，但迁移尚未完成。"
  ${EndIf}
  System::Call 'kernel32::CreateHardLinkW(w "$INSTDIR\${NAME}", w "$INSTDIR\ChordV.exe", p0) i.r0'
  ${If} $0 == 0
    ClearErrors
    CopyFiles /SILENT "$INSTDIR\ChordV.exe" "$INSTDIR\${NAME}"
    ${If} ${Errors}
      !insertmacro ChordVStop "旧入口迁移失败；主程序已安装，未移除旧安装记录。"
    ${EndIf}
  ${EndIf}
!macroend

!macro ChordVDeleteLegacySeeds
  Delete "$INSTDIR\bin\xray.exe"
  Delete "$INSTDIR\bin\geoip.dat"
  Delete "$INSTDIR\bin\geosite.dat"
  RMDir "$INSTDIR\bin"
!macroend

!macro customInstall
  ; MyGo has already copied the new payload and written its uninstall entry.
  ; Only retire the old registry after every historical entry is refreshed.
  ${If} $ChordVLegacyAliases == 1
    !insertmacro ChordVRefreshAlias "chordv-desktop.exe"
    !insertmacro ChordVRefreshAlias "chordv_desktop.exe"
    !insertmacro ChordVDeleteLegacySeeds
    WriteRegDWORD HKCU "${CHORDV_MYGO_KEY}" "ChordVLegacyAliases" 1
  ${EndIf}
  ${If} $ChordVLegacyRoot != ""
    SetRegView 32
    DeleteRegKey HKCU "${CHORDV_LEGACY_KEY}"
    ${If} ${RunningX64}
      SetRegView 64
      DeleteRegKey HKCU "${CHORDV_LEGACY_KEY}"
    ${EndIf}
    SetRegView 32
  ${EndIf}
  ; Consolidate a previously verified same-root 64-bit MyGo entry. The
  ; generated installer writes one current-user 32-bit entry consistently.
  ${If} ${RunningX64}
    SetRegView 64
    DeleteRegKey HKCU "${CHORDV_MYGO_KEY}"
    SetRegView 32
  ${EndIf}
  ${If} $ChordVPassive == 1
    SetAutoClose true
  ${EndIf}
!macroend

!macro customUnInstall
  ; The MyGo template unconditionally follows this hook with RMDir /r.
  ; Return exits the uninstall section before that instruction: remove only
  ; this build's compiled-in leaf list, never user data or an editable list.
  !insertmacro ChordVPayloadDelete
  ${If} $ChordVLegacyAliases == 1
    Delete "$INSTDIR\chordv-desktop.exe"
    Delete "$INSTDIR\chordv_desktop.exe"
    !insertmacro ChordVDeleteLegacySeeds
  ${EndIf}
  ${If} ${RunningX64}
    SetRegView 64
    DeleteRegKey HKCU "${CHORDV_MYGO_KEY}"
    SetRegView 32
  ${EndIf}
  RMDir "$INSTDIR"
  !insertmacro ChordVReleaseGate
  Return
!macroend
!endif
