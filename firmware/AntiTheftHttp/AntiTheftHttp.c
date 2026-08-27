/*
 * AntiTheftHttp.c — Test EFI_HTTP_PROTOCOL in QEMU
 *
 * This tests whether the UEFI firmware can make HTTP requests
 * before the OS boots. This is critical for the architecture:
 * the firmware module needs to phone home even if the OS agent
 * has been removed.
 *
 * What this tests:
 * 1. Does EFI_HTTP_PROTOCOL exist in OVMF firmware?
 * 2. Can we get a DHCP lease from QEMU's built-in DHCP server?
 * 3. Can we make an HTTP GET request to a local server?
 * 4. Can we parse the response?
 *
 * If this works, the firmware-level check-in is viable.
 * If not, we need a different approach (e.g., DNS tunneling from firmware,
 * or defer all networking to the OS agent).
 */

#include <Uefi.h>
#include <Library/UefiApplicationEntryPoint.h>
#include <Library/UefiLib.h>
#include <Library/UefiRuntimeServicesTableLib.h>
#include <Library/UefiBootServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Protocol/ServiceBinding.h>
#include <Protocol/Http.h>
#include <Protocol/Ip4Config2.h>
#include <Protocol/Ip4.h>

EFI_STATUS
EFIAPI
AntiTheftHttpEntryPoint (
  IN EFI_HANDLE        ImageHandle,
  IN EFI_SYSTEM_TABLE  *SystemTable
  )
{
  EFI_STATUS  Status;
  UINTN       HandleCount;
  EFI_HANDLE  *HandleBuffer;
  EFI_HTTP_PROTOCOL *HttpProtocol = NULL;
  EFI_SERVICE_BINDING_PROTOCOL *HttpServiceBinding = NULL;
  EFI_HANDLE  HttpChildHandle = NULL;
  UINTN       Index;

  Print(L"\n");
  Print(L"========================================\n");
  Print(L"  Anti-Theft HTTP Protocol Test\n");
  Print(L"========================================\n");
  Print(L"\n");

  // === Step 0: Connect all controllers to trigger network stack init ===
  Print(L"[0] Connecting all controllers (triggering network stack)...\n");

  // Find all handles and connect them
  UINTN AllHandleCount;
  EFI_HANDLE *AllHandleBuffer;
  Status = gBS->LocateHandleBuffer(AllHandles, NULL, NULL, &AllHandleCount, &AllHandleBuffer);
  if (!EFI_ERROR(Status)) {
    Print(L"    Found %d handles, connecting each...\n", AllHandleCount);
    for (Index = 0; Index < AllHandleCount; Index++) {
      gBS->ConnectController(AllHandleBuffer[Index], NULL, NULL, TRUE);
    }
    FreePool(AllHandleBuffer);
    Print(L"    [OK] Connect pass complete\n");
  }

  // Also try to dispatch any remaining drivers
  // gBS->Dispatch() was removed in UEFI 2.x — use ConnectController instead

  // Give the network stack time to initialize (DHCP, etc.)
  Print(L"    Waiting 3 seconds for DHCP...\n");
  gBS->Stall(3000000);  // 3 seconds

  // === Step 1: Find EFI_SERVICE_BINDING_PROTOCOL for HTTP ===
  Print(L"[1] Locating HTTP Service Binding Protocol...\n");

  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiHttpServiceBindingProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] LocateHandleBuffer: 0x%08x\n", Status);
    Print(L"    HTTP Service Binding Protocol not found.\n");
    Print(L"    This means OVMF does not support EFI_HTTP_PROTOCOL.\n");
    Print(L"    The firmware-level HTTP check-in is NOT viable with this firmware.\n");
    goto Done;
  }

  Print(L"    [OK] Found %d handle(s) with HTTP Service Binding\n", HandleCount);

  // Get the service binding protocol
  Status = gBS->HandleProtocol(
    HandleBuffer[0],
    &gEfiHttpServiceBindingProtocolGuid,
    (VOID **)&HttpServiceBinding
  );

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] HandleProtocol: 0x%08x\n", Status);
    goto Done;
  }

  Print(L"    [OK] Got HTTP Service Binding Protocol\n");

  // === Step 2: Create an HTTP child handle ===
  Print(L"\n[2] Creating HTTP child handle...\n");

  Status = HttpServiceBinding->CreateChild(HttpServiceBinding, &HttpChildHandle);

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] CreateChild: 0x%08x\n", Status);
    goto Done;
  }

  Print(L"    [OK] HTTP child handle created: 0x%08x\n", HttpChildHandle);

  // === Step 3: Get the EFI_HTTP_PROTOCOL ===
  Print(L"\n[3] Getting EFI_HTTP_PROTOCOL...\n");

  Status = gBS->HandleProtocol(
    HttpChildHandle,
    &gEfiHttpProtocolGuid,
    (VOID **)&HttpProtocol
  );

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] HandleProtocol(Http): 0x%08x\n", Status);
    goto Done;
  }

  Print(L"    [OK] Got EFI_HTTP_PROTOCOL\n");

  // === Step 4: Initialize HTTP ===
  Print(L"\n[4] Initializing HTTP...\n");

  EFI_HTTP_CONFIG_DATA ConfigData;
  ZeroMem(&ConfigData, sizeof(ConfigData));
  ConfigData.HttpVersion = HttpVersion11;
  ConfigData.TimeOutMillisec = 5000;  // 5 second timeout
  ConfigData.LocalAddressIsIPv6 = FALSE;

  Status = HttpProtocol->Configure(HttpProtocol, &ConfigData);

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] Configure: 0x%08x\n", Status);
    Print(L"    HTTP configuration failed. Network may not be ready.\n");
    goto Done;
  }

  Print(L"    [OK] HTTP configured (IPv4, 5s timeout)\n");

  // === Step 5: Build and send an HTTP request ===
  Print(L"\n[5] Building HTTP request to 10.0.2.2:8080/checkin...\n");
  Print(L"    (10.0.2.2 is QEMU host from guest perspective)\n");

  EFI_HTTP_REQUEST_DATA RequestData;
  ZeroMem(&RequestData, sizeof(RequestData));
  RequestData.Method = HttpMethodGet;

  // URL: http://10.0.2.2:8080/checkin
  // In UEFI, the URL is a CHAR16 string
  RequestData.Url = L"http://10.0.2.2:8080/checkin";

  EFI_HTTP_HEADER Headers[1];
  Headers[0].FieldName = (CHAR8 *)"Host";
  Headers[0].FieldValue = (CHAR8 *)"10.0.2.2:8080";

  EFI_HTTP_MESSAGE RequestMessage;
  ZeroMem(&RequestMessage, sizeof(RequestMessage));
  RequestMessage.Data.Request = &RequestData;
  RequestMessage.HeaderCount = 1;
  RequestMessage.Headers = Headers;
  RequestMessage.BodyLength = 0;
  RequestMessage.Body = NULL;

  EFI_HTTP_TOKEN RequestToken;
  ZeroMem(&RequestToken, sizeof(RequestToken));
  RequestToken.Status = EFI_NOT_READY;
  RequestToken.Message = &RequestMessage;

  // Create an event for the async request
  Status = gBS->CreateEvent(
    EVT_NOTIFY_SIGNAL,
    TPL_CALLBACK,
    NULL,
    NULL,
    &RequestToken.Event
  );

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] CreateEvent: 0x%08x\n", Status);
    goto Done;
  }

  Print(L"    [OK] Request built, sending...\n");

  // === Step 6: Send the request ===
  Print(L"\n[6] Sending HTTP request...\n");

  Status = HttpProtocol->Request(HttpProtocol, &RequestToken);

  if (EFI_ERROR(Status)) {
    Print(L"    [FAIL] Request: 0x%08x\n", Status);
    if (Status == EFI_NOT_STARTED) {
      Print(L"    EFI_NOT_STARTED — HTTP not configured properly\n");
    } else if (Status == EFI_TIMEOUT) {
      Print(L"    EFI_TIMEOUT — server may not be running\n");
    } else if (Status == EFI_DEVICE_ERROR) {
      Print(L"    EFI_DEVICE_ERROR — network device error\n");
    }
    goto Done;
  }

  Print(L"    [OK] Request sent, waiting for response...\n");

  // Wait for the request to complete (poll for up to 10 seconds)
  for (Index = 0; Index < 100; Index++) {
    if (RequestToken.Status != EFI_NOT_READY) {
      break;
    }
    gBS->Stall(100000);  // 100ms
  }

  if (RequestToken.Status == EFI_NOT_READY) {
    Print(L"    [TIMEOUT] Request did not complete in 10 seconds\n");
    Print(L"    This could mean:\n");
    Print(L"    - No DHCP lease (network not configured)\n");
    Print(L"    - Server not running on host\n");
    Print(L"    - Firewall blocking the connection\n");
  } else if (EFI_ERROR(RequestToken.Status)) {
    Print(L"    [FAIL] Request completed with error: 0x%08x\n", RequestToken.Status);
  } else {
    Print(L"    [OK] Request completed successfully!\n");

    // === Step 7: Read the response ===
    Print(L"\n[7] Reading response...\n");

    EFI_HTTP_RESPONSE_DATA ResponseData;
    ZeroMem(&ResponseData, sizeof(ResponseData));

    EFI_HTTP_MESSAGE ResponseMessage;
    ZeroMem(&ResponseMessage, sizeof(ResponseMessage));
    ResponseMessage.Data.Response = &ResponseData;

    // Allocate buffer for response headers
    EFI_HTTP_HEADER ResponseHeaders[10];
    ZeroMem(ResponseHeaders, sizeof(ResponseHeaders));
    ResponseMessage.HeaderCount = 10;
    ResponseMessage.Headers = ResponseHeaders;

    // Allocate buffer for response body
    UINT8 ResponseBody[1024];
    ZeroMem(ResponseBody, sizeof(ResponseBody));
    ResponseMessage.BodyLength = sizeof(ResponseBody);
    ResponseMessage.Body = ResponseBody;

    EFI_HTTP_TOKEN ResponseToken;
    ZeroMem(&ResponseToken, sizeof(ResponseToken));
    ResponseToken.Status = EFI_NOT_READY;
    ResponseToken.Message = &ResponseMessage;

    Status = gBS->CreateEvent(
      EVT_NOTIFY_SIGNAL,
      TPL_CALLBACK,
      NULL,
      NULL,
      &ResponseToken.Event
    );

    if (EFI_ERROR(Status)) {
      Print(L"    [FAIL] CreateEvent(response): 0x%08x\n", Status);
      goto Done;
    }

    Status = HttpProtocol->Response(HttpProtocol, &ResponseToken);

    if (EFI_ERROR(Status)) {
      Print(L"    [FAIL] Response: 0x%08x\n", Status);
      goto Done;
    }

    // Wait for response
    for (Index = 0; Index < 100; Index++) {
      if (ResponseToken.Status != EFI_NOT_READY) {
        break;
      }
      gBS->Stall(100000);
    }

    if (ResponseToken.Status == EFI_SUCCESS) {
      Print(L"    [OK] Got response!\n");
      Print(L"    Status Code: %d\n", ResponseData.StatusCode);
      Print(L"    Headers: %d\n", ResponseMessage.HeaderCount);
      Print(L"    Body Length: %d bytes\n", ResponseMessage.BodyLength);
      if (ResponseMessage.BodyLength > 0) {
        // Print first 256 bytes of body
        UINTN PrintLen = ResponseMessage.BodyLength;
        if (PrintLen > 256) PrintLen = 256;
        Print(L"    Body (first %d bytes): ", PrintLen);
        for (Index = 0; Index < PrintLen; Index++) {
          if (ResponseBody[Index] >= 0x20 && ResponseBody[Index] < 0x7f) {
            Print(L"%c", ResponseBody[Index]);
          } else {
            Print(L".");
          }
        }
        Print(L"\n");
      }
    } else {
      Print(L"    [FAIL] Response status: 0x%08x\n", ResponseToken.Status);
    }
  }

Done:
  Print(L"\n");
  Print(L"HTTP test complete. Press any key to continue...\n");

  // Cleanup
  if (HttpChildHandle != NULL) {
    HttpServiceBinding->DestroyChild(HttpServiceBinding, HttpChildHandle);
  }

  // Wait for keypress
  gST->ConIn->Reset(gST->ConIn, FALSE);
  EFI_INPUT_KEY Key;
  while (gST->ConIn->ReadKeyStroke(gST->ConIn, &Key) == EFI_NOT_READY) {
    // Wait
  }

  return EFI_SUCCESS;
}
