@echo off
chcp 65001 >nul
title GencTek Takvim baslatici
REM Mantik scripts\yerel-baslat.ps1 icinde; bu dosya yalnizca sarmalayici.
REM Port 3020 (portal 3010, platform 3000 ile cakismasin diye).
REM Sabit yol degil %~dp0 kullanilir: ust klasor adinda bosluk var.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\yerel-baslat.ps1"
pause
