@echo off
chcp 65001 >/dev/null
REM ============================================================
REM  AI分身 - Windows 本地打包脚本
REM  用法: 在 Windows 上双击运行，或在 CMD/PowerShell 中执行
REM  前置条件: Node.js 22+, npm, Git
REM ============================================================

setlocal enabledelayedexpansion

echo.
echo ========================================
echo   AI分身 Windows 打包脚本
echo ========================================
echo.

REM --- 检查 Node.js ---
where node >/dev/null 2>&1
if errorlevel 1 (
    echo [错误] 未找到 Node.js，请先安装 Node.js 22+
    echo 下载地址: https://nodejs.org/
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo [信息] Node.js 版本: %%v

REM --- 定位项目根目录 ---
REM 脚本放在 desktop-app/scripts/ 下，往上两级就是 monorepo 根
set "SCRIPT_DIR=%~dp0"
set "DESKTOP_DIR=%SCRIPT_DIR%.."
set "REPO_ROOT=%DESKTOP_DIR%\.."

REM --- 构建 @soul/core ---
echo.
echo [1/5] 构建 @soul/core ...
cd /d "%REPO_ROOT%\packages\core"
call npm ci
if errorlevel 1 (
    echo [错误] @soul/core npm ci 失败
    pause
    exit /b 1
)
call npm run build
if errorlevel 1 (
    echo [错误] @soul/core build 失败
    pause
    exit /b 1
)

REM --- 安装 desktop-app 依赖 ---
echo.
echo [2/5] 安装 desktop-app 依赖 ...
cd /d "%DESKTOP_DIR%"
call npm ci
if errorlevel 1 (
    echo [错误] desktop-app npm ci 失败
    pause
    exit /b 1
)

REM --- 重编译 better-sqlite3 匹配当前 Electron ---
echo.
echo [3/5] 重编译 better-sqlite3 (匹配 Electron ABI) ...
call npx @electron/rebuild -f -w better-sqlite3
if errorlevel 1 (
    echo [错误] better-sqlite3 rebuild 失败
    pause
    exit /b 1
)

REM --- Vite 前端 + Electron 主进程构建 ---
echo.
echo [4/5] 构建前端和 Electron 主进程 ...
call npm run build
if errorlevel 1 (
    echo [错误] build 失败
    pause
    exit /b 1
)
call npm run icons
if errorlevel 1 (
    echo [警告] 图标生成失败，继续打包...
)

REM --- electron-builder 打包 ---
echo.
echo [5/5] 打包 Windows 安装程序 ...
call npx electron-builder --win
if errorlevel 1 (
    echo [错误] electron-builder 打包失败
    pause
    exit /b 1
)

echo.
echo ========================================
echo   打包完成!
echo   安装包位于: %DESKTOP_DIR%\release\
echo ========================================
echo.

REM --- 打开输出目录 ---
explorer "%DESKTOP_DIR%\release"

pause
