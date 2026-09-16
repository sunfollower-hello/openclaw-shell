<#
  表情包打包工具：把一个文件夹里的表情图片 → 自动排序、编号 → 打成一个 zip（含待填写的「说明.txt」）
  用法（三种任选）：
    ① 把表情图片文件夹直接拖到 make-emoji-pack.bat 上
    ② 双击 make-emoji-pack.bat，按提示粘贴文件夹路径
    ③ 命令行：powershell -ExecutionPolicy Bypass -File make-emoji-pack.ps1 -Folder "D:\某文件夹"
  产物：<文件夹名>.zip（与文件夹同级），里面是 1.<原文件名>、2.<原文件名>… 加一份「说明.txt」
  说明：名字取"序号后面那段"（也就是原文件名），所以**先在文件夹里把图改成你想要的名字，再运行本脚本**。
#>
param(
  [string]$Folder = ""
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }

if (-not $Folder -or -not (Test-Path -LiteralPath $Folder -PathType Container)) {
  Say "请把表情图片所在文件夹的路径粘贴进来，回车确认：" "Cyan"
  $Folder = (Read-Host).Trim().Trim('"')
}
if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
  Say "找不到这个文件夹：$Folder" "Red"
  exit 1
}
$Folder = (Resolve-Path -LiteralPath $Folder).Path
$dirName = Split-Path -Leaf $Folder

$exts = @(".png", ".jpg", ".jpeg", ".gif", ".webp")
$files = Get-ChildItem -LiteralPath $Folder -File | Where-Object { $exts -contains $_.Extension.ToLower() }
if ($files.Count -eq 0) {
  Say "这个文件夹里没有 png / jpg / jpeg / gif / webp 图片。" "Red"
  exit 1
}

# 排序：修改时间早的在前（时间相同按文件名），这样"最早的在第一个"
$ordered = $files | Sort-Object @{ Expression = { $_.LastWriteTime } }, @{ Expression = { $_.Name } }

Say ""
Say "共 $($ordered.Count) 张，按修改时间从早到晚编号：" "Cyan"

# 准备临时目录（打包用）
$staging = Join-Path $env:TEMP ("emoji-pack-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# 使用场景按序号填，一行一个；不想写就留空。下面这行是注释，删不删都行。")
$lines.Add("# 例：  1.气氛轻松、想逗对方时用")
$lines.Add("#")

$i = 0
$junk = @()
foreach ($f in $ordered) {
  $i++
  $newName = "$i." + $f.Name          # 只加序号前缀，原名（=表情名字）保留
  Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $staging $newName) -Force
  $lines.Add("$i.")
  $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
  # 提醒：像 IMG_1234 / DSC / 微信导出的随机名，AI 引用起来不好听，建议改成有意义的词
  if ($base -match '^(IMG|DSC|PXL|mmexport|wx_camera|Screenshot)[-_0-9]*$' -or $base -match '^[0-9a-f]{8,}$') {
    $junk += "$i. $base"
  }
  Say ("  {0,3}. {1}" -f $i, $f.Name)
}

# 说明.txt：UTF-8 带 BOM（记事本打开正常，中文不乱码）
$txtPath = Join-Path $staging "说明.txt"
[System.IO.File]::WriteAllLines($txtPath, $lines, (New-Object System.Text.UTF8Encoding($true)))

# 打包：与文件夹同名同级的 zip；已存在则加 -1 -2，不覆盖旧包
$zip = Join-Path (Split-Path -Parent $Folder) ("$dirName.zip")
if (Test-Path -LiteralPath $zip) {
  $n = 1
  while (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $Folder) "$dirName-$n.zip")) { $n++ }
  $zip = Join-Path (Split-Path -Parent $Folder) "$dirName-$n.zip"
  Say "（同名 zip 已存在，本次存为 $(Split-Path -Leaf $zip)）" "DarkYellow"
}
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
[System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zip)
Remove-Item -LiteralPath $staging -Recurse -Force

$size = [math]::Round((Get-Item -LiteralPath $zip).Length / 1KB, 1)
Say ""
Say "✓ 打包完成：$zip  （$size KB，$i 张图 + 说明.txt）" "Green"
Say ""
Say "下一步：打开 zip 里的「说明.txt」，按行把使用场景填上（不想填就留空），" "Cyan"
Say "然后到 SoulBox 的「表情包库」页点「导入 zip」把这个包导进去。" "Cyan"
if ($junk.Count -gt 0) {
  Say ""
  Say "提醒：下面这些文件名看着像导出的乱码名，AI 会拿它当表情名，建议先在文件夹里改成有意义的词再重新打包：" "Yellow"
  foreach ($j in $junk) { Say "  $j" "Yellow" }
}
