!include "MUI2.nsh"
Name "Continuum 3.0"
OutFile "Continuum-Windows-Setup.exe"
InstallDir "$LOCALAPPDATA\Continuum"
RequestExecutionLevel user

!define MUI_ABORTWARNING
!define MUI_ICON "continuum.ico"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "PortugueseBR"

Section "Instalar Continuum"
  SetOutPath "$INSTDIR"
  File "publish\Continuum.exe"
  File "continuum.ico"
  CreateDirectory "$SMPROGRAMS\Continuum"
  CreateShortcut "$SMPROGRAMS\Continuum\Continuum.lnk" "$INSTDIR\Continuum.exe" "" "$INSTDIR\continuum.ico"
  CreateShortcut "$DESKTOP\Continuum.lnk" "$INSTDIR\Continuum.exe" "" "$INSTDIR\continuum.ico"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\Continuum\Desinstalar Continuum.lnk" "$INSTDIR\Uninstall.exe"
  Exec "$INSTDIR\Continuum.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Continuum.lnk"
  RMDir /r "$SMPROGRAMS\Continuum"
  Delete "$INSTDIR\Continuum.exe"
  Delete "$INSTDIR\continuum.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
SectionEnd
