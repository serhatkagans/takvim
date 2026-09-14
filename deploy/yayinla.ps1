# GencTek Etkinlik Takvimi - sunucuya yayinla (https://aiotechs.cloud/genctektakvim)
#
#   .\deploy\yayinla.ps1
#
# Adimlar: testler -> kod arsivi -> scp -> sunucuda deploy/kur.sh.
# Proje git deposu olmadigi icin sunucu koddan cekmez; arsiv gonderilir.
# Veri (data/), .env, node_modules ve testler arsive GIRMEZ.
#
# Sunucuya ~/.ssh/config icindeki "genctek" kaydiyla (anahtar) baglanilir.
# Dosya bilerek yalnizca ASCII: PowerShell 5.1 BOM'suz UTF-8'i bozuk okuyor.

$ErrorActionPreference = "Stop"
$proje = Split-Path -Parent $PSScriptRoot
Set-Location $proje

Write-Host "==> [1/3] Testler" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { Write-Host "!!! Testler gecmedi; yayin yapilmadi." -ForegroundColor Red; exit 1 }

Write-Host "==> [2/3] Arsiv hazirlaniyor" -ForegroundColor Cyan
$arsiv = Join-Path $env:TEMP "genctektakvim.tar.gz"
if (Test-Path $arsiv) { Remove-Item $arsiv }
tar -czf $arsiv package.json package-lock.json server.mjs lib public scripts deploy
if ($LASTEXITCODE -ne 0) { Write-Host "!!! Arsiv olusturulamadi." -ForegroundColor Red; exit 1 }

Write-Host "==> [3/3] Sunucuya gonderiliyor ve kuruluyor" -ForegroundColor Cyan
scp $arsiv genctek:/tmp/genctektakvim.tar.gz
if ($LASTEXITCODE -ne 0) { Write-Host "!!! Gonderim basarisiz." -ForegroundColor Red; exit 1 }
ssh genctek "tar -xzf /tmp/genctektakvim.tar.gz -O deploy/kur.sh | bash -s /tmp/genctektakvim.tar.gz"
if ($LASTEXITCODE -ne 0) {
    Write-Host "!!! Kurulum basarisiz. Gunluk: ssh genctek 'journalctl -u genctektakvim -n 50 --no-pager'" -ForegroundColor Red
    exit 1
}
Remove-Item $arsiv

Write-Host ""
Write-Host "==> Tamamlandi: https://aiotechs.cloud/genctektakvim/" -ForegroundColor Green
