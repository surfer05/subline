; Custom NSIS include — see `nsis.include` in electron-builder.js.
;
; WHY THIS FILE EXISTS
;
; electron-builder's default installer refuses to continue while it believes
; the app is running, and shows a modal saying "Subline cannot be closed.
; Please close it manually and click Retry to continue." On a real machine that
; dialog appeared with NO Subline process running at all — confirmed twice,
; once after a reboot — because the check trips on a locked file in the install
; directory as readily as on a live process. There is no way past it: Retry
; re-runs the same failing check, and the only thing that cleared it was
; deleting the install folder by hand from a terminal.
;
; A user cannot be asked to do that. An installer that demands you close an
; application which is not open is a dead end wearing a Retry button.
;
; WHAT THIS DOES INSTEAD
;
; Overrides the check with one that ends our own processes and gets on with it.
; Closing Subline is always safe: it holds no unsaved state, every decision it
; makes is written to disk as it goes, and it is about to be replaced anyway.
;
; The scope is deliberately narrow. It force-closes SUBLINE and nothing else —
; Discord is never touched here, because a patch running against a live Discord
; is the installer's problem to handle in its own flow, with the user's consent,
; where it can explain itself.

!macro customCheckAppRunning
  ; /F because a windowless or unresponsive process is exactly the case the
  ; default check cannot get past. /T to take child processes with it, so none
  ; is left holding a file in the directory about to be overwritten.
  nsExec::Exec 'taskkill /F /T /IM ${APP_EXECUTABLE_FILENAME}'
  Pop $0

  ; Windows releases file handles asynchronously after a process ends. Without
  ; this pause the very next step can still find the executable locked, which
  ; is the same failure under a different name.
  Sleep 1500
!macroend

; ---------------------------------------------------------------------------
; customInstall: guarantee the Start Menu shortcut exists.
;
; WHY (root-caused 2026-09-03 from the electron-builder 25.1.8 template
; source): the assisted installer creates shortcuts ONLY when $keepShortcuts
; is "false" (include/installer.nsh:169-194; the "true" branch merely RENAMES
; an existing .lnk). $keepShortcuts is "true" whenever the install registry
; key (HKCU\Software\<APP_GUID> - NOT the Uninstall key) still says
; KeepShortcuts="true" and $INSTDIR still holds the app exe. And with
; allowToChangeInstallationDirectory:false, the only template guard that
; forces recreation is compiled out (installUtil.nsh:88-92).
;
; So: delete the .lnk out-of-band while that registry value persists, and
; EVERY future install completes successfully while silently creating no
; shortcut - the app becomes invisible to the Start Menu and to Windows
; Search, permanently. Observed on a real machine after a manual cleanup
; deleted the .lnk and the Uninstall key but not the install key.
;
; customInstall runs after the template's addStartMenuLink
; (installSection.nsh:81-83), with $newStartMenuLink and $appExe in scope.
; If the template made the shortcut, this is a no-op; if anything ate it, it
; comes back. SetLnkAUMI matches what the template sets on its own shortcuts.
!macro customInstall
  ${ifNot} ${FileExists} "$newStartMenuLink"
    CreateShortCut "$newStartMenuLink" "$appExe"
    WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
  ${endIf}
!macroend
