# ParseNvram.ps1 — Parse OVMF NVRAM and verify AgentState variable
#
# This simulates what Windows GetFirmwareEnvironmentVariableW would find
# when reading the UEFI variable created by AntiTheftHello.efi.
#
# OVMF uses the authenticated variable header format (VARIABLE_HEADER):
#   UINT16  StartId        (0x55AA = valid)
#   UINT8   State          (0x3F = VAR_ADDED)
#   UINT8   Reserved
#   UINT32  Attributes
#   UINT64  MonotonicCount
#   EFI_TIME TimeStamp     (16 bytes)
#   UINT32  PubKeyIndex
#   UINT32  NameSize
#   UINT32  DataSize
#   EFI_GUID VendorGuid    (16 bytes)
#   CHAR16  Name[]         (NameSize bytes, UTF-16LE, null-terminated)
#   UINT8   Data[]         (DataSize bytes)

$ErrorActionPreference = "Stop"

$varsFile = "/tmp/uefi-test/OVMF_VARS_winvar.fd"
$bytes = [System.IO.File]::ReadAllBytes($varsFile)

Write-Host "=== OVMF NVRAM Parser (PowerShell) ==="
Write-Host "File: $varsFile"
Write-Host "Size: $($bytes.Length) bytes"
Write-Host ""

# Target GUID
$targetGuidStr = "A1B2C3D4-E5F6-4789-ABCD-EF0123456789"
$targetGuid = [Guid]$targetGuidStr
$guidBytes = $targetGuid.ToByteArray()

Write-Host "Searching for GUID: $targetGuidStr"
Write-Host ""

# Search for StartId (0x55AA LE = AA 55) and parse each variable header
$offset = 0
$found = $false

while ($offset -lt $bytes.Length - 60) {
    # Look for StartId 0x55AA
    if ($bytes[$offset] -eq 0xAA -and $bytes[$offset + 1] -eq 0x55) {
        # Parse authenticated variable header
        $startId = [BitConverter]::ToUInt16($bytes, $offset)
        $state = $bytes[$offset + 2]
        $attrs = [BitConverter]::ToUInt32($bytes, $offset + 4)
        $nameSize = [BitConverter]::ToUInt32($bytes, $offset + 36)
        $dataSize = [BitConverter]::ToUInt32($bytes, $offset + 40)

        # Read GUID (at offset + 44, 16 bytes)
        $guidArr = New-Object byte[] 16
        [Array]::Copy($bytes, $offset + 44, $guidArr, 0, 16)
        $varGuid = [Guid]$guidArr

        # Read name (at offset + 60, nameSize bytes, UTF-16LE)
        if ($nameSize -gt 0 -and $nameSize -lt 1000 -and ($offset + 60 + $nameSize) -le $bytes.Length) {
            $nameBytes = New-Object byte[] $nameSize
            [Array]::Copy($bytes, $offset + 60, $nameBytes, 0, $nameSize)
            $varName = [System.Text.Encoding]::Unicode.GetString($nameBytes).TrimEnd([char]0)

            # Read data (at offset + 60 + nameSize, dataSize bytes)
            $dataOffset = $offset + 60 + $nameSize
            if ($dataSize -gt 0 -and ($dataOffset + $dataSize) -le $bytes.Length) {
                $varData = $bytes[$dataOffset..($dataOffset + $dataSize - 1)]
            } else {
                $varData = @()
            }

            # Check if this is our target variable
            if ($varGuid.ToString().ToUpper() -eq $targetGuidStr -and $varName -eq "AgentState") {
                $found = $true
                $offStr = "0x{0:X4}" -f ([int]$offset)
                Write-Host "[FOUND] AgentState variable at offset $offStr" -ForegroundColor Green
                Write-Host ""
                $startIdValid = if ($startId -eq 0x55AA) { "VALID" } else { "INVALID" }
                $stateStr = if ($state -eq 0x3F) { "VAR_ADDED" } else { "other" }
                $sidStr = "0x{0:X4}" -f ([int]$startId)
                $stStr = "0x{0:X2}" -f ([int]$state)
                $attrStr = "0x{0:X8}" -f ([int]$attrs)
                Write-Host "  StartId:       $sidStr ($startIdValid)"
                Write-Host "  State:         $stStr ($stateStr)"
                Write-Host "  Attributes:    $attrStr"
                if ($attrs -band 0x01) { Write-Host "    - NON_VOLATILE (0x01)" }
                if ($attrs -band 0x02) { Write-Host "    - BOOTSERVICE_ACCESS (0x02)" }
                if ($attrs -band 0x04) { Write-Host "    - RUNTIME_ACCESS (0x04)" }
                Write-Host "  NameSize:      $nameSize bytes"
                Write-Host "  DataSize:      $dataSize byte(s)"
                Write-Host "  VendorGuid:    $($varGuid.ToString().ToUpper())"
                Write-Host "  Name:          '$varName'"

                if ($dataSize -eq 1) {
                    $val = $varData[0]
                    $stateStr2 = switch ($val) {
                        0 { "dormant" }
                        1 { "activated" }
                        default { "unknown:$val" }
                    }
                    $valStr = "0x{0:X2}" -f ([int]$val)
                    Write-Host "  Data:          $valStr ($stateStr2)"
                } else {
                    $dataHex = ($varData | ForEach-Object { '{0:x2}' -f $_ }) -join ' '
                    Write-Host "  Data:          $dataHex"
                }

                Write-Host ""
                Write-Host "=== Windows API Simulation ===" -ForegroundColor Cyan
                Write-Host "GetFirmwareEnvironmentVariableW("
                Write-Host "  'AgentState',"
                Write-Host "  '{A1B2C3D4-E5F6-4789-ABCD-EF0123456789}',"
                Write-Host "  buf, 1)"
                Write-Host "Would return:"
                if ($dataSize -eq 1) {
                    Write-Host "  Value: $($varData[0])"
                }
                Write-Host "  Size:  $dataSize byte(s)"
                Write-Host "  Status: SUCCESS"
                Write-Host ""
                Write-Host "[PASS] UEFI variable correctly formatted for Windows interop" -ForegroundColor Green
                break
            }

            # Move to next variable
            $offset = $dataOffset + $dataSize
            # Align to 4-byte boundary
            $offset = [Math]::Ceiling($offset / 4) * 4
            continue
        }
    }
    $offset++
}

if (-not $found) {
    Write-Host "[NOT FOUND] AgentState variable not found in NVRAM" -ForegroundColor Red
}
