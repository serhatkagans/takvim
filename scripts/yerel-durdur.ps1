# Takvim sunucusunu durdurur. durdur.bat bunu cagirir.
#
# Yalnizca 3020 portunu dinleyen sureci kapatir; portal (3010) ve platform
# (3000) etkilenmez.
#
# Dosya bilerek yalnizca ASCII: PowerShell 5.1 BOM'suz UTF-8'i bozuk okuyor.

$PORT = 3020

Write-Host ""

$idler = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

if ($idler) {
    foreach ($id in $idler) {
        $surec = Get-Process -Id $id -ErrorAction SilentlyContinue
        if ($surec) {
            Write-Host ("  Takvim kapatiliyor: PID {0} ({1})" -f $id, $surec.ProcessName)
            Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
        }
    }
    Start-Sleep -Seconds 1
} else {
    Write-Host "  Takvim zaten kapali."
}

$kalan = Get-NetTCPConnection -LocalPort $PORT -State Listen -ErrorAction SilentlyContinue
Write-Host ""
if ($kalan) {
    Write-Host "  UYARI: port $PORT hala acik:" -ForegroundColor Red
    $kalan | ForEach-Object { Write-Host ("    PID {0}" -f $_.OwningProcess) }
} else {
    Write-Host "  Durduruldu." -ForegroundColor Green
}

Write-Host ""
Write-Host "  Yeniden baslatmak icin: baslat.bat"
Write-Host ""
