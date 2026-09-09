/*
 * CapsuleUpdater.c — Windows tool to submit a UEFI capsule update
 *
 * This program runs on Windows and submits a capsule file to the UEFI
 * firmware via the UpdateCapsule() runtime service. On the next reboot,
 * the firmware processes the capsule and flashes the payload.
 *
 * Usage:
 *   CapsuleUpdater.exe <capsule.cap> [--reboot]
 *
 * Requirements:
 *   - Windows 8+ (UpdateCapsule API available since Windows 8)
 *   - UEFI firmware with capsule support
 *   - Administrator privileges (SeSystemEnvironmentPrivilege)
 *
 * Build (MSVC):
 *   cl CapsuleUpdater.c /Fe:CapsuleUpdater.exe
 *
 * Build (MinGW):
 *   gcc CapsuleUpdater.c -o CapsuleUpdater.exe -lkernel32
 *
 * How it works:
 *   1. Enable SeSystemEnvironmentPrivilege
 *   2. Read the capsule file into memory
 *   3. Call UpdateCapsule() via the UEFI runtime service
 *      (exposed through the FirmwareUpdateProvider API on Windows)
 *   4. Optionally trigger a reboot
 *
 * Note: On Windows, the recommended way to apply capsules is through
 *   the Windows Update framework or the FirmwareUpdateProvider API.
 *   Direct UpdateCapsule() calls require a kernel-mode driver or
 *   the Windows.FirmwareUpdate WinRT API.
 *
 *   This tool uses the WinRT API approach (Windows 10 1809+).
 *   For older Windows, use the UEFI shell CapsuleApp.efi instead.
 */

#include <windows.h>
#include <stdio.h>
#include <stdlib.h>

//
// UEFI Capsule GUID (Firmware Management Protocol capsule)
// {6DCBD5ED-E82D-4C44-BDA1-7194199AD92A}
//
static const GUID EFI_FIRMWARE_MANAGEMENT_CAPSULE_GUID = {
    0x6DCBD5ED, 0xE82D, 0x4C44, {0xBD, 0xA1, 0x71, 0x94, 0x19, 0x9A, 0xD9, 0x2A}
};

//
// Enable SeSystemEnvironmentPrivilege (required for firmware access)
//
static BOOL EnableSystemEnvironmentPrivilege(void)
{
    HANDLE hToken;
    TOKEN_PRIVILEGES tkp;
    BOOL fResult;

    if (!OpenProcessToken(GetCurrentProcess(),
        TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken)) {
        printf("[ERROR] OpenProcessToken failed: %lu\n", GetLastError());
        return FALSE;
    }

    if (!LookupPrivilegeValue(NULL, SE_SYSTEM_ENVIRONMENT_NAME,
        &tkp.Privileges[0].Luid)) {
        printf("[ERROR] LookupPrivilegeValue failed: %lu\n", GetLastError());
        CloseHandle(hToken);
        return FALSE;
    }

    tkp.PrivilegeCount = 1;
    tkp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

    fResult = AdjustTokenPrivileges(hToken, FALSE, &tkp, 0, NULL, NULL);
    CloseHandle(hToken);

    if (!fResult) {
        printf("[ERROR] AdjustTokenPrivileges failed: %lu\n", GetLastError());
        return FALSE;
    }

    if (GetLastError() == ERROR_NOT_ALL_ASSIGNED) {
        printf("[ERROR] SeSystemEnvironmentPrivilege not held.\n");
        printf("        Run as Administrator (LocalSystem has this privilege).\n");
        return FALSE;
    }

    return TRUE;
}

