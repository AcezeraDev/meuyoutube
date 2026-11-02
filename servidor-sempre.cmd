@echo off
rem Mantém o servidor do MeuTube ligado enquanto o PC estiver ligado (é aberto escondido ao entrar no Windows,
rem pelo atalho "MeuTube servidor.vbs" na pasta Inicializar). Se o servidor cair, ele volta sozinho em 5 segundos.
rem Registro do que acontece: servidor.log, nesta pasta.
rem As esperas usam "ping" porque o "timeout" do Windows não funciona sem janela (falhava na hora e o script
rem religava o servidor dezenas de vezes por segundo).
cd /d "%~dp0"
:loop
rem Já tem um MeuTube aberto (por exemplo, pelo iniciar.bat)? Espera ele fechar, sem abrir outro.
netstat -ano | findstr /r /c:":3000 .*LISTENING" > nul && (ping -n 31 127.0.0.1 > nul & goto loop)
echo [%date% %time%] iniciando o servidor >> servidor.log
node server.js >> servidor.log 2>&1
ping -n 6 127.0.0.1 > nul
goto loop
