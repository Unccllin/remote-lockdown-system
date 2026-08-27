/*
 * UefiVarTest.c — Test UEFI variable read/write from Windows
 *
 * This program tests that a Windows application running with
 * SeSystemEnvironmentPrivilege can read and write UEFI NVRAM
 * variables using the Win32 firmware environment variable API.
 *
 * The variable it reads/writes is the same one created by
 * AntiTheftHello.efi in the UEFI firmware:
 *
 *   Name:       "AgentState"
 *   GUID:       {A1B2C3D4-E5F6-4789-ABCD-EF0123456789}
 *   Attributes: NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS (0x07)
 *   Data:       1-byte UINT8 (0 = dormant, 1 = activated)
 *
 * Build (MSVC):
 *   cl /W4 /Fe:UefiVarTest.exe UefiVarTest.c /link advapi32.lib
 *
 * Build (MinGW):
 *   x86_64-w64-mingw32-gcc -Wall -Wextra -o UefiVarTest.exe UefiVarTest.c -ladvapi32
 *
 * Run (must be Administrator or SYSTEM):
 *   UefiVarTest.exe            — read current value
 *   UefiVarTest.exe write 1    — write value 1 (activated)
 *   UefiVarTest.exe write 0    — write value 0 (dormant)
 *   UefiVarTest.exe delete     — delete the variable
 *   UefiVarTest.exe enumerate  — list all variables in this GUID namespace
 *
 * Prerequisites:
 *   - System must be booted in UEFI mode (not legacy BIOS)
 *   - User account must have SeSystemEnvironmentPrivilege
 *     (Administrators and SYSTEM have this by default)
 */

#include <windows.h>
#include <stdio.h>
#include <string.h>

/* The GUID must be passed as a string to the Win32 API */
#define ANTITHEFT_GUID_STR  L"{A1B2C3D4-E5F6-4789-ABCD-EF0123456789}"
#define ANTITHEFT_VAR_NAME  L"AgentState"

/* UEFI variable attributes */
#define VAR_NON_VOLATILE        0x00000001
#define VAR_BOOTSERVICE_ACCESS  0x00000002
#define VAR_RUNTIME_ACCESS      0x00000004
#define VAR_DEFAULT_ATTRS       (VAR_NON_VOLATILE | VAR_BOOTSERVICE_ACCESS | VAR_RUNTIME_ACCESS)

/*
 * Enable SeSystemEnvironmentPrivilege in the current process token.
 * Without this, SetFirmwareEnvironmentVariableEx will fail with
 * ERROR_PRIVILEGE_NOT_HELD (1314).
 */
static BOOL EnableSystemEnvironmentPrivilege(void)
{
    HANDLE hToken;
    TOKEN_PRIVILEGES tp;
    LUID luid;

    if (!OpenProcessToken(GetCurrentProcess(),
                          TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY,
                          &hToken)) {
        printf("[ERROR] OpenProcessToken failed: %lu\n", GetLastError());
        return FALSE;
    }

    if (!LookupPrivilegeValueW(NULL, SE_SYSTEM_ENVIRONMENT_NAME, &luid)) {
        printf("[ERROR] LookupPrivilegeValue failed: %lu\n", GetLastError());
        CloseHandle(hToken);
        return FALSE;
    }

    tp.PrivilegeCount = 1;
    tp.Privileges[0].Luid = luid;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

    if (!AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(tp), NULL, NULL)) {
        printf("[ERROR] AdjustTokenPrivileges failed: %lu\n", GetLastError());
        CloseHandle(hToken);
        return FALSE;
    }

    DWORD err = GetLastError();
    CloseHandle(hToken);

    if (err == ERROR_NOT_ALL_ASSIGNED) {
        printf("[ERROR] SeSystemEnvironmentPrivilege not held by this account.\n");
        printf("        Run as Administrator or SYSTEM.\n");
        return FALSE;
    }

    printf("[OK] SeSystemEnvironmentPrivilege enabled\n");
    return TRUE;
}

/*
 * Check if the system is running in UEFI mode.
 * On legacy BIOS systems, the firmware variable API always fails.
 */
static BOOL IsUefiSystem(void)
{
    /* Try a dummy read to check if the API is supported */
    BYTE buf[4];
    DWORD result = GetFirmwareEnvironmentVariableW(
        L"",                         /* empty name */
        L"{00000000-0000-0000-0000-000000000000}", /* dummy GUID */
        buf, sizeof(buf));

    if (result == 0) {
        DWORD err = GetLastError();
        if (err == ERROR_INVALID_FUNCTION) {
            /* Legacy BIOS — function not supported */
            return FALSE;
        }
        /* ERROR_NOACCESS or similar means UEFI is present but the dummy
           variable doesn't exist — that's expected */
        return TRUE;
    }

    /* Shouldn't happen with a dummy GUID, but if it does, UEFI is working */
    return TRUE;
}

/*
 * Read the AgentState UEFI variable.
 */
