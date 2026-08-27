/*
 * AntiTheftNetInit.c — Manually load and start network drivers from FV
 *
 * The DXE dispatcher isn't loading the network drivers automatically.
 * This app manually loads them by GUID from the firmware volume,
 * starts them, then attempts an HTTP request.
 *
 * Network driver load order (dependencies):
 *   DpcDxe (already loaded)
 *   SnpDxe → MnpDxe → ArpDxe → Dhcp4Dxe → Ip4Dxe → TcpDxe → HttpDxe
 *   VlanConfigDxe, HttpUtilitiesDxe, DnsDxe
 */

#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/DevicePathLib.h>
#include <Protocol/LoadedImage.h>
#include <Protocol/SimpleNetwork.h>
#include <Protocol/ServiceBinding.h>
#include <Protocol/Http.h>
#include <Protocol/Ip4Config2.h>

/* Minimal FV2 types (avoiding header conflicts) */
typedef UINT8 EFI_SECTION_TYPE;
#define EFI_SECTION_PE32 0x10

/* Network driver GUIDs */
EFI_GUID gSnpDxeGuid           = { 0xA2f436EA, 0xA127, 0x4EF8, { 0x95, 0x7C, 0x80, 0x48, 0x60, 0x6F, 0xF6, 0x70 }};
EFI_GUID gMnpDxeGuid           = { 0x025BBFC7, 0xE6A9, 0x4b8b, { 0x82, 0xAD, 0x68, 0x15, 0xA1, 0xAE, 0xAF, 0x4A }};
EFI_GUID gArpDxeGuid           = { 0x529D3F93, 0xE8E9, 0x4e73, { 0xB1, 0xE1, 0xBD, 0xF6, 0xA9, 0xD5, 0x01, 0x13 }};
EFI_GUID gDhcp4DxeGuid         = { 0x94734718, 0x0BBC, 0x47fb, { 0x96, 0xA5, 0xEE, 0x7A, 0x5A, 0xE6, 0xA2, 0xAD }};
EFI_GUID gIp4DxeGuid           = { 0x9FB1A1F3, 0x3B71, 0x4324, { 0xB3, 0x9A, 0x74, 0x5C, 0xBB, 0x01, 0x5F, 0xFF }};
EFI_GUID gTcpDxeGuid           = { 0x1A7E4468, 0x2F55, 0x4a56, { 0x90, 0x3C, 0x01, 0x26, 0x5E, 0xB7, 0x62, 0x2B }};
EFI_GUID gHttpDxeGuid          = { 0x2366c20f, 0xe15a, 0x11e3, { 0x8b, 0xf1, 0xe4, 0x11, 0x5b, 0x28, 0xbc, 0x50 }};
EFI_GUID gHttpUtilitiesDxeGuid = { 0x22ea234f, 0xe72a, 0x11e4, { 0x91, 0xf9, 0x28, 0xd2, 0x44, 0x7c, 0x48, 0x29 }};
EFI_GUID gDnsDxeGuid           = { 0xb219e140, 0xdffc, 0x11e3, { 0xb9, 0x56, 0x00, 0x22, 0x68, 0x1e, 0x69, 0x06 }};
EFI_GUID gVlanConfigDxeGuid    = { 0xE4F61863, 0xFE2C, 0x4b56, { 0xA8, 0xF4, 0x08, 0x51, 0x9B, 0xC4, 0x39, 0xDF }};
EFI_GUID gHash2DxeGuid         = { 0x63E3BDCF, 0x2AC7, 0x4ac0, { 0x9B, 0x92, 0x03, 0xA7, 0x54, 0x14, 0x22, 0xFF }};
EFI_GUID gUdp4DxeGuid          = { 0x6d6963ab, 0x906d, 0x4a65, { 0xa7, 0xca, 0xbd, 0x40, 0xe5, 0xd6, 0xaf, 0x2b }};
EFI_GUID gRngDxeGuid           = { 0xB981A835, 0x6EE8, 0x4f4c, { 0xAE, 0x0B, 0x21, 0x0A, 0xA0, 0xBF, 0xBF, 0x01 }};
EFI_GUID gVirtioRngDxeGuid     = { 0x58E26F0D, 0xCBAC, 0x4BBA, { 0xB7, 0x0F, 0x18, 0x22, 0x14, 0x15, 0x66, 0x5A }};

