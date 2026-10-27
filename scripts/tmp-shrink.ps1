# 借 Get-Clipboard 顺带加载的 System.Drawing 缩图存 JPEG（Add-Type 加载程序集在这台机上不生效）
$img = Get-Clipboard -Format Image
if ($img -eq $null) { Write-Output "NO-IMAGE-IN-CLIPBOARD"; exit 1 }
$w = 420
$h = [int]($img.Height * $w / $img.Width)
$bmp = New-Object System.Drawing.Bitmap $img, $w, $h
$bmp.Save((Join-Path $PSScriptRoot "shot.jpg"), [System.Drawing.Imaging.ImageFormat]::Jpeg)
$img.Dispose(); $bmp.Dispose()
Write-Output "OK shot.jpg"
