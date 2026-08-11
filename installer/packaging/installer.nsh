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