/* EFI_FIRMWARE_VOLUME2_PROTOCOL GUID */
EFI_GUID gEfiFirmwareVolume2ProtocolGuid = { 0x220e73b6, 0x6bdb, 0x4413, { 0x84, 0x05, 0xb9, 0x74, 0xb1, 0x08, 0x61, 0x9a }};

/* FV2 protocol typedef (minimal, to avoid header conflicts) */
typedef struct {
  EFI_STATUS (EFIAPI *GetVolumeAttributes)(VOID *This, UINT32 *Attributes);
  EFI_STATUS (EFIAPI *SetVolumeAttributes)(VOID *This, UINT32 Attributes, UINT32 *NewAttributes);
  EFI_STATUS (EFIAPI *ReadFile)(VOID *This, EFI_GUID *NameGuid, VOID **Buffer, UINTN *BufferSize, UINT32 *FoundType, UINT32 *FoundAttributes, UINT32 *AuthenticationStatus);
  EFI_STATUS (EFIAPI *ReadSection)(VOID *This, EFI_GUID *NameGuid, EFI_SECTION_TYPE SectionType, UINTN SectionInstance, VOID **Buffer, UINTN *BufferSize, UINT32 *AuthenticationStatus);
  EFI_STATUS (EFIAPI *WriteFile)(VOID *This, UINT32 NumberOfFiles, UINT32 *WriteStatus, ...);
  EFI_STATUS (EFIAPI *GetNextFile)(VOID *This, VOID *Key, UINT32 *FileType, EFI_GUID *NameGuid, UINTN *BufferSize, UINT32 *Attributes, UINT32 *AuthenticationStatus);
  UINT32 KeySize;
  EFI_HANDLE ParentHandle;
} MY_EFI_FIRMWARE_VOLUME2_PROTOCOL;

/* Helper: Load a driver from FV by its GUID */
EFI_STATUS
LoadDriverFromFv (
  EFI_GUID *DriverGuid
  )
{
  EFI_STATUS  Status;
  EFI_HANDLE  ImageHandle = NULL;

  // Find ALL FV2 protocol handles and try each one
  UINTN FvHandleCount = 0;
  EFI_HANDLE *FvHandleBuffer = NULL;
  UINTN FvIndex;

  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiFirmwareVolume2ProtocolGuid,
    NULL,
    &FvHandleCount,
    &FvHandleBuffer
  );

  if (EFI_ERROR(Status)) {
    Print(L"      (No FV2 protocols found: 0x%08x)\n", Status);
    return Status;
  }

  for (FvIndex = 0; FvIndex < FvHandleCount; FvIndex++) {
    MY_EFI_FIRMWARE_VOLUME2_PROTOCOL *Fv2 = NULL;
    Status = gBS->HandleProtocol(
      FvHandleBuffer[FvIndex],
      &gEfiFirmwareVolume2ProtocolGuid,
      (VOID **)&Fv2
    );

    if (EFI_ERROR(Status) || Fv2 == NULL) {
      continue;
    }

    // Try ReadSection to get the PE32 section directly
    VOID  *FileBuffer = NULL;
    UINTN FileSize = 0;
    UINT32 AuthStatus = 0;

    Status = Fv2->ReadSection(Fv2, DriverGuid, EFI_SECTION_PE32, 0, &FileBuffer, &FileSize, &AuthStatus);

    if (EFI_ERROR(Status) || FileBuffer == NULL || FileSize == 0) {
      // Try ReadFile as fallback
      FileBuffer = NULL;
      FileSize = 0;
      UINT32 FoundType = 0;
      UINT32 FoundAttributes = 0;
      Status = Fv2->ReadFile(Fv2, DriverGuid, &FileBuffer, &FileSize, &FoundType, &FoundAttributes, &AuthStatus);
      if (EFI_ERROR(Status) || FileBuffer == NULL || FileSize == 0) {
        continue;  // Try next FV
      }
    }

    // Found the file — load the image from buffer
    Status = gBS->LoadImage(
      FALSE,
      gImageHandle,
      NULL,
      FileBuffer,
      FileSize,
      &ImageHandle
    );

    if (EFI_ERROR(Status)) {
      Print(L"(LoadImage 0x%08x, sz=%d) ", Status, FileSize);
      continue;
    }

    // Start the image
    UINTN ExitDataSize = 0;
    Status = gBS->StartImage(ImageHandle, &ExitDataSize, NULL);

    if (EFI_ERROR(Status)) {
      Print(L"(StartImage 0x%08x) ", Status);
      // Don't return — try other FVs
      continue;
    }

    FreePool(FvHandleBuffer);
    return Status;
  }

  FreePool(FvHandleBuffer);
  return EFI_NOT_FOUND;
}