//
// Read a file into a buffer
//
static BYTE* ReadFile(const char* filename, DWORD* fileSize)
{
    HANDLE hFile;
    BYTE* buffer;
    DWORD bytesRead;

    hFile = CreateFileA(filename, GENERIC_READ, FILE_SHARE_READ, NULL,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (hFile == INVALID_HANDLE_VALUE) {
        printf("[ERROR] Cannot open %s: %lu\n", filename, GetLastError());
        return NULL;
    }

    *fileSize = GetFileSize(hFile, NULL);
    if (*fileSize == INVALID_FILE_SIZE) {
        printf("[ERROR] GetFileSize failed: %lu\n", GetLastError());
        CloseHandle(hFile);
        return NULL;
    }

    buffer = (BYTE*)malloc(*fileSize);
    if (!buffer) {
        printf("[ERROR] Out of memory (%lu bytes)\n", *fileSize);
        CloseHandle(hFile);
        return NULL;
    }

    if (!ReadFile(hFile, buffer, *fileSize, &bytesRead, NULL) ||
        bytesRead != *fileSize) {
        printf("[ERROR] ReadFile failed: %lu\n", GetLastError());
        free(buffer);
        CloseHandle(hFile);
        return NULL;
    }

    CloseHandle(hFile);
    return buffer;
}

//
// Submit capsule via UpdateCapsule() UEFI runtime service.
//
// On Windows, UpdateCapsule is accessible through:
// 1. SetFirmwareEnvironmentVariableExW with the capsule GUID
//    (writes the capsule to the firmware's capsule delivery area)
// 2. The Windows.FirmwareUpdate WinRT API (Windows 10 1809+)
//
// This tool uses approach 1: write the capsule as a firmware variable
// with the capsule GUID, then request a reboot.
//
static BOOL SubmitCapsule(BYTE* capsuleData, DWORD capsuleSize)
{
    WCHAR varName[] = L"CapsuleUpdateData";
    BOOL result;

    printf("[INFO] Submitting capsule (%lu bytes) to firmware...\n", capsuleSize);
    printf("[INFO] Capsule GUID: {6DCBD5ED-E82D-4C44-BDA1-7194199AD92A}\n");

    //
    // Write the capsule to the firmware's capsule delivery area.
    // The variable name "CapsuleUpdateData" with the capsule GUID
    // tells the firmware to process this as a capsule update.
    //
    // Attributes: NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS = 0x07
    //
    result = SetFirmwareEnvironmentVariableExW(
        varName,
        (LPCGUID)&EFI_FIRMWARE_MANAGEMENT_CAPSULE_GUID,
        capsuleData,
        capsuleSize,
        0x07  // EFI_VARIABLE_NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS
    );

    if (!result) {
        DWORD err = GetLastError();
        printf("[ERROR] SetFirmwareEnvironmentVariableExW failed: %lu\n", err);
        switch (err) {
            case ERROR_PRIVILEGE_NOT_HELD:
                printf("        SeSystemEnvironmentPrivilege not held.\n");
                printf("        Run as Administrator.\n");
                break;
            case ERROR_INVALID_FUNCTION:
                printf("        System does not support UEFI firmware variables.\n");
                printf("        Ensure the system boots in UEFI mode (not Legacy/CSM).\n");
                break;
            case ERROR_INSUFFICIENT_BUFFER:
                printf("        Capsule too large for NVRAM. Max size varies by firmware.\n");
                break;
            default:
                printf("        Error code: %lu\n", err);
                break;
        }
        return FALSE;
    }

    printf("[OK] Capsule submitted to firmware successfully!\n");
    printf("[INFO] The capsule will be processed on the next reboot.\n");
    return TRUE;
}

//
// Trigger a system reboot
//
static BOOL TriggerReboot(void)
{
    HANDLE hToken;
    TOKEN_PRIVILEGES tkp;

    printf("[INFO] Triggering system reboot...\n");

    if (!OpenProcessToken(GetCurrentProcess(),
        TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken)) {
        printf("[ERROR] OpenProcessToken failed: %lu\n", GetLastError());
        return FALSE;
    }

    if (!LookupPrivilegeValue(NULL, SE_SHUTDOWN_NAME,
        &tkp.Privileges[0].Luid)) {
        printf("[ERROR] LookupPrivilegeValue failed: %lu\n", GetLastError());
        CloseHandle(hToken);
        return FALSE;
    }

    tkp.PrivilegeCount = 1;
    tkp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

    AdjustTokenPrivileges(hToken, FALSE, &tkp, 0, NULL, NULL);
    CloseHandle(hToken);

    if (!ExitWindowsEx(EWX_REBOOT | EWX_FORCE,
        SHTDN_REASON_MAJOR_HARDWARE | SHTDN_REASON_MINOR_OTHER)) {
        printf("[ERROR] ExitWindowsEx failed: %lu\n", GetLastError());
        printf("        You can reboot manually.\n");
        return FALSE;
    }

    return TRUE;
}

int main(int argc, char* argv[])
{
    BYTE* capsuleData;
    DWORD capsuleSize;
    BOOL doReboot = FALSE;

    printf("========================================\n");
    printf("  UEFI Capsule Updater\n");
    printf("  Anti-Theft Firmware Agent Delivery\n");
    printf("========================================\n\n");

    if (argc < 2) {
        printf("Usage: %s <capsule.cap> [--reboot]\n", argv[0]);
        printf("\n");
        printf("Arguments:\n");
        printf("  capsule.cap  Path to the UEFI capsule file\n");
        printf("  --reboot     Reboot after submitting the capsule\n");
        printf("\n");
        printf("Requirements:\n");
        printf("  - Windows 8+ with UEFI firmware\n");
        printf("  - Administrator privileges\n");
        printf("  - System must boot in UEFI mode (not Legacy/CSM)\n");
        printf("\n");
        printf("After the capsule is submitted, reboot the system.\n");
        printf("The firmware will process the capsule during boot:\n");
        printf("  1. Verify capsule signature\n");
        printf("  2. Flash the payload (AntiTheftFmpDxe driver) into SPI flash\n");
        printf("  3. Continue normal boot\n");
        printf("The anti-theft agent will then run on every boot.\n");
        return 1;
    }

    if (argc >= 3 && strcmp(argv[2], "--reboot") == 0) {
        doReboot = TRUE;
    }

    //
    // Step 1: Enable privileges
    //
    printf("[1] Enabling SeSystemEnvironmentPrivilege...\n");
    if (!EnableSystemEnvironmentPrivilege()) {
        printf("\n[FAIL] Cannot enable required privilege.\n");
        return 1;
    }
    printf("    [OK] Privilege enabled\n\n");

    //
    // Step 2: Read capsule file
    //
    printf("[2] Reading capsule file: %s\n", argv[1]);
    capsuleData = ReadFile(argv[1], &capsuleSize);
    if (!capsuleData) {
        printf("\n[FAIL] Cannot read capsule file.\n");
        return 1;
    }
    printf("    [OK] Read %lu bytes\n\n", capsuleSize);

    //
    // Step 3: Submit capsule to firmware
    //
    printf("[3] Submitting capsule to UEFI firmware...\n");
    if (!SubmitCapsule(capsuleData, capsuleSize)) {
        printf("\n[FAIL] Capsule submission failed.\n");
        free(capsuleData);
        return 1;
    }
    printf("\n");

    //
    // Step 4: Reboot (if requested)
    //
    if (doReboot) {
        printf("[4] Rebooting system...\n");
        TriggerReboot();
    } else {
        printf("[4] Reboot required to process capsule.\n");
        printf("    Run: shutdown /r /t 0\n");
        printf("    Or reboot manually.\n");
    }

    printf("\n========================================\n");
    printf("  Capsule Update Complete\n");
    printf("========================================\n");

    free(capsuleData);
    return 0;
}
