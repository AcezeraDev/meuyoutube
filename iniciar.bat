@echo off
rem Abre o MeuTube: inicia o servidor e abre o navegador em http://localhost:3000
cd /d "%~dp0"
start "" http://localhost:3000
node server.js
pause
