@echo off
REM TurboDM Browser Extension Setup Helper
REM This script helps users install the TurboDM browser extension

setlocal enabledelayedexpansion

echo.
echo ========================================
echo TurboDM Browser Extension Setup
echo ========================================
echo.
echo The TurboDM application has been installed successfully!
echo.
echo To enable the browser extension for enhanced downloads:
echo.
echo 1. Your browser is opening to the extensions page...
echo 2. Look for "TurboDM" in the extensions list
echo 3. Click "Enable" or "Add to Chrome/Edge"
echo.
echo The extension will allow you to:
echo - Download videos with a single click
echo - Use TurboDM for all your downloads
echo - Enjoy faster, more reliable downloads
echo.
echo ========================================
echo.

REM Detect and open browser
REM Try Chrome first
tasklist /FI "IMAGENAME eq chrome.exe" 2>NUL | find /I /N "chrome.exe">NUL
if "%ERRORLEVEL%"=="0" (
    echo Opening Chrome...
    start chrome chrome://extensions
) else (
    REM Try Edge
    tasklist /FI "IMAGENAME eq msedge.exe" 2>NUL | find /I /N "msedge.exe">NUL
    if "%ERRORLEVEL%"=="0" (
        echo Opening Edge...
        start msedge edge://extensions
    ) else (
        REM Try to open Chrome from default location
        if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
            echo Opening Chrome...
            start "C:\Program Files\Google\Chrome\Application\chrome.exe" "chrome://extensions"
        ) else if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
            echo Opening Chrome...
            start "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" "chrome://extensions"
        ) else if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
            echo Opening Edge...
            start "C:\Program Files\Microsoft\Edge\Application\msedge.exe" "edge://extensions"
        ) else (
            echo.
            echo Could not automatically detect your browser.
            echo.
            echo Please open Chrome or Edge manually and navigate to:
            echo - Chrome: chrome://extensions
            echo - Edge: edge://extensions
            echo.
            echo Then search for "TurboDM" and enable the extension.
            echo.
        )
    )
)

echo.
echo Setup complete! Press any key to close this window...
pause > NUL
exit /b 0
