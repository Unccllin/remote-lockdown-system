; lockdown-installer.nsi — the ONE generic agent installer.
;
; Why this exists
; ---------------
; The self-hosted server builds an NSIS installer PER DEVICE, baking config.json
; (server_url + api_key + hostname) into the binary (server/src/routes/
; installer.js). A Cloudflare Worker cannot run `makensis`, so the serverless
; deployment needs a single installer for the whole fleet whose configuration is
; obtained at install time from a short-lived enrolment token.
;
; What this script does — and deliberately does not do
; ----------------------------------------------------
; NSIS owns only the packaging concerns: staging the binaries, the Add/Remove
; Programs entry, and the uninstaller. Everything that touches the device
; (enrolment, config.json, the lockdown folder, the scheduled-task persistence,
; tamper protection, check-in verification) runs through lockdown-installer.exe,
; the same CLI installer a per-device deployment runs (agent/installer.py, built
; from agent/installer.spec).
;
; That split is the whole design: an earlier draft of this file implemented
; enrolment and persistence in PowerShell and registered `sc.exe` services,
; which is a third mechanism nothing else in the product uses — the agent never
; calls StartServiceCtrlDispatcher, so SCM-started processes are killed for not
; reporting status. Duplicating the install path in a scripting language buys a
; second set of bugs, not a second deployment option.
;
; Usage
; -----
;   lockdown-installer.exe                                     (interactive)
;   lockdown-installer.exe --token=TOKEN --server-url=URL      (silent)
;   lockdown-installer.exe /S --token=TOKEN [--server-url=URL]
;
; The space form (--token TOKEN) is accepted too. --server-url defaults to the
; backend the build was configured with (DEFAULT_SERVER_URL), so the dashboard
; only has to hand the operator a token.
;
; Removal is authorized by the backend, not by local administrator rights: the
; uninstaller asks for a token from POST /api/agent/uninstall-auth and refuses
; to touch anything without one. An anti-theft agent with an unauthenticated
; uninstaller has shipped the bypass it exists to prevent.
;
; Build: scripts/build-generic-installer.sh (stages agent/dist/*.exe, runs
; makensis). Publish to KV: binary:installer.
;
; Copyright (c) 2026 Remote Lockdown System. All rights reserved.

Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
!include "nsDialogs.nsh"

; --- Build inputs (overridden on the makensis command line) -------------------
; STAGE is the directory holding the PyInstaller outputs. The build script always
; passes it; the default keeps a bare `makensis lockdown-installer.nsi` working
; from the repo root.
!ifndef STAGE
  !define STAGE "..\..\agent\dist"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "1.0.0"
!endif
; Must match DEFAULT_SERVER_URL in agent/installer.py; the build script reads it
; from there so the two cannot drift.
!ifndef DEFAULT_SERVER_URL
  !define DEFAULT_SERVER_URL "https://lockdown-serverless.mainacollins196.workers.dev"
!endif

!define PRODUCT_NAME "Remote Lockdown Agent"
!define PRODUCT_PUBLISHER "Remote Lockdown"
!define INSTALLER_EXE "lockdown-installer.exe"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}"

Name "${PRODUCT_NAME}"
OutFile "lockdown-installer.exe"
RequestExecutionLevel admin
; agent/installer.py and service_installer.py both install into
; %ProgramData%\LockdownAgent and the agent's state files live there too, so the
; installer must stage into exactly that directory, not Program Files.
;
; NSIS has no $COMMONAPPDATA (that is Inno Setup); $APPDATA resolves to
; C:\ProgramData once SetShellVarContext is set to "all", which both .onInit
; functions do before $INSTDIR is used. InstallDirRegKey is deliberately not used:
; it would resolve in the current-user context before .onInit can switch.
InstallDir "$APPDATA\LockdownAgent"
ShowInstDetails show
ShowUnInstDetails show
SetCompressor /SOLID lzma

Var Token
Var ServerUrl
Var Dialog
Var TokenField
Var UrlField
Var InstallResult
Var UninstallToken

; --- Pages --------------------------------------------------------------------
!define MUI_WELCOMEPAGE_TITLE "Install the Remote Lockdown agent"
!define MUI_WELCOMEPAGE_TEXT "This installer enrols THIS machine with your \
lockdown backend and starts the anti-theft agent.$\r$\n$\r$\nYou need a \
short-lived enrolment token from the dashboard's enrolment page. The token is \
single use and expires after 15 minutes.$\r$\n$\r$\nClick Next to continue."
!insertmacro MUI_PAGE_WELCOME
Page custom CredentialsPageShow CredentialsPageLeave
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Agent installed"
!define MUI_FINISHPAGE_TEXT "The agent is enrolled and running.$\r$\n$\r$\nOpen \
the dashboard and confirm this device appears in the device list."
!insertmacro MUI_PAGE_FINISH

!define MUI_UNWELCOMEPAGE_TITLE "Remove the Remote Lockdown agent"
!define MUI_UNWELCOMEPAGE_TEXT "Removal is authorized by the backend. You need a \
short-lived uninstall token, which is valid for 5 minutes.$\r$\n$\r$\nWithout a \
valid token nothing is removed: the agent is protected against removal by \
design, so that a lost device cannot be disarmed by whoever holds it."
!insertmacro MUI_UNPAGE_WELCOME
UninstPage custom un.TokenPageShow un.TokenPageLeave
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; --- Command-line parsing -----------------------------------------------------
; Reads --name=value and --name value into OUTVAR, leaving it empty when absent.
; (${GetOptions} returns an empty string and sets the error flag when the option
; is not present, so testing for "" covers both forms.)
!macro ReadOpt OPTION OUTVAR
  ${GetOptions} $R0 "${OPTION}=" ${OUTVAR}
  ${If} ${OUTVAR} == ""
    ${GetOptions} $R0 "${OPTION}" ${OUTVAR}
    ; The space form yields a leading space; strip exactly that one character.
    ${If} ${OUTVAR} != ""
      StrCpy $R1 ${OUTVAR} 1
      ${If} $R1 == " "
      ${OrIf} $R1 == "="
        StrCpy ${OUTVAR} ${OUTVAR} "" 1
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

Function .onInit
  SetShellVarContext all ; $APPDATA = C:\ProgramData
  StrCpy $INSTDIR "$APPDATA\LockdownAgent"
  ; An existing install wins over the default: a repair/re-enrol must land on
  ; the same directory the agent, its state and its ACLs already live in.
  ReadRegStr $0 HKLM "Software\${PRODUCT_NAME}" "InstallDir"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}

  ${GetParameters} $R0
  StrCpy $ServerUrl "${DEFAULT_SERVER_URL}"
  !insertmacro ReadOpt "--token" $Token
  !insertmacro ReadOpt "--server-url" $ServerUrl

  ; A silent install has no page to type into, so the token must be on the
  ; command line. The server URL is optional: it defaults to the build's backend.
  ${If} ${Silent}
  ${AndIf} $Token == ""
    MessageBox MB_ICONSTOP "Silent install requires --token=<token> (and optionally --server-url=<url>)."
    Abort
  ${EndIf}

  ; Refuse to run the wizard on top of an existing install: the enrollment would
  ; create a second device record, and the first config would be overwritten.
  ReadRegStr $0 HKLM "Software\${PRODUCT_NAME}" "InstallDir"
  ${If} $0 != ""
    ${If} ${FileExists} "$0\config.json"
      ${If} ${Silent}
        ; Silent re-install over a live agent is legitimate (re-image, repair),
        ; and agent/installer.py re-associates by hardware UUID rather than
        ; creating a duplicate device.
        DetailPrint "Existing installation found at $0 — re-enrolling."
      ${Else}
        MessageBox MB_ICONEXCLAMATION|MB_OK "This machine already has the Remote Lockdown agent installed at:$\r$\n$0$\r$\n$\r$\nRe-running this installer will re-enrol the device and overwrite its configuration. Cancel and use the dashboard if you did not intend that."
      ${EndIf}
    ${EndIf}
  ${EndIf}
FunctionEnd

; --- Install: credentials page ------------------------------------------------
Function CredentialsPageShow
  ${If} $Token != ""
    Abort ; token supplied on the command line: nothing to ask for
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Enrolment" "Paste the token from the dashboard."

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "Enrolment token (single use, valid 15 minutes):"
  Pop $0
  ${NSD_CreateText} 0 13u 100% 12u "$Token"
  Pop $TokenField

  ${NSD_CreateLabel} 0 32u 100% 12u "Backend URL:"
  Pop $0
  ${NSD_CreateText} 0 45u 100% 12u "$ServerUrl"
  Pop $UrlField

  ${NSD_CreateLabel} 0 62u 100% 28u "The token is exchanged for this machine's own API key and is not stored. The URL is pre-filled with the backend this installer was built for."
  Pop $0

  nsDialogs::Show
FunctionEnd

Function CredentialsPageLeave
  ${NSD_GetText} $TokenField $Token
  ${NSD_GetText} $UrlField $ServerUrl
  ${If} $Token == ""
    MessageBox MB_ICONEXCLAMATION "An enrolment token is required."
    Abort
  ${EndIf}
  ${If} $ServerUrl == ""
    MessageBox MB_ICONEXCLAMATION "The backend URL is required."
    Abort
  ${EndIf}
FunctionEnd

; --- Install ------------------------------------------------------------------
Section "Install"
  SetOutPath "$INSTDIR"

  ; The agent binary is mandatory; the wrapper has nothing to install without it.
  File "${STAGE}\lockdown-agent.exe"
  ; The installer is mandatory: it is both the install step below and the
  ; only thing that can authorize a later removal.
  File "${STAGE}\lockdown-installer.exe"
  ; Both companions are optional — the agent degrades to LockWorkStation() when
  ; the lock screen overlay is absent, and the scheduled-task watchdog uses an
  ; inline PowerShell probe when the watchdog exe is absent.
  File /nonfatal "${STAGE}\lockdown-watchdog.exe"
  File /nonfatal "${STAGE}\lockdown-lockscreen.exe"
  ; The pinned Ed25519 update key. Optional: without it the agent accepts updates
  ; verified only by the hash served beside the binary (B-006), which it now
  ; reports per device at check-in. installer.py only names the pin in config.json
  ; when this file is actually present — a configured-but-missing key would make
  ; the agent refuse every future update.
  File /nonfatal "${STAGE}\update_signing.pub"

  DetailPrint "Enrolling this machine with $ServerUrl ..."
  ; agent/installer.py --silent: enroll via POST /api/enroll/claim, write
  ; config.json, create the lockdown folder, install the scheduled task + run
  ; key, apply tamper protection, verify check-in. Exit code 0 means the device
  ; is enrolled AND check-in succeeded.
  nsExec::ExecToLog '"$INSTDIR\${INSTALLER_EXE}" --server-url "$ServerUrl" --token "$Token" --silent'
  Pop $InstallResult

  ${If} $InstallResult != "0"
    MessageBox MB_ICONSTOP "Enrolment failed (exit $InstallResult).$\r$\n$\r$\nThe token may have expired or already be used, or the backend may be unreachable. See the details above. Nothing has been started."
    ; Best effort: drop the staged binaries. If the device was enrolled before
    ; the failure, the backend record remains and can be removed from the
    ; dashboard; the tamper-protection ACLs are only applied on success.
    Delete "$INSTDIR\lockdown-agent.exe"
    Delete "$INSTDIR\${INSTALLER_EXE}"
    Delete "$INSTDIR\lockdown-watchdog.exe"
    Delete "$INSTDIR\lockdown-lockscreen.exe"
    Abort
  ${EndIf}

  ; Add/Remove Programs entry. NoModify/NoRepair: the only supported repair is
  ; re-running this installer, and the only supported removal is the
  ; token-gated uninstaller below.
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKLM "Software\${PRODUCT_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKLM "Software\${PRODUCT_NAME}" "ServerUrl" "$ServerUrl"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${PRODUCT_NAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "${PRODUCT_PUBLISHER}"
  WriteRegStr HKLM "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\lockdown-agent.exe"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKLM "${UNINST_KEY}" "EstimatedSize" $0
SectionEnd

; --- Uninstall ----------------------------------------------------------------
; The uninstaller does not fight tamper protection: the agent's binary, config
; and state files carry DENY DELETE ACEs, and service_installer.uninstall()
; removes them only after the backend confirms the token. If that call fails,
; this script stops rather than deleting a partial install.
Function un.onInit
  SetShellVarContext all ; $APPDATA = C:\ProgramData
  ${un.GetParameters} $R0
  StrCpy $UninstallToken ""
  ; Same two accepted forms as the install side (--uninstall-token=X is what the
  ; NSIS-based workflows use; the space form is accepted for symmetry).
  ${un.GetOptions} $R0 "--uninstall-token=" $UninstallToken
  ${If} $UninstallToken == ""
    ${un.GetOptions} $R0 "--uninstall-token" $UninstallToken
    ${If} $UninstallToken != ""
      StrCpy $R1 $UninstallToken 1
      ${If} $R1 == " "
      ${OrIf} $R1 == "="
        StrCpy $UninstallToken $UninstallToken "" 1
      ${EndIf}
    ${EndIf}
  ${EndIf}

  ReadRegStr $0 HKLM "Software\${PRODUCT_NAME}" "InstallDir"
  ${If} $0 == ""
    StrCpy $0 "$APPDATA\LockdownAgent"
  ${EndIf}
  ${IfNot} ${FileExists} "$0\${INSTALLER_EXE}"
    MessageBox MB_ICONSTOP "Cannot remove the agent: $0\${INSTALLER_EXE} is missing.$\r$\n$\r$\nRe-run the installer if the agent needs to be repaired before removal."
    Abort
  ${EndIf}
FunctionEnd

Function un.TokenPageShow
  ${If} $UninstallToken != ""
    Abort ; token supplied on the command line
  ${EndIf}

  !insertmacro MUI_HEADER_TEXT "Authorize removal" "Request a token, then paste it here."

  nsDialogs::Create 1018
  Pop $Dialog
  ${If} $Dialog == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 40u "Removal must be authorized by the backend. Request an uninstall token for this device (POST /api/agent/uninstall-auth), then paste it below. It is valid for 5 minutes."
  Pop $0
  ${NSD_CreateLabel} 0 44u 100% 12u "Uninstall token:"
  Pop $0
  ${NSD_CreateText} 0 57u 100% 12u ""
  Pop $TokenField

  nsDialogs::Show
FunctionEnd

Function un.TokenPageLeave
  ${NSD_GetText} $TokenField $UninstallToken
  ${If} $UninstallToken == ""
    MessageBox MB_ICONEXCLAMATION "A valid uninstall token is required. The agent stays installed."
    Abort
  ${EndIf}
FunctionEnd

Section "Uninstall"
  ; Run from the installed copy so the working directory and the agent's
  ; "find lockdown-agent.exe next to me" logic both resolve to $INSTDIR.
  SetOutPath "$INSTDIR"
  nsExec::ExecToLog '"$INSTDIR\${INSTALLER_EXE}" --uninstall --uninstall-token "$UninstallToken"'
  Pop $InstallResult

  ${If} $InstallResult != "0"
    MessageBox MB_ICONSTOP "The backend did not authorize this removal (exit $InstallResult).$\r$\n$\r$\nNothing has been removed — the agent is still installed and still checking in. Request a fresh uninstall token and try again."
    Abort
  ${EndIf}

  ; Persistence (scheduled task, run key, tamper ACLs) is already gone. Remove
  ; the files, keeping config.json and the state files until the end so a
  ; partial failure leaves a diagnosable install rather than an orphan.
  Delete "$INSTDIR\lockdown-agent.exe"
  Delete "$INSTDIR\lockdown-watchdog.exe"
  Delete "$INSTDIR\lockdown-lockscreen.exe"
  Delete "$INSTDIR\config.json"
  Delete "$INSTDIR\launch_agent.vbs"
  Delete "$INSTDIR\agent.log"
  Delete "$INSTDIR\watchdog.log"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$INSTDIR\${INSTALLER_EXE}"

  RMDir "$INSTDIR"

  DeleteRegKey HKLM "${UNINST_KEY}"
  DeleteRegKey HKLM "Software\${PRODUCT_NAME}"
SectionEnd
