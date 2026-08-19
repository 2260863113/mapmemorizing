@echo off
chcp 65001 >nul
title 中国行政区记忆 - 一键启动
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未检测到 Node.js，请先安装：https://nodejs.org （LTS 版即可）
  pause
  exit /b 1
)

if not exist node_modules (
  echo [首次运行] 正在安装依赖，请稍候（约 1-2 分钟）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo.
echo [启动] 正在启动开发服务器：http://localhost:5173
echo [提示] 浏览器将自动打开；关闭本窗口即停止服务。
start "" http://localhost:5173
call npm run dev
pause
