; Threads AutoPoster -- NSIS installer
; (Bypasses electron-builder's winCodeSign issue by using NSIS directly)

!define APP_NAME "Threads AutoPoster"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "Eileen42"
!define APP_EXE "ThreadsAutoPoster.exe"
!define APP_URL "https://threads-autoposter.vercel.app"

Unicode true
SetCompressor /SOLID lzma

Name "${APP_NAME}"
OutFile "..\dist-electron\ThreadsAutoPoster-Setup-${APP_VERSION}.exe"

RequestExecutionLevel user
InstallDir "$LOCALAPPDATA\Programs\${APP_NAME}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"

!include "MUI2.nsh"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Run ${APP_NAME} now"
!define MUI_FINISHPAGE_LINK "Open Web App (${APP_URL})"
!define MUI_FINISHPAGE_LINK_LOCATION "${APP_URL}"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Korean"
!insertmacro MUI_LANGUAGE "English"

Section "Install"
  SetOutPath "$INSTDIR"
  File /r "..\dist-electron\win-unpacked\*.*"

  ; Start Menu shortcuts
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"
  CreateShortcut "$SMPROGRAMS\${APP_NAME}\Uninstall.lnk" "$INSTDIR\Uninstall.exe"

  ; Desktop shortcut
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}"

  ; Auto-start at Windows login (current user only)
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_NAME}" '"$INSTDIR\${APP_EXE}" --hidden'

  ; Add/Remove Programs entry
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayName" "${APP_NAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "Publisher" "${APP_PUBLISHER}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "DisplayIcon" "$INSTDIR\${APP_EXE}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}" "URLInfoAbout" "${APP_URL}"

  WriteUninstaller "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  ; Kill running app
  ExecWait 'taskkill /F /IM "${APP_EXE}"' $0

  ; Remove auto-start
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_NAME}"

  ; Remove shortcuts
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"

  ; Remove install dir
  RMDir /r "$INSTDIR"

  ; Cleanup registry
  DeleteRegKey HKCU "Software\${APP_NAME}"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
SectionEnd
