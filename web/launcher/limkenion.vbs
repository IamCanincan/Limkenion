On Error Resume Next

Set W = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 启动器所在目录（limkenion.vbs 与 launcher.mjs 同目录）
dir = fso.GetParentFolderName(WScript.ScriptFullName)

' 优先使用包内 Node，缺失再回退系统 PATH 上的 node
nodeExe = dir & "\node\win-x64\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"

' 读取版本
Set e = W.Exec("""" & nodeExe & """ -v")
Do While e.Status = 0
  WScript.Sleep 50
Loop
ver = ""
If e.ExitCode = 0 Then
  Do While e.StdOut.AtEndOfStream = False
    ver = e.StdOut.ReadLine()
  Loop
End If

If e.ExitCode <> 0 Or ver = "" Then
  MsgBox "未找到可用的 Node.js（包内 node 缺失且系统未安装）。" & vbCrLf & vbCrLf & _
         "Limkenion 已内置 Node.js；若 node\win-x64\node.exe 被误删，请重新解压发布包，" & vbCrLf & _
         "或到 https://nodejs.org 安装 Node.js (>= 20.11)。", _
         48, "Limkenion · 缺少 Node.js"
  WScript.Quit 1
End If

' 解析主.次版本号，检查是否 >= 20.11（先去掉开头的 v）
v = Replace(ver, "v", "")
major = CInt(Split(v, ".")(0))
minor = CInt(Split(v, ".")(1))
If major < 20 Or (major = 20 And minor < 11) Then
  MsgBox "Node.js 版本过低（当前 " & ver & "）。" & vbCrLf & vbCrLf & _
         "请重新解压发布包以使用内置的新版 Node.js，或升级系统 Node.js >= 20.11。" & vbCrLf & _
         "下载地址：https://nodejs.org", _
         48, "Limkenion · Node.js 版本过低"
  WScript.Quit 1
End If

' 以隐藏窗口运行启动器，双击不弹任何终端
W.Run """" & nodeExe & """ """ & dir & "\launcher.mjs""", 0, False
