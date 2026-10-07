@echo off
chcp 65001 >nul
title 实验对话系统 · 局域网预实验
cd /d "%~dp0"

rem 选择 Node：优先用包内捆绑的 node.exe，其次用系统已装的 node
set "NODE_EXE="
if exist "%~dp0node.exe" set "NODE_EXE=%~dp0node.exe"
if not defined NODE_EXE (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo  [!] 没有找到 Node.js 运行环境。
    echo      本包正常应附带 node.exe，请确认整个文件夹已完整解压、文件未被移动。
    echo      或到 https://nodejs.org/ 安装 Node.js 22 以上版本后重试。
    echo.
    pause
    exit /b 1
  )
  set "NODE_EXE=node"
)

rem 首次运行：初始化数据库（建表 + 灌入实验模板与预设问卷）
if not exist "data.db" (
  echo 首次运行，正在初始化数据库...
  "%NODE_EXE%" scripts\reset-db.js
  if errorlevel 1 (
    echo.
    echo  [!] 数据库初始化失败，请截图本窗口联系研究者。
    echo.
    pause
    exit /b 1
  )
)

echo.
echo  即将启动服务，请注意：
echo   1. 若 Windows 弹出「防火墙」提示，请勾选「专用网络」并点击「允许访问」，
echo      否则手机将无法连接。
echo   2. 启动后会自动打开「手机扫码进入实验」页面，用手机相机扫码即可。
echo   3. 实验期间请勿关闭本窗口（关闭窗口 = 停止服务，数据不会丢失）。
echo.
set "OPEN_CONNECT=1"
"%NODE_EXE%" server.js

echo.
echo  服务已停止。所有数据保存在本文件夹的 data.db 文件中。
pause
