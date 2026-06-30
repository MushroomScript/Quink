; Quink 安装/卸载自定义逻辑 (electron-builder nsis 通过 nsis.include 挂载)

!macro customInstall
  ; 写安装标记文件: 主进程 (main.ts) 靠它区分两种形态 —
  ;   有 .installed = 安装版 → 数据存系统 %APPDATA%\Quink
  ;   无 .installed = 绿色版 zip → 便携, 数据存 exe 旁 quink-data
  ; 安装版必须用系统数据目录 (安装目录可能只读 / 卸载会清空), 不能跟程序走.
  FileOpen $0 "$INSTDIR\.installed" w
  FileClose $0
!macroend

!macro customUnInstall
  ; 卸载时询问是否一并删除用户数据 (笔记库 + 上传文件). /SD IDNO: 静默卸载默认不删, 保护数据.
  MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 Quink 的全部数据 (笔记、上传的文件)?$\n$\n选「否」: 保留数据, 重装后可继续使用.$\n选「是」: 彻底删除, 无法恢复." /SD IDNO IDNO quink_keep_data
    RMDir /r "$APPDATA\Quink"
  quink_keep_data:
!macroend
