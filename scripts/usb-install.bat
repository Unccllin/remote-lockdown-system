@echo off
REM === Remote Lockdown Agent - USB Auto-Installer ===
REM
REM Right-click this file and select "Run as administrator"
REM
REM This script:
REM   1. Copies the agent to C:\ProgramData\LockdownAgent\
REM   2. Installs the watchdog (scheduled task + registry run key)
REM   3. Launches the agent immediately
REM   4. Verifies the agent is running
REM
REM The agent will check in with the server every 10 seconds.
REM It will NOT lock down until "Flag as Stolen" is issued from the dashboard.

cd /d "%~dp0lockdown-agent"

echo ============================================
echo   Remote Lockdown Agent - USB Installer
echo ============================================
echo.

REM --- Check admin privileges ---
net session >nul 2>&1
if errorlevel 1 (
    echo ERROR: This script must be run as Administrator!
    echo Right-click install.bat and select "Run as administrator"
    echo.
    pause
    exit /b 1
)

echo [OK] Running as Administrator
echo.

REM --- Check files exist ---
if not exist "lockdown-agent.exe" (
    echo ERROR: lockdown-agent.exe not found in D:\lockdown-agent\
    pause
    exit /b 1
)
if not exist "service-installer.exe" (
    echo ERROR: service-installer.exe not found in D:\lockdown-agent\
    pause
    exit /b 1
)
if not exist "config.json" (
    echo ERROR: config.json not found in D:\lockdown-agent\
    pause
    exit /b 1
)

echo [OK] All required files present
echo.

REM --- Step 1: Create install directory and copy files ---
echo [1/4] Installing agent to C:\ProgramData\LockdownAgent\...

if not exist "C:\ProgramData\LockdownAgent" mkdir "C:\ProgramData\LockdownAgent"

copy /Y "lockdown-agent.exe" "C:\ProgramData\LockdownAgent\lockdown-agent.exe" >nul
copy /Y "config.json" "C:\ProgramData\LockdownAgent\config.json" >nul
copy /Y "hp_model_overrides.json" "C:\ProgramData\LockdownAgent\hp_model_overrides.json" >nul

if errorlevel 1 (
    echo ERROR: Failed to copy agent files!
    pause
    exit /b 1
)

echo [OK] Agent files copied to C:\ProgramData\LockdownAgent\
echo.

REM --- Step 2: Create test folders (for lockdown testing) ---
echo [2/4] Creating test folders...

if not exist "C:\LockdownTest\SecureData" mkdir "C:\LockdownTest\SecureData"

if not exist "C:\LockdownTest\SecureData\test-secret.txt" (
    echo This is sensitive data for lockdown testing > "C:\LockdownTest\SecureData\test-secret.txt"
)
if not exist "C:\LockdownTest\SecureData\document.txt" (
    echo Another important document for testing encryption. > "C:\LockdownTest\SecureData\document.txt"
)

echo [OK] Test folders created at C:\LockdownTest\SecureData\
echo.

REM --- Step 3: Install the watchdog service ---
echo [3/4] Installing watchdog (scheduled task + registry run key)...

REM Run the service installer from the installed location
cd /d "C:\ProgramData\LockdownAgent"
"%~dp0lockdown-agent\service-installer.exe" install

if errorlevel 1 (
    echo.
    echo WARNING: Service installer returned an error.
    echo The agent may still have been launched. Check task manager.
    echo.
) else (
    echo.
    echo [OK] Watchdog installed - agent will auto-restart if killed
)
echo.

REM --- Step 4: Verify ---
echo [4/4] Verifying installation...

REM Check if agent is running
tasklist /FI "IMAGENAME eq lockdown-agent.exe" 2>nul | find "lockdown-agent.exe" >nul
if errorlevel 1 (
    echo WARNING: lockdown-agent.exe is not currently running.
    echo The watchdog will launch it within 5 minutes, or you can reboot.
    echo.
    echo Launching agent now...
    start "" "C:\ProgramData\LockdownAgent\lockdown-agent.exe" --config "C:\ProgramData\LockdownAgent\config.json" --silent
    timeout /t 3 >nul
    tasklist /FI "IMAGENAME eq lockdown-agent.exe" 2>nul | find "lockdown-agent.exe" >nul
    if errorlevel 1 (
        echo ERROR: Agent failed to start. Check C:\ProgramData\LockdownAgent\ for logs.
    ) else (
        echo [OK] Agent is now running
    )
) else (
    echo [OK] lockdown-agent.exe is running
)

REM Check scheduled task
schtasks /Query /TN "SystemHealthMonitor" >nul 2>&1
if errorlevel 1 (
    echo WARNING: Scheduled task not found - watchdog may not be installed
) else (
    echo [OK] Watchdog scheduled task is installed
)

REM Check registry key
reg query "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v "SystemHealthMonitor" >nul 2>&1
if errorlevel 1 (
    echo WARNING: Registry run key not found - backup persistence not installed
) else (
    echo [OK] Registry run key is installed (backup persistence)
)

echo.
echo ============================================
echo   Installation Complete!
echo ============================================
echo.
echo   Agent location:  C:\ProgramData\LockdownAgent\
echo   Config:          C:\ProgramData\LockdownAgent\config.json
echo   Server:          (see config.json)
echo   Poll interval:   10 seconds
echo.
echo   The agent will check in with the server automatically.
echo   Use the dashboard to "Flag as Stolen" to trigger lockdown.
echo.
echo   To verify the deadman file is encrypted:
echo     powershell -Command "Get-Content C:\ProgramData\LockdownAgent\.deadman -Encoding Byte -TotalCount 4"
echo     (Should show: 76 68 83 49 = "LDS1" magic header)
echo.
echo   To uninstall: run service-installer.exe uninstall
echo ============================================
echo.
pause