/* Helper: Check if a protocol is available */
BOOLEAN
IsProtocolAvailable (
  EFI_GUID *ProtocolGuid
  )
{
  EFI_STATUS Status;
  UINTN HandleCount;
  EFI_HANDLE *HandleBuffer;

  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    ProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );

  if (Status == EFI_SUCCESS) {
    FreePool(HandleBuffer);
    return TRUE;
  }
  return FALSE;
}

EFI_STATUS
EFIAPI
AntiTheftNetInitEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  UINTN       Index;

  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  Anti-Theft Network Driver Loader\n");
  Print(L"========================================\n\n");

  // === Step 0: Connect all controllers first ===
  Print(L"[0] Connecting all controllers...\n");
  UINTN AllHandleCount;
  EFI_HANDLE *AllHandleBuffer;
  Status = gBS->LocateHandleBuffer(AllHandles, NULL, NULL, &AllHandleCount, &AllHandleBuffer);
  if (!EFI_ERROR(Status)) {
    for (Index = 0; Index < AllHandleCount; Index++) {
      gBS->ConnectController(AllHandleBuffer[Index], NULL, NULL, TRUE);
    }
    FreePool(AllHandleBuffer);
    Print(L"    Connected %d controllers\n", AllHandleCount);
  }

  // === Step 1: Check what's already available ===
  Print(L"\n[1] Checking existing protocol availability...\n");
  Print(L"    SimpleNetwork: %a\n", IsProtocolAvailable(&gEfiSimpleNetworkProtocolGuid) ? "YES" : "NO");
  Print(L"    HttpServiceBinding: %a\n", IsProtocolAvailable(&gEfiHttpServiceBindingProtocolGuid) ? "YES" : "NO");

  // === Step 2: Load network drivers in dependency order ===
  Print(L"\n[2] Loading network drivers from FV...\n");

  struct {
    EFI_GUID *Guid;
    CHAR16   *Name;
  } Drivers[] = {
    { &gRngDxeGuid,            L"RngDxe" },
    { &gVirtioRngDxeGuid,      L"VirtioRngDxe" },
    { &gSnpDxeGuid,            L"SnpDxe" },
    { &gVlanConfigDxeGuid,     L"VlanConfigDxe" },
    { &gMnpDxeGuid,            L"MnpDxe" },
    { &gArpDxeGuid,            L"ArpDxe" },
    { &gUdp4DxeGuid,           L"Udp4Dxe" },
    { &gDhcp4DxeGuid,          L"Dhcp4Dxe" },
    { &gIp4DxeGuid,            L"Ip4Dxe" },
    { &gHash2DxeGuid,          L"Hash2DxeCrypto" },
    { &gTcpDxeGuid,            L"TcpDxe" },
    { &gDnsDxeGuid,            L"DnsDxe" },
    { &gHttpUtilitiesDxeGuid,  L"HttpUtilitiesDxe" },
    { &gHttpDxeGuid,           L"HttpDxe" },
  };

  UINTN DriverCount = sizeof(Drivers) / sizeof(Drivers[0]);

  for (Index = 0; Index < DriverCount; Index++) {
    // Check if it's already loaded
    if (Index > 0) {
      // Skip if already available (for protocols we can check)
    }

    Print(L"    Loading %-20s ... ", Drivers[Index].Name);
    Status = LoadDriverFromFv(Drivers[Index].Guid);

    if (Status == EFI_SUCCESS) {
      Print(L"[OK]\n");
    } else if (Status == EFI_ALREADY_STARTED) {
      Print(L"[ALREADY STARTED]\n");
    } else if (Status == EFI_NOT_FOUND) {
      Print(L"[NOT FOUND IN FV]\n");
    } else {
      Print(L"[FAIL: 0x%08x]\n", Status);
    }
  }

  // === Step 3: Connect controllers again (now that drivers are loaded) ===
  Print(L"\n[3] Re-connecting all controllers (multiple passes)...\n");

  // Do multiple connect passes — drivers may need several passes to
  // fully connect (each pass may load more drivers which enable more connections)
  UINTN Pass;
  for (Pass = 0; Pass < 3; Pass++) {
    Status = gBS->LocateHandleBuffer(AllHandles, NULL, NULL, &AllHandleCount, &AllHandleBuffer);
    if (!EFI_ERROR(Status)) {
      for (Index = 0; Index < AllHandleCount; Index++) {
        gBS->ConnectController(AllHandleBuffer[Index], NULL, NULL, TRUE);
      }
      FreePool(AllHandleBuffer);
    }
  }
  Print(L"    Done 3 connect passes\n");

  // Now try to specifically connect the NIC handle (has SimpleNetwork)
  Print(L"    Connecting NIC handle specifically...\n");
  UINTN NicHandleCount;
  EFI_HANDLE *NicHandleBuffer;
  Status = gBS->LocateHandleBuffer(
    ByProtocol, &gEfiSimpleNetworkProtocolGuid,
    NULL, &NicHandleCount, &NicHandleBuffer
  );
  if (!EFI_ERROR(Status)) {
    for (Index = 0; Index < NicHandleCount; Index++) {
      // Connect with Recursive=TRUE to connect all child drivers
      gBS->ConnectController(NicHandleBuffer[Index], NULL, NULL, TRUE);
    }
    FreePool(NicHandleBuffer);
    Print(L"    NIC handle connected\n");
  }

  // Try loading Udp4Dxe and TcpDxe again (they may have failed earlier
  // because their dependencies weren't connected yet)
  Print(L"    Retrying Udp4Dxe and TcpDxe...\n");
  Print(L"    Loading Udp4Dxe             ... ");
  Status = LoadDriverFromFv(&gUdp4DxeGuid);
  if (Status == EFI_SUCCESS) {
    Print(L"[OK]\n");
  } else {
    Print(L"[0x%08x]\n", Status);
  }

  Print(L"    Loading TcpDxe              ... ");
  Status = LoadDriverFromFv(&gTcpDxeGuid);
  if (Status == EFI_SUCCESS) {
    Print(L"[OK]\n");
  } else {
    Print(L"[0x%08x]\n", Status);
  }

  // More connect passes after retrying
  for (Pass = 0; Pass < 3; Pass++) {
    Status = gBS->LocateHandleBuffer(AllHandles, NULL, NULL, &AllHandleCount, &AllHandleBuffer);
    if (!EFI_ERROR(Status)) {
      for (Index = 0; Index < AllHandleCount; Index++) {
        gBS->ConnectController(AllHandleBuffer[Index], NULL, NULL, TRUE);
      }
      FreePool(AllHandleBuffer);
    }
  }

  // Wait for DHCP
  Print(L"    Waiting 10 seconds for DHCP...\n");
  gBS->Stall(10000000);

  // Do one more connect pass after DHCP wait
  Status = gBS->LocateHandleBuffer(AllHandles, NULL, NULL, &AllHandleCount, &AllHandleBuffer);
  if (!EFI_ERROR(Status)) {
    for (Index = 0; Index < AllHandleCount; Index++) {
      gBS->ConnectController(AllHandleBuffer[Index], NULL, NULL, TRUE);
    }
    FreePool(AllHandleBuffer);
  }

  // === Step 4: Check protocol availability after loading ===
  Print(L"\n[4] Checking protocol availability after loading...\n");

  struct {
    EFI_GUID *Guid;
    CHAR16   *Name;
  } Protocols[] = {
    { &gEfiSimpleNetworkProtocolGuid,      L"SimpleNetwork" },
    { &gEfiManagedNetworkServiceBindingProtocolGuid, L"MnpServiceBinding" },
    { &gEfiManagedNetworkProtocolGuid,     L"ManagedNetwork" },
    { &gEfiArpServiceBindingProtocolGuid,  L"ArpServiceBinding" },
    { &gEfiDhcp4ServiceBindingProtocolGuid,L"Dhcp4ServiceBinding" },
    { &gEfiIp4ServiceBindingProtocolGuid,  L"Ip4ServiceBinding" },
    { &gEfiTcp4ServiceBindingProtocolGuid, L"Tcp4ServiceBinding" },
    { &gEfiDns4ServiceBindingProtocolGuid, L"Dns4ServiceBinding" },
    { &gEfiHttpServiceBindingProtocolGuid, L"HttpServiceBinding" },
  };

  UINTN ProtoCount = sizeof(Protocols) / sizeof(Protocols[0]);

  for (Index = 0; Index < ProtoCount; Index++) {
    UINTN HandleCount;
    EFI_HANDLE *HandleBuffer;
    Status = gBS->LocateHandleBuffer(
      ByProtocol,
      Protocols[Index].Guid,
      NULL,
      &HandleCount,
      &HandleBuffer
    );

    if (Status == EFI_SUCCESS) {
      Print(L"    [FOUND] %-30s (%d handles)\n", Protocols[Index].Name, HandleCount);
      FreePool(HandleBuffer);
    } else {
      Print(L"    [----]  %-30s (not found)\n", Protocols[Index].Name);
    }
  }

  // === Step 4b: Configure IP4 with DHCP ===
  Print(L"\n[4b] Configuring IP4 with DHCP...\n");

  EFI_IP4_CONFIG2_PROTOCOL *Ip4Config2 = NULL;
  Status = gBS->LocateProtocol(&gEfiIp4Config2ProtocolGuid, NULL, (VOID **)&Ip4Config2);
  if (!EFI_ERROR(Status) && Ip4Config2 != NULL) {
    // Set policy to DHCP
    EFI_IP4_CONFIG2_POLICY Policy = Ip4Config2PolicyDhcp;
    Status = Ip4Config2->SetData(Ip4Config2, Ip4Config2DataTypePolicy, sizeof(EFI_IP4_CONFIG2_POLICY), &Policy);
    Print(L"    SetData(DHCP policy): 0x%08x\n", Status);

    // Wait for DHCP to complete
    Print(L"    Waiting 15 seconds for DHCP to assign an IP...\n");
    gBS->Stall(15000000);

    // Check if we got an IP
    UINTN DataSize = 0;
    Status = Ip4Config2->GetData(Ip4Config2, Ip4Config2DataTypeInterfaceInfo, &DataSize, NULL);
    if (Status == EFI_BUFFER_TOO_SMALL && DataSize > 0) {
      Print(L"    InterfaceInfo data size: %d bytes\n", DataSize);
      // Don't need to read it, just confirm it's there
    }
  } else {
    Print(L"    Ip4Config2 not available: 0x%08x\n", Status);
  }

  // === Step 5: If HTTP is available, try making a request ===
  if (IsProtocolAvailable(&gEfiHttpServiceBindingProtocolGuid)) {
    Print(L"\n[5] HTTP Service Binding is available! Attempting HTTP request...\n");

    // Find HTTP service binding
    UINTN HandleCount;
    EFI_HANDLE *HandleBuffer;
    EFI_SERVICE_BINDING_PROTOCOL *HttpServiceBinding = NULL;
    EFI_HANDLE HttpChildHandle = NULL;
    EFI_HTTP_PROTOCOL *HttpProtocol = NULL;

    Status = gBS->LocateHandleBuffer(
      ByProtocol, &gEfiHttpServiceBindingProtocolGuid,
      NULL, &HandleCount, &HandleBuffer
    );

    if (!EFI_ERROR(Status)) {
      Status = gBS->HandleProtocol(
        HandleBuffer[0],
        &gEfiHttpServiceBindingProtocolGuid,
        (VOID **)&HttpServiceBinding
      );

      if (!EFI_ERROR(Status)) {
        Status = HttpServiceBinding->CreateChild(HttpServiceBinding, &HttpChildHandle);
        if (!EFI_ERROR(Status)) {
          Status = gBS->HandleProtocol(
            HttpChildHandle,
            &gEfiHttpProtocolGuid,
            (VOID **)&HttpProtocol
          );

          if (!EFI_ERROR(Status)) {
            // Configure HTTP
            EFI_HTTPv4_ACCESS_POINT IPv4Node;
            ZeroMem(&IPv4Node, sizeof(IPv4Node));
            IPv4Node.UseDefaultAddress = TRUE;

            EFI_HTTP_CONFIG_DATA ConfigData;
            ZeroMem(&ConfigData, sizeof(ConfigData));
            ConfigData.HttpVersion = HttpVersion11;
            ConfigData.TimeOutMillisec = 10000;
            ConfigData.LocalAddressIsIPv6 = FALSE;
            ConfigData.AccessPoint.IPv4Node = &IPv4Node;

            Status = HttpProtocol->Configure(HttpProtocol, &ConfigData);
            Print(L"    HTTP Configure: 0x%08x\n", Status);

            if (!EFI_ERROR(Status)) {
              // Send request
              EFI_HTTP_REQUEST_DATA RequestData;
              ZeroMem(&RequestData, sizeof(RequestData));
              RequestData.Method = HttpMethodGet;
              RequestData.Url = L"http://10.0.2.2:8080/checkin";

              EFI_HTTP_HEADER Headers[1];
              Headers[0].FieldName = (CHAR8 *)"Host";
              Headers[0].FieldValue = (CHAR8 *)"10.0.2.2:8080";

              EFI_HTTP_MESSAGE RequestMessage;
              ZeroMem(&RequestMessage, sizeof(RequestMessage));
              RequestMessage.Data.Request = &RequestData;
              RequestMessage.HeaderCount = 1;
              RequestMessage.Headers = Headers;

              EFI_HTTP_TOKEN RequestToken;
              ZeroMem(&RequestToken, sizeof(RequestToken));
              RequestToken.Status = EFI_NOT_READY;
              RequestToken.Message = &RequestMessage;

              gBS->CreateEvent(EVT_NOTIFY_SIGNAL, TPL_CALLBACK, NULL, NULL, &RequestToken.Event);

              Print(L"    Sending HTTP GET to http://10.0.2.2:8080/checkin...\n");
              Status = HttpProtocol->Request(HttpProtocol, &RequestToken);
              Print(L"    Request() returned: 0x%08x\n", Status);

              if (!EFI_ERROR(Status)) {
                // Wait for completion
                for (Index = 0; Index < 200; Index++) {
                  if (RequestToken.Status != EFI_NOT_READY) break;
                  gBS->Stall(100000);
                }

                if (RequestToken.Status == EFI_SUCCESS) {
                  Print(L"    [OK] HTTP request succeeded!\n");

                  // Read response
                  EFI_HTTP_RESPONSE_DATA ResponseData;
                  ZeroMem(&ResponseData, sizeof(ResponseData));

                  EFI_HTTP_MESSAGE ResponseMessage;
                  ZeroMem(&ResponseMessage, sizeof(ResponseMessage));
                  ResponseMessage.Data.Response = &ResponseData;

                  UINT8 ResponseBody[1024];
                  ZeroMem(ResponseBody, sizeof(ResponseBody));
                  ResponseMessage.BodyLength = sizeof(ResponseBody);
                  ResponseMessage.Body = ResponseBody;

                  EFI_HTTP_TOKEN ResponseToken;
                  ZeroMem(&ResponseToken, sizeof(ResponseToken));
                  ResponseToken.Status = EFI_NOT_READY;
                  ResponseToken.Message = &ResponseMessage;

                  gBS->CreateEvent(EVT_NOTIFY_SIGNAL, TPL_CALLBACK, NULL, NULL, &ResponseToken.Event);

                  Status = HttpProtocol->Response(HttpProtocol, &ResponseToken);
                  if (!EFI_ERROR(Status)) {
                    for (Index = 0; Index < 200; Index++) {
                      if (ResponseToken.Status != EFI_NOT_READY) break;
                      gBS->Stall(100000);
                    }

                    if (ResponseToken.Status == EFI_SUCCESS) {
                      Print(L"    [OK] Got response! Status: %d, Body: %d bytes\n",
                        ResponseData.StatusCode, ResponseMessage.BodyLength);
                      if (ResponseMessage.BodyLength > 0) {
                        Print(L"    Body: ");
                        UINTN PrintLen = ResponseMessage.BodyLength;
                        if (PrintLen > 200) PrintLen = 200;
                        for (Index = 0; Index < PrintLen; Index++) {
                          if (ResponseBody[Index] >= 0x20 && ResponseBody[Index] < 0x7f) {
                            Print(L"%c", ResponseBody[Index]);
                          }
                        }
                        Print(L"\n");
                      }
                    } else {
                      Print(L"    [FAIL] Response status: 0x%08x\n", ResponseToken.Status);
                    }
                  }
                } else if (RequestToken.Status == EFI_NOT_READY) {
                  Print(L"    [TIMEOUT] Request did not complete in 20 seconds\n");
                } else {
                  Print(L"    [FAIL] Request completed with error: 0x%08x\n", RequestToken.Status);
                }
              }
            }
          }
        }
      }
      FreePool(HandleBuffer);
    }
  } else {
    Print(L"\n[5] HTTP Service Binding still not available.\n");
    Print(L"    Firmware-level HTTP check-in is NOT viable with this approach.\n");
  }

  Print(L"\n");
  Print(L"Network init test complete. Press any key to continue...\n");

  gST->ConIn->Reset(gST->ConIn, FALSE);
  EFI_INPUT_KEY Key;
  while (gST->ConIn->ReadKeyStroke(gST->ConIn, &Key) == EFI_NOT_READY) {
    // Wait
  }

  return EFI_SUCCESS;
}
