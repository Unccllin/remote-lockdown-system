/*
 * AntiTheftNetProbe.c — Enumerate all available UEFI protocols
 *
 * This diagnostic tool lists all handles and their protocols to
 * determine what network stack components are available.
 * It helps identify where the network stack is breaking.
 */

#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/DevicePathLib.h>
#include <Protocol/LoadedImage.h>
#include <Protocol/SimpleNetwork.h>

EFI_STATUS
EFIAPI
AntiTheftNetProbeEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  UINTN       HandleCount;
  EFI_HANDLE  *HandleBuffer;
  UINTN       Index;

  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  UEFI Protocol Enumeration Probe\n");
  Print(L"========================================\n\n");

  // === Step 1: Count all handles ===
  Status = gBS->LocateHandleBuffer(AllHandles, NULL, NULL, &HandleCount, &HandleBuffer);
  if (EFI_ERROR(Status)) {
    Print(L"[FAIL] LocateHandleBuffer(AllHandles): 0x%08x\n", Status);
    goto Done;
  }
  Print(L"Total handles in system: %d\n\n", HandleCount);

  // === Step 2: Check for specific network protocols ===
  Print(L"--- Network Protocol Check ---\n");

  struct {
    EFI_GUID *Guid;
    CHAR16   *Name;
  } NetProtocols[] = {
    { &gEfiHttpServiceBindingProtocolGuid, L"HttpServiceBinding" },
    { &gEfiHttpProtocolGuid,               L"Http" },
    { &gEfiTcp4ServiceBindingProtocolGuid, L"Tcp4ServiceBinding" },
    { &gEfiTcp4ProtocolGuid,               L"Tcp4" },
    { &gEfiIp4ServiceBindingProtocolGuid,  L"Ip4ServiceBinding" },
    { &gEfiIp4ProtocolGuid,                L"Ip4" },
    { &gEfiDhcp4ServiceBindingProtocolGuid,L"Dhcp4ServiceBinding" },
    { &gEfiDhcp4ProtocolGuid,              L"Dhcp4" },
    { &gEfiArpServiceBindingProtocolGuid,  L"ArpServiceBinding" },
    { &gEfiArpProtocolGuid,                L"Arp" },
    { &gEfiManagedNetworkServiceBindingProtocolGuid,  L"MnpServiceBinding" },
    { &gEfiManagedNetworkProtocolGuid,     L"ManagedNetwork" },
    { &gEfiSimpleNetworkProtocolGuid,      L"SimpleNetwork" },
    { &gEfiVlanConfigProtocolGuid,         L"VlanConfig" },
    { &gEfiPxeBaseCodeProtocolGuid,        L"PxeBaseCode" },
    { &gEfiDns4ServiceBindingProtocolGuid, L"Dns4ServiceBinding" },
    { &gEfiDns4ProtocolGuid,               L"Dns4" },
  };

  UINTN NetCount = sizeof(NetProtocols) / sizeof(NetProtocols[0]);

  for (Index = 0; Index < NetCount; Index++) {
    Status = gBS->LocateHandleBuffer(
      ByProtocol,
      NetProtocols[Index].Guid,
      NULL,
      &HandleCount,
      &HandleBuffer
    );

    if (Status == EFI_SUCCESS) {
      Print(L"  [FOUND] %-30s  (%d handles)\n", NetProtocols[Index].Name, HandleCount);
      FreePool(HandleBuffer);
    } else if (Status == EFI_NOT_FOUND) {
      Print(L"  [----]  %-30s  (not found)\n", NetProtocols[Index].Name);
    } else {
      Print(L"  [ERR?]  %-30s  status=0x%08x\n", NetProtocols[Index].Name, Status);
    }
  }

  // === Step 3: Check for PCI bus and device handles ===
  Print(L"\n--- PCI / Device Protocols ---\n");

  struct {
    EFI_GUID *Guid;
    CHAR16   *Name;
  } DevProtocols[] = {
    { &gEfiPciIoProtocolGuid,             L"PciIo" },
    { &gEfiDevicePathProtocolGuid,        L"DevicePath" },
    { &gEfiPciRootBridgeIoProtocolGuid,   L"PciRootBridgeIo" },
    { &gEfiLoadedImageProtocolGuid,       L"LoadedImage" },
    { &gEfiDriverBindingProtocolGuid,     L"DriverBinding" },
    { &gEfiComponentName2ProtocolGuid,    L"ComponentName2" },
  };

  UINTN DevCount = sizeof(DevProtocols) / sizeof(DevProtocols[0]);

  for (Index = 0; Index < DevCount; Index++) {
    Status = gBS->LocateHandleBuffer(
      ByProtocol,
      DevProtocols[Index].Guid,
      NULL,
      &HandleCount,
      &HandleBuffer
    );

    if (Status == EFI_SUCCESS) {
      Print(L"  [FOUND] %-30s  (%d handles)\n", DevProtocols[Index].Name, HandleCount);
      FreePool(HandleBuffer);
    } else {
      Print(L"  [----]  %-30s  (not found)\n", DevProtocols[Index].Name);
    }
  }

  // === Step 4: List all loaded images (drivers) ===
  Print(L"\n--- Loaded Images (Drivers/Apps) ---\n");

  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiLoadedImageProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );

  if (Status == EFI_SUCCESS) {
    Print(L"  Total loaded images: %d\n", HandleCount);

    for (Index = 0; Index < HandleCount && Index < 100; Index++) {
      EFI_LOADED_IMAGE_PROTOCOL *LoadedImage;
      Status = gBS->HandleProtocol(
        HandleBuffer[Index],
        &gEfiLoadedImageProtocolGuid,
        (VOID **)&LoadedImage
      );

      if (Status == EFI_SUCCESS) {
        CHAR16 *PathStr = ConvertDevicePathToText(LoadedImage->FilePath, FALSE, FALSE);
        if (PathStr != NULL) {
          Print(L"  [%03d] %s\n", Index, PathStr);
          FreePool(PathStr);
        }
      }
    }
    FreePool(HandleBuffer);
  }

  // === Step 5: Check for UNDI (Network Interface) ===
  Print(L"\n--- UNDI / NIC Check ---\n");

  // Check for UNDI protocol
  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiSimpleNetworkProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );

  if (Status == EFI_SUCCESS) {
    Print(L"  SimpleNetwork protocol found: %d handle(s)\n", HandleCount);

    for (Index = 0; Index < HandleCount; Index++) {
      EFI_SIMPLE_NETWORK_PROTOCOL *Snp;
      Status = gBS->HandleProtocol(
        HandleBuffer[Index],
        &gEfiSimpleNetworkProtocolGuid,
        (VOID **)&Snp
      );

      if (Status == EFI_SUCCESS && Snp != NULL) {
        Print(L"    Handle %d: State=%d, Mode=%p\n", Index, Snp->Mode->State, Snp->Mode);
        if (Snp->Mode != NULL) {
          Print(L"      HWAddressSize: %d\n", Snp->Mode->HwAddressSize);
          Print(L"      MediaHeaderSize: %d\n", Snp->Mode->MediaHeaderSize);
          Print(L"      MaxPacketSize: %d\n", Snp->Mode->MaxPacketSize);
          Print(L"      IfType: %d\n", Snp->Mode->IfType);
        }
      }
    }
    FreePool(HandleBuffer);
  } else {
    Print(L"  SimpleNetwork protocol NOT found.\n");
    Print(L"  This means no NIC driver has loaded.\n");
    Print(L"  The NIC option ROM may not be providing UNDI.\n");
  }

Done:
  Print(L"\n");
  Print(L"Probe complete. Press any key to continue...\n");

  gST->ConIn->Reset(gST->ConIn, FALSE);
  EFI_INPUT_KEY Key;
  while (gST->ConIn->ReadKeyStroke(gST->ConIn, &Key) == EFI_NOT_READY) {
    // Wait
  }

  return EFI_SUCCESS;
}
