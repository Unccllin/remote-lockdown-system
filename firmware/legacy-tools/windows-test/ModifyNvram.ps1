# ModifyNvram.ps1 — Modify AgentState in OVMF NVRAM to simulate Windows write
#
# This simulates what SetFirmwareEnvironmentVariableExW would do:
# change the AgentState variable value from 0 (dormant) to 1 (activated).
#
# After running this, boot QEMU with the modified OVMF_VARS.fd to verify
# that AntiTheftHello.efi reads the new value — proving the round-trip
# works: Windows writes -> UEFI reads.

param(
    [int]$NewValue = 1,
    [string]$VarsFile = "/tmp/uefi-test/OVMF_VARS_winvar.fd"
)

$ErrorActionPreference = "Stop"

$bytes = [System.IO.File]::ReadAllBytes($VarsFile)
$targetGuidStr = "A1B2C3D4-E5F6-4789-ABCD-EF0123456789"
$targetGuid = [Guid]$targetGuidStr
$guidBytes = $targetGuid.ToByteArray()

Write-Host "=== NVRAM Modifier (Simulating Windows Write) ==="
Write-Host "File: $VarsFile"
Write-Host "Target value: $NewValue"
Write-Host ""

# Find the variable by scanning for StartId (0x55AA)
$offset = 0
$found = $false

while ($offset -lt $bytes.Length - 60) {
    if ($bytes[$offset] -eq 0xAA -and $bytes[$offset + 1] -eq 0x55) {
        $nameSize = [BitConverter]::ToUInt32($bytes, $offset + 36)
        $dataSize = [BitConverter]::ToUInt32($bytes, $offset + 40)

        $guidArr = New-Object byte[] 16
        [Array]::Copy($bytes, $offset + 44, $guidArr, 0, 16)
        $varGuid = [Guid]$guidArr

        if ($nameSize -gt 0 -and $nameSize -lt 1000 -and ($offset + 60 + $nameSize) -le $bytes.Length) {
            $nameBytes = New-Object byte[] $nameSize
            [Array]::Copy($bytes, $offset + 60, $nameBytes, 0, $nameSize)
            $varName = [System.Text.Encoding]::Unicode.GetString($nameBytes).TrimEnd([char]0)

            if ($varGuid.ToString().ToUpper() -eq $targetGuidStr -and $varName -eq "AgentState") {
                $found = $true
                $dataOffset = $offset + 60 + $nameSize
                $oldValue = $bytes[$dataOffset]

                $offStr = "0x{0:X4}" -f ([int]$offset)
                $dataOffStr = "0x{0:X4}" -f ([int]$dataOffset)
                Write-Host "[FOUND] AgentState at offset $offStr, data at $dataOffStr"
                Write-Host "  Old value: $oldValue"
                Write-Host "  New value: $NewValue"

                # Modify the data byte
                $bytes[$dataOffset] = [byte]$NewValue

                # Write back
                [System.IO.File]::WriteAllBytes($VarsFile, $bytes)
                Write-Host ""
                Write-Host "[OK] NVRAM modified — AgentState set to $NewValue" -ForegroundColor Green
                Write-Host "     Boot QEMU with this OVMF_VARS.fd to verify UEFI reads the new value."
                break
            }

            $offset = $offset + 60 + $nameSize + $dataSize
            $offset = [Math]::Ceiling($offset / 4) * 4
            continue
        }
    }
    $offset++
}

if (-not $found) {
    Write-Host "[ERROR] AgentState variable not found in NVRAM" -ForegroundColor Red
    exit 1
}
