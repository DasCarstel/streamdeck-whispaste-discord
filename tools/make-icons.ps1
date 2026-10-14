<#
    Erzeugt die PNG-Icons des Plugins (Plugin-/Marketplace-Icon + Kategorie-Icon).
    Reines GDI+ (System.Drawing) — keine externen Abhängigkeiten.

    Das Mikrofon wird aus einer 72x72-Vorlage skaliert gezeichnet.

    Aufruf:  powershell -ExecutionPolicy Bypass -File tools\make-icons.ps1
#>
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$imgs = Join-Path $root 'de.tvkopf.whispaste-discord.sdPlugin\imgs\plugin'
New-Item -ItemType Directory -Force -Path $imgs | Out-Null

function New-RoundedPath([double]$x, [double]$y, [double]$w, [double]$h, [double]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# Zeichnet das Mikrofon; Koordinaten aus der 72x72-Vorlage, per $scale vergrößert.
function Draw-Mic($g, [double]$scale, [double]$offsetX, [double]$offsetY, $brush, $pen) {
    $g.FillPath($brush, (New-RoundedPath ($offsetX + 29.5 * $scale) ($offsetY + 11 * $scale) (13 * $scale) (25 * $scale) (6.5 * $scale)))
    $g.DrawArc($pen, [single]($offsetX + 22.5 * $scale), [single]($offsetY + 18 * $scale), [single](27 * $scale), [single](27 * $scale), 0, 180)
    $g.DrawLine($pen, [single]($offsetX + 36 * $scale), [single]($offsetY + 45.5 * $scale), [single]($offsetX + 36 * $scale), [single]($offsetY + 53 * $scale))
    $g.DrawLine($pen, [single]($offsetX + 27.5 * $scale), [single]($offsetY + 54.5 * $scale), [single]($offsetX + 44.5 * $scale), [single]($offsetY + 54.5 * $scale))
}

function New-Icon([string]$path, [int]$size, [bool]$withText) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $green = [System.Drawing.Color]::FromArgb(255, 61, 220, 132)
    $bg = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 16, 20, 24))
    $greenBrush = New-Object System.Drawing.SolidBrush($green)

    $radius = if ($withText) { $size * 0.15 } else { $size * 0.19 }
    $g.FillPath($bg, (New-RoundedPath 0 0 $size $size $radius))

    if ($withText) {
        # Großes Mikrofon oben, Text darunter
        $scale = $size / 72.0 * 0.72
        Draw-Mic $g $scale (($size - 72 * $scale) / 2) ($size * 0.06) $greenBrush (New-Object System.Drawing.Pen($green, [single](3.6 * $scale)))

        $font = New-Object System.Drawing.Font('Segoe UI', [single]($size * 0.105), [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
        $textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 215, 222, 232))
        $format = New-Object System.Drawing.StringFormat
        $format.Alignment = [System.Drawing.StringAlignment]::Center
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        $rect = New-Object System.Drawing.RectangleF(0, [single]($size * 0.78), $size, [single]($size * 0.14))
        $g.DrawString('WhisPaste Diktat', $font, $textBrush, $rect, $format)
        $font.Dispose()
        $textBrush.Dispose()
        $format.Dispose()
    }
    else {
        # Nur Mikrofon, zentriert
        $scale = $size / 72.0 * 0.86
        Draw-Mic $g $scale (($size - 72 * $scale) / 2) (($size - 72 * $scale) / 2) $greenBrush (New-Object System.Drawing.Pen($green, [single](3.6 * $scale)))
    }

    $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Host ("geschrieben: {0} ({1} x {1})" -f (Split-Path -Leaf $path), $size)
}

New-Icon (Join-Path $imgs 'marketplace.png') 288 $true
New-Icon (Join-Path $imgs 'marketplace@2x.png') 576 $true
New-Icon (Join-Path $imgs 'category-icon.png') 28 $false
New-Icon (Join-Path $imgs 'category-icon@2x.png') 56 $false

Get-ChildItem $imgs -Filter *.png | Select-Object Name, Length | Format-Table -AutoSize
