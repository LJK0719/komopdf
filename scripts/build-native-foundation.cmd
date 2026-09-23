@echo off
setlocal
set "ROOT=%~dp0.."
set "VSCMD_SKIP_SENDTELEMETRY=1"
if not exist "%ROOT%\tmp\native-build" mkdir "%ROOT%\tmp\native-build"
set "TMP=%ROOT%\tmp\native-build"
set "TEMP=%TMP%"
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if errorlevel 1 exit /b %errorlevel%
cmake -S "%ROOT%\native\pdf-core" -B "%ROOT%\native\pdf-core\build\windows-x64" -G Ninja -DCMAKE_BUILD_TYPE=Release
if errorlevel 1 exit /b %errorlevel%
cmake --build "%ROOT%\native\pdf-core\build\windows-x64"
if errorlevel 1 exit /b %errorlevel%
ctest --test-dir "%ROOT%\native\pdf-core\build\windows-x64" --output-on-failure
exit /b %errorlevel%
