!macro NSIS_HOOK_PREINSTALL
  ; Refuse an upgrade before copying any files when the existing main executable
  ; cannot be opened exclusively for replacement. Without this guard, NSIS can
  ; leave an old executable beside new licenses and a new uninstaller while
  ; still returning success.
  IfFileExists "$INSTDIR\${MAINBINARYNAME}.exe" 0 yuanyuan_preinstall_ready
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${MAINBINARYNAME}.exe", i 0xC0000000, i 0, p 0, i 3, i 0x80, p 0) p.r0'
  IntCmp $0 -1 yuanyuan_preinstall_blocked yuanyuan_preinstall_opened yuanyuan_preinstall_opened

  yuanyuan_preinstall_opened:
    System::Call 'kernel32::CloseHandle(p r0)'
    Goto yuanyuan_preinstall_ready

  yuanyuan_preinstall_blocked:
    SetErrorLevel 32
    Abort

  yuanyuan_preinstall_ready:
!macroend
