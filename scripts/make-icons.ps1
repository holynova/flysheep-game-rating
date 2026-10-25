# 生成扩展图标：暗色圆角底 + 金色菱形（暗黑装备风）
Add-Type -AssemblyName System.Drawing

function New-Icon {
    param([int]$Size, [string]$Path)

    $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $g.Clear([System.Drawing.Color]::Transparent)

    # 暗色圆角底
    $radius = [Math]::Max(3, [int]($Size * 0.2))
    $d = $Size - 1
    $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path2.AddArc(0, 0, $radius, $radius, 180, 90)
    $path2.AddArc($d - $radius, 0, $radius, $radius, 270, 90)
    $path2.AddArc($d - $radius, $d - $radius, $radius, $radius, 0, 90)
    $path2.AddArc(0, $d - $radius, $radius, $radius, 90, 90)
    $path2.CloseFigure()
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 18, 20, 30))
    $g.FillPath($bg, $path2)

    # 金色菱形
    $cx = $Size / 2.0
    $cy = $Size / 2.0
    $s = $Size * 0.34
    $pts = @(
        [System.Drawing.PointF]::new($cx, $cy - $s),
        [System.Drawing.PointF]::new($cx + $s, $cy),
        [System.Drawing.PointF]::new($cx, $cy + $s),
        [System.Drawing.PointF]::new($cx - $s, $cy)
    )
    $gold = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 255, 204, 51))
    $g.FillPolygon($gold, $pts)

    # 菱形内衬暗色小菱形，制造宝石感
    $s2 = $s * 0.45
    $pts2 = @(
        [System.Drawing.PointF]::new($cx, $cy - $s2),
        [System.Drawing.PointF]::new($cx + $s2, $cy),
        [System.Drawing.PointF]::new($cx, $cy + $s2),
        [System.Drawing.PointF]::new($cx - $s2, $cy)
    )
    $dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 120, 90, 10))
    $g.FillPolygon($dark, $pts2)

    $g.Dispose()
    $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    Write-Host "created $Path"
}

New-Icon 16  "$PSScriptRoot\..\icons\icon16.png"
New-Icon 48  "$PSScriptRoot\..\icons\icon48.png"
New-Icon 128 "$PSScriptRoot\..\icons\icon128.png"
