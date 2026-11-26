!include "MUI2.nsh"
Name "Continuum"
OutFile "Continuum-Windows-Setup.exe"
InstallDir "$LOCALAPPDATA\Continuum"
RequestExecutionLevel user

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "PortugueseBR"

Section "Continuum"
  SetOutPath "$INSTDIR"
  File "publish\Continuum.exe"
  File "continuum.ico"
  CreateDirectory "$SMPROGRAMS\Continuum"
  CreateShortcut "$SMPROGRAMS\Continuum\Continuum.lnk" "$INSTDIR\Continuum.exe" "" "$INSTDIR\continuum.ico"
  CreateShortcut "$DESKTOP\Continuum.lnk" "$INSTDIR\Continuum.exe" "" "$INSTDIR\continuum.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Continuum\Desinstalar Continuum.lnk" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Continuum.lnk"
  Delete "$SMPROGRAMS\Continuum\Continuum.lnk"
  Delete "$SMPROGRAMS\Continuum\Desinstalar Continuum.lnk"
  RMDir "$SMPROGRAMS\Continuum"
  Delete "$INSTDIR\Continuum.exe"
  Delete "$INSTDIR\continuum.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
