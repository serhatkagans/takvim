# Takvimi yerelde (Windows) baslatir. baslat.bat bunu cagirir.
#
# PORT 3020: ust klasordeki portal 3010'u, platform 3000'i kullaniyor. Sunucunun
# varsayilani da 3010 oldugu icin port burada ortam degiskeniyle veriliyor.
# `node --env-file-if-exists=.env` var olan ortam degiskenini ezmez; ileride
# .env icine PORT=3010 yazilsa bile bu betik 3020'de acar.
#
# Dosya bilerek yalnizca ASCII: PowerShell 5.1 BOM'suz UTF-8'i bozuk okuyor.
$ErrorActionPreference = "Continue"

$proje = Split-Path -Parent $PSScriptRoot
Set-Location $proje

$PORT = 3020
$adres = "http://localhost:$PORT"

function Dinliyor-Mu([int]$port) {
    $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

Write-Host ""
Write-Host "  GencTek Takvim baslatiliyor" -ForegroundColor Cyan
Write-Host "  Klasor: $proje"
Write-Host ""

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "  Node.js bulunamadi. Node 24 veya uzeri kurun." -ForegroundColor Red
    exit 1
}

if (Dinliyor-Mu $PORT) {
    Write-Host "  Takvim zaten calisiyor (port $PORT)."
} else {
    # Alt surec bu ortam degiskenlerini devralir.
    $env:PORT = "$PORT"
    $env:HOST = "127.0.0.1"
    $env:PUBLIC_ORIGIN = $adres

    # Pencere ACIK KALMALI; kapatilirsa sunucu durur.
    Start-Process -FilePath "cmd.exe" `
        -ArgumentList "/k", "title GencTek Takvim sunucusu (port $PORT) && npm start" `
        -WorkingDirectory $proje

    $bitis = (Get-Date).AddSeconds(30)
    while (-not (Dinliyor-Mu $PORT) -and (Get-Date) -lt $bitis) {
        Start-Sleep -Milliseconds 500
    }
}

# Port dinleniyor olmasi yetmez: API gercekten yanit veriyor mu.
$saglikli = $false
try {
    $yanit = Invoke-WebRequest -Uri "$adres/api/meta" -UseBasicParsing -TimeoutSec 15
    $saglikli = ($yanit.StatusCode -eq 200)
} catch {
    $saglikli = $false
}

Write-Host ""
if ($saglikli) {
    Write-Host "  Hazir: $adres" -ForegroundColor Green
    Start-Process $adres
} else {
    Write-Host "  ACILAMADI. Acilan siyah penceredeki hataya bakin." -ForegroundColor Red
}

Write-Host ""
Write-Host "  Sunucu penceresi KAPATILMAMALI." -ForegroundColor Yellow
Write-Host "  Durdurmak icin: durdur.bat"
Write-Host ""
