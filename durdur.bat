@echo off
chcp 65001 >nul
title GencTek Takvim durdurucu
REM Mantik scripts\yerel-durdur.ps1 icinde; bu dosya yalnizca sarmalayici.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\yerel-durdur.ps1"
pause
