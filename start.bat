@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
cd /d "%~dp0"

set "VENV_DIR=venv"
set "MAIN_SCRIPT=puls.py"

set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set http_proxy=
set https_proxy=
set all_proxy=

:: 1. Если рабочий venv уже существует — проверяем Python 3.11+ и наличие ключевых пакетов
if exist "%VENV_DIR%\Scripts\pythonw.exe" (
    "%VENV_DIR%\Scripts\python.exe" -c "import sys, fastapi, uvicorn, bleak, websockets, pystray, PIL; assert sys.version_info >= (3, 11)" >nul 2>&1
    if !ERRORLEVEL! EQU 0 (
        start "" "%VENV_DIR%\Scripts\pythonw.exe" "%MAIN_SCRIPT%"
        exit /b 0
    ) else (
        echo Обнаружено повреждение окружения venv. Пересоздание...
        rmdir /s /q "%VENV_DIR%"
    )
)

:: 2. Если venv нет — ищем системный Python (python -> py -> стандартные пути Windows)
set "SYS_PYTHON="

python -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>&1
if !ERRORLEVEL! EQU 0 set "SYS_PYTHON=python"

if not defined SYS_PYTHON (
    py -3 -c "import sys; assert sys.version_info >= (3, 11)" >nul 2>&1
    if !ERRORLEVEL! EQU 0 set "SYS_PYTHON=py -3"
)

if not defined SYS_PYTHON (
    for %%P in (
        "%LOCALAPPDATA%\Programs\Python\Python314\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python312\python.exe"
        "%LOCALAPPDATA%\Programs\Python\Python311\python.exe"
        "%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe"
    ) do (
        if not defined SYS_PYTHON if exist %%P (
            set "SYS_PYTHON=%%P"
        )
    )
)

if not defined SYS_PYTHON (
    echo ОШИБКА: Требуется Python 3.11+. Убедитесь, что Python установлен.
    pause
    exit /b 1
)

:: 3. Создаем venv и ставим зависимости
echo Создание виртуального окружения и установка пакетов...
%SYS_PYTHON% -m venv "%VENV_DIR%"
"%VENV_DIR%\Scripts\python.exe" -m pip install --upgrade pip
if exist "requirements.txt" (
    "%VENV_DIR%\Scripts\pip.exe" install -r requirements.txt
) else (
    "%VENV_DIR%\Scripts\pip.exe" install fastapi uvicorn bleak websockets pystray pillow
)
if !ERRORLEVEL! NEQ 0 (
    echo ОШИБКА: Не удалось установить зависимости.
    rmdir /s /q "%VENV_DIR%"
    pause
    exit /b 1
)

:: 4. Запуск в фоне через pythonw (без окна консоли)
start "" "%VENV_DIR%\Scripts\pythonw.exe" "%MAIN_SCRIPT%"
exit /b 0