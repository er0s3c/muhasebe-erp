@echo off
rem Muhasebe ERP kurulum sihirbazi (Windows). Cift tiklayin; gerekirse yonetici izni istenir.
rem Secenekler icin: powershell -ExecutionPolicy Bypass -File installer\install.ps1 -?
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\install.ps1" %*
echo.
pause
