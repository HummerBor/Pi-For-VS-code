# 从剪贴板取截图存成文件（绕开内嵌图片体积限制）；无图则报错退出
$ErrorActionPreference = "Stop"
try {
  $img = Get-Clipboard -Format Image
} catch {
  Write-Output ("CLIP-ERR " + $_.Exception.Message); exit 1
}
if ($img -eq $null) { Write-Output "NO-IMAGE-IN-CLIPBOARD"; exit 1 }
$path = Join-Path $PSScriptRoot "shot.png"
$img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("SAVED " + $path + " " + $img.Width + "x" + $img.Height)
