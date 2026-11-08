@echo off
chcp 936 >nul
setlocal
rem ============================================================
rem  把 pixel-border-studio 安装到 Lumina Studio 的「创意工坊」
rem  前置条件：Lumina Studio 已在运行（launcher 启动，后端 8000 端口监听）
rem  用法：双击本文件，或在该目录下执行 install-to-lumina.cmd
rem ============================================================
set "BASE=http://127.0.0.1:8000/api/workshop/v1"
rem 允许用环境变量覆盖后端地址（仅用于本地联调/自测）
if defined PBS_WORKSHOP_BASE set "BASE=%PBS_WORKSHOP_BASE%"
set "MODULE_ID=studio.pixelborder.pixelator"
rem 包名与版本从 dist 目录里自动识别（dist 里通常只保留最新一个），避免改版本号后忘改脚本
set "PKG="
for %%F in ("%~dp0..\artifacts\*.lumina-workshop") do set "PKG=%%~fF"
if not defined PKG goto nopkg
for %%F in ("%PKG%") do set "PKGNAME=%%~nxF"
set "VERSION=%PKGNAME:studio.pixelborder.pixelator-=%"
set "VERSION=%VERSION:.lumina-workshop=%"
set "D=%~dp0"

echo [1/4] 检查 Lumina 后端 ...
curl.exe -sS -f -m 8 -o NUL "%BASE%/modules" 2>NUL
if errorlevel 1 goto nohost
echo   ok: 后端可访问

if not exist "%PKG%" goto nopkg

echo [2/4] 上传模块包（装成未激活候选）...
curl.exe -sS -f -m 180 -o "%D%_install.json" -F "archive=@%PKG%;filename=%PKGNAME%" "%BASE%/install/local"
if errorlevel 1 goto installfail
type "%D%_install.json"
echo.

echo [3/4] 激活 %MODULE_ID%@%VERSION% ...
> "%D%_activate_body.json" echo {"version":"%VERSION%"}
curl.exe -sS -f -m 60 -o "%D%_activate_out.json" -X POST -H "Content-Type: application/json" --data-binary "@%D%_activate_body.json" "%BASE%/modules/%MODULE_ID%/activate"
if errorlevel 1 goto activatefail
type "%D%_activate_out.json"
echo.

echo [4/4] 校验已安装列表 ...
curl.exe -sS -f -m 30 -o "%D%_modules.json" "%BASE%/modules"
if errorlevel 1 goto verifyfail
findstr /C:"%MODULE_ID%" "%D%_modules.json" >NUL
if errorlevel 1 goto verifyfail
echo   ok: 已安装 %MODULE_ID%

echo.
echo 完成。回到 Lumina Studio 打开「创意工坊」，启动「像素工坊」。
echo 提示：本地（非官方）模块的运行时页面需要桌面应用自己的 token，请在应用内打开。
goto end

:nohost
echo   失败：连不上 %BASE%/modules
echo   -^> 先启动 Lumina Studio（Lumina Launcher -^> 打开应用），再运行本脚本。
echo   -^> 若应用已运行仍失败，检查端口：%%APPDATA%%\lumina-electron\backend-port.json
goto end
:nopkg
echo   失败：找不到模块包 %PKG%
echo   -^> 先在 web\module 下执行 node scripts\package.mjs
goto end
:installfail
echo   失败：install/local 未返回成功，响应如下：
type "%D%_install.json" 2>NUL
goto end
:activatefail
echo   失败：activate 未返回成功，响应如下：
type "%D%_activate_out.json" 2>NUL
goto end
:verifyfail
echo   失败：/modules 里没有找到 %MODULE_ID%，响应如下：
type "%D%_modules.json" 2>NUL
goto end

:end
endlocal
