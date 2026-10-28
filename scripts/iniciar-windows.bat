@echo off
chcp 65001 >nul
title RADIO MERCADO DON MANUEL
cd /d "%~dp0\.."
where node >nul 2>nul || (echo [X] Falta Node.js 22 o superior. Descarguelo de https://nodejs.org & pause & exit /b 1)
where ffmpeg >nul 2>nul || (echo [X] Falta FFmpeg. En PowerShell ejecute: winget install Gyan.FFmpeg & pause & exit /b 1)
if not exist .env (
  copy .env.example .env >nul
  echo Se creo el archivo .env. Abralo, escriba una ADMIN_PASSWORD (10+ caracteres con letras y numeros^),
  echo cambie DATA_DIR=./data, PUBLIC_BASE_URL=, TRUST_PROXY=false y COOKIE_SECURE=false, y ejecute de nuevo.
  notepad .env
  pause
  exit /b 0
)
echo Iniciando... (cierre esta ventana para detener la radio local)
node --disable-warning=ExperimentalWarning src\server.js
pause
