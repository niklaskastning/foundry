!include "FileFunc.nsh"

; The withdrawn P04 installer registered T3's directory under Foundry's GUID.
; Reject it before NSIS can run that installation's uninstaller, even with /D.
!macro FoundryCheckDirectory DIRECTORY
  ${GetFileName} "${DIRECTORY}" $R1
  ${If} $R1 != "foundry"
    MessageBox MB_OK|MB_ICONSTOP "Foundry installation stopped: an unsafe installation directory was detected. Preserve your T3 data and repair the old Foundry registration before retrying. Nothing has been uninstalled." /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
!macroend

!macro customInit
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
    !insertmacro FoundryCheckDirectory $R0
  ${EndIf}
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $R0 != ""
    !insertmacro FoundryCheckDirectory $R0
  ${EndIf}
  !insertmacro FoundryCheckDirectory $INSTDIR
!macroend