static int ReadAgentState(void)
{
    BYTE value = 0;
    DWORD result = GetFirmwareEnvironmentVariableW(
        ANTITHEFT_VAR_NAME,
        ANTITHEFT_GUID_STR,
        &value,
        sizeof(value));

    if (result == 0) {
        DWORD err = GetLastError();
        if (err == ERROR_FILE_NOT_FOUND) {
            printf("[INFO] AgentState variable not found.\n");
            printf("       Boot AntiTheftHello.efi first to create it, or use 'write'.\n");
            return 0;
        }
        printf("[ERROR] GetFirmwareEnvironmentVariable failed: %lu\n", err);
        return 1;
    }

    printf("[OK] AgentState variable read successfully\n");
    printf("     Value: %u (%s)\n", value,
           value == 0 ? "dormant" :
           value == 1 ? "activated" : "unknown");
    printf("     Size: %lu bytes\n", result);
    printf("     GUID: %ls\n", ANTITHEFT_GUID_STR);
    return 0;
}

/*
 * Write the AgentState UEFI variable.
 */
static int WriteAgentState(BYTE value)
{
    if (!SetFirmwareEnvironmentVariableExW(
        ANTITHEFT_VAR_NAME,
        ANTITHEFT_GUID_STR,
        &value,
        sizeof(value),
        VAR_DEFAULT_ATTRS)) {
        printf("[ERROR] SetFirmwareEnvironmentVariableEx failed: %lu\n",
               GetLastError());
        return 1;
    }

    printf("[OK] AgentState variable written successfully\n");
    printf("     Value: %u (%s)\n", value,
           value == 0 ? "dormant" :
           value == 1 ? "activated" : "unknown");
    printf("     Attributes: 0x%02x (NON_VOLATILE | BOOTSERVICE_ACCESS | RUNTIME_ACCESS)\n",
           VAR_DEFAULT_ATTRS);
    printf("     This variable will persist across reboots and OS reinstalls.\n");
    return 0;
}

/*
 * Delete the AgentState UEFI variable.
 * Setting size to 0 (without APPEND_WRITE or AUTH attributes) deletes the variable.
 */
static int DeleteAgentState(void)
{
    if (!SetFirmwareEnvironmentVariableExW(
        ANTITHEFT_VAR_NAME,
        ANTITHEFT_GUID_STR,
        NULL,
        0,
        VAR_DEFAULT_ATTRS)) {
        printf("[ERROR] Delete (SetVariable with size=0) failed: %lu\n",
               GetLastError());
        return 1;
    }

    printf("[OK] AgentState variable deleted\n");
    return 0;
}

/*
 * Enumerate all UEFI variables in our GUID namespace.
 * Uses GetFirmwareEnvironmentVariableExW with NULL name to start enumeration,
 * then GetFirmwareEnvironmentVariableExW repeatedly.
 *
 * Note: Windows doesn't directly expose GetNextVariableName.
 * The only way to enumerate is through the kernel debugger or
 * a driver. This function is a placeholder — it just reads our
 * known variable.
 */
static int EnumerateVariables(void)
{
    printf("[INFO] Windows does not expose GetNextVariableName() to user mode.\n");
    printf("       Only known variables can be read by name + GUID.\n");
    printf("       Reading known variable 'AgentState':\n\n");
    return ReadAgentState();
}

static void PrintUsage(const char *progname)
{
    printf("\nUsage:\n");
    printf("  %s                 — read current AgentState value\n", progname);
    printf("  %s write <0|1>     — write AgentState value (0=dormant, 1=activated)\n", progname);
    printf("  %s delete          — delete the AgentState variable\n", progname);
    printf("  %s enumerate       — attempt to enumerate variables\n", progname);
    printf("\nMust be run as Administrator or SYSTEM.\n");
    printf("System must be booted in UEFI mode.\n");
}

int main(int argc, char *argv[])
{
    printf("=== UEFI Variable Test (Windows side) ===\n\n");

    /* Check UEFI mode */
    if (!IsUefiSystem()) {
        printf("[ERROR] System is not in UEFI mode (legacy BIOS detected).\n");
        printf("        UEFI variable access requires UEFI boot.\n");
        return 1;
    }
    printf("[OK] System is in UEFI mode\n");

    /* Enable privilege */
    if (!EnableSystemEnvironmentPrivilege()) {
        return 1;
    }

    printf("\n");

    /* Parse command */
    if (argc < 2) {
        /* Default: read */
        return ReadAgentState();
    }

    if (strcmp(argv[1], "write") == 0) {
        if (argc < 3) {
            printf("[ERROR] Usage: %s write <0|1>\n", argv[0]);
            return 1;
        }
        int val = atoi(argv[2]);
        if (val < 0 || val > 255) {
            printf("[ERROR] Value must be 0-255\n");
            return 1;
        }
        return WriteAgentState((BYTE)val);
    } else if (strcmp(argv[1], "delete") == 0) {
        return DeleteAgentState();
    } else if (strcmp(argv[1], "enumerate") == 0) {
        return EnumerateVariables();
    } else if (strcmp(argv[1], "help") == 0 || strcmp(argv[1], "/?") == 0) {
        PrintUsage(argv[0]);
        return 0;
    } else {
        printf("[ERROR] Unknown command: %s\n", argv[1]);
        PrintUsage(argv[0]);
        return 1;
    }
}
