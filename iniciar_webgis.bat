@echo off
title WebGIS Local Server
cd /d "%~dp0"
echo =====================================================
echo  Iniciando o Servidor Local e abrindo o WebGIS...
echo =====================================================
echo.
python server.py
if %errorlevel% neq 0 (
    echo.
    echo [ERRO] Nao foi possivel iniciar o servidor.
    echo Verifique se o Python esta instalado e configurado corretamente no seu computador.
    echo.
    pause
)
