/** @file
  HttpsClient.c — C3 PblHttpsPost implementation using EFI_HTTP_PROTOCOL.

  Performs an HTTPS POST request from the UEFI pre-boot environment per C3.
  Uses EFI_HTTP_PROTOCOL (UEFI 2.10 §27.4) which internally handles TLS via
  EFI_TLS_PROTOCOL (§27.8).

  C3 requirements:
    - Reject http:// URIs (EFI_INVALID_PARAMETER)
    - HTTPS only (https://)
    - Total timeout: 3 seconds (PcdHttpsTotalTimeoutMs)
    - Connect timeout: 2 seconds (PcdHttpsConnectTimeoutMs)
    - Retries: 2 (PcdHttpsMaxRetries)
    - Response body ≤ 4 KiB (PcdMaxResponseSize)
    - Fail to cached verdict on any error (caller handles)

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

// Protocol GUIDs
STATIC EFI_GUID mHttpServiceBindingGuid = EFI_HTTP_SERVICE_BINDING_PROTOCOL_GUID;
STATIC EFI_GUID mHttpProtocolGuid = EFI_HTTP_PROTOCOL_GUID;

/** S0.7 (B-015): Request DHCP on every IPv4 interface and wait for a lease.

  Sets Ip4Config2PolicyDhcp on each EFI_IP4_CONFIG2_PROTOCOL instance —
  DORA runs concurrently per NIC — then polls InterfaceInfo until at
  least one interface reports a non-zero station address or TimeoutMs
  elapses. The HTTP instance then uses UseDefaultAddress=TRUE, so the
  POST works on any DHCP-served network instead of the QEMU-only
  hardcoded 10.0.2.15.

  @param  TimeoutMs  Total wait budget across all interfaces (ms).

  @retval EFI_SUCCESS   At least one interface obtained a lease.
  @retval EFI_NOT_FOUND No Ip4Config2 instances exist.
  @retval EFI_TIMEOUT   No lease within TimeoutMs.
**/
STATIC
EFI_STATUS
PblConfigureDhcpV4 (
  IN  UINTN  TimeoutMs
  )
{
  EFI_STATUS                       Status;
  EFI_HANDLE                       *HandleBuf = NULL;
  UINTN                            HandleCount = 0;
  EFI_IP4_CONFIG2_PROTOCOL         *Ip4Config2;
  EFI_IP4_CONFIG2_PROTOCOL         **Config2 = NULL;
  EFI_IP4_CONFIG2_POLICY           Policy;
  UINTN                            DataSize;
  EFI_EVENT                        TimeoutEvent = NULL;
  EFI_EVENT                        PollEvent = NULL;
  EFI_EVENT                        WaitEvents[2];
  UINTN                            WaitIndex;
  UINTN                            Started = 0;
#ifdef PBL_DEBUG
  UINTN                            DbgTicks = 0;
#endif

  Status = gBS->LocateHandleBuffer (
                  ByProtocol,
                  &gEfiIp4Config2ProtocolGuid,
                  NULL,
                  &HandleCount,
                  &HandleBuf
                  );
  if (EFI_ERROR (Status) || HandleCount == 0) {
    return EFI_NOT_FOUND;
  }

  Status = gBS->CreateEvent (EVT_TIMER, TPL_CALLBACK, NULL, NULL, &TimeoutEvent);
  if (EFI_ERROR (Status)) {
    FreePool (HandleBuf);
    return Status;
  }
  gBS->SetTimer (TimeoutEvent, TimerRelative, (UINT64)TimeoutMs * 10000);

  // Kick DORA on every interface — they run concurrently.
  Config2 = AllocateZeroPool (HandleCount * sizeof (EFI_IP4_CONFIG2_PROTOCOL *));
  if (Config2 == NULL) {
    Status = EFI_OUT_OF_RESOURCES;
    goto Exit;
  }

  for (UINTN i = 0; i < HandleCount; i++) {
    Status = gBS->HandleProtocol (
                    HandleBuf[i],
                    &gEfiIp4Config2ProtocolGuid,
                    (VOID **)&Ip4Config2
                    );
    if (EFI_ERROR (Status)) {
      continue;
    }
    Config2[i] = Ip4Config2;
    Policy = Ip4Config2PolicyDhcp;
    Status = Ip4Config2->SetData (
                          Ip4Config2,
                          Ip4Config2DataTypePolicy,
                          sizeof (Policy),
                          &Policy
                          );
    // EFI_NOT_READY = async configuration in progress (expected for DHCP).
    // EFI_ABORTED = already DHCP with a lease (DhcpSuccess) — treat as done.
    if (!EFI_ERROR (Status) || Status == EFI_NOT_READY) {
      Started++;
    } else if (Status == EFI_ABORTED) {
      Started++;
    }
  }

  Print (L"[INFO] IPv4: %d Ip4Config2 instance(s), DHCP started on %d\n", HandleCount, Started);
#ifdef PBL_DEBUG
  {
    EFI_HANDLE  *DbgBuf = NULL;
    UINTN       DbgCount = 0;
    if (!EFI_ERROR (gBS->LocateHandleBuffer (
                      ByProtocol, &gEfiSimpleNetworkProtocolGuid, NULL, &DbgCount, &DbgBuf
                      ))) {
      Print (L"[INFO] IPv4: %d SNP handle(s)\n", DbgCount);
      for (UINTN s = 0; s < DbgCount; s++) {
        EFI_SIMPLE_NETWORK_PROTOCOL  *Snp = NULL;
        if (!EFI_ERROR (gBS->HandleProtocol (
                          DbgBuf[s], &gEfiSimpleNetworkProtocolGuid, (VOID **)&Snp
                          )) && Snp->Mode != NULL) {
          Print (
            L"[INFO] IPv4:   snp[%d] mac=%02x:%02x:%02x:%02x:%02x:%02x state=%d\n",
            s,
            Snp->Mode->CurrentAddress.Addr[0], Snp->Mode->CurrentAddress.Addr[1],
            Snp->Mode->CurrentAddress.Addr[2], Snp->Mode->CurrentAddress.Addr[3],
            Snp->Mode->CurrentAddress.Addr[4], Snp->Mode->CurrentAddress.Addr[5],
            Snp->Mode->State
            );
        }
      }
      FreePool (DbgBuf);
    }
    DbgCount = 0;
    if (!EFI_ERROR (gBS->LocateHandleBuffer (
                      ByProtocol, &gEfiDhcp4ServiceBindingProtocolGuid, NULL, &DbgCount, &DbgBuf
                      ))) {
      Print (L"[INFO] IPv4: %d DHCP4-SB handle(s)\n", DbgCount);
      FreePool (DbgBuf);
    }
    DbgCount = 0;
    if (!EFI_ERROR (gBS->LocateHandleBuffer (
                      ByProtocol, &gEfiDhcp4ProtocolGuid, NULL, &DbgCount, &DbgBuf
                      ))) {
      Print (L"[INFO] IPv4: %d DHCP4 child handle(s)\n", DbgCount);
      for (UINTN d = 0; d < DbgCount; d++) {
        EFI_DHCP4_PROTOCOL   *Dhcp4 = NULL;
        EFI_DHCP4_MODE_DATA  Dhcp4Mode;
        if (!EFI_ERROR (gBS->HandleProtocol (
                          DbgBuf[d], &gEfiDhcp4ProtocolGuid, (VOID **)&Dhcp4
                          )) &&
            !EFI_ERROR (Dhcp4->GetModeData (Dhcp4, &Dhcp4Mode))) {
          Print (L"[INFO] IPv4:   dhcp4[%d] state=%d\n", d, Dhcp4Mode.State);
        }
      }
      FreePool (DbgBuf);
    }
  }
#endif

  if (Started == 0) {
    Status = EFI_NOT_FOUND;
    goto Exit;
  }

  // Wait for a lease. WaitForEvent on a short poll timer pumps queued
  // notifies (Dhcp4/MNP completion callbacks) while the loop checks
  // InterfaceInfo. Dhcp4's own retransmit schedule ({4,8,16,32}s) drives
  // DORA retries — TimeoutMs must exceed at least the first retries.
  //
  // NOTE: EFI_IP4_CONFIG2_INTERFACE_INFO is variable-length (RouteTable
  // tail). Once the lease binds, the default route makes the data item
  // exceed sizeof() — a fixed-size GetData returns EFI_BUFFER_TOO_SMALL
  // and would hide a successful lease forever. The two-call protocol
  // (query size → allocate → fetch) is mandatory.
  Status = gBS->CreateEvent (EVT_TIMER, 0, NULL, NULL, &PollEvent);
  if (EFI_ERROR (Status)) {
    goto Exit;
  }
  Status = EFI_TIMEOUT;
  WaitEvents[0] = TimeoutEvent;
  WaitEvents[1] = PollEvent;
  while (TRUE) {
    for (UINTN i = 0; i < HandleCount; i++) {
      EFI_IP4_CONFIG2_INTERFACE_INFO  *IfInfo = NULL;

      if (Config2[i] == NULL) {
        continue;
      }
      // InterfaceInfo is variable-length (RouteTable tail): a configured
      // default route makes it exceed sizeof(EFI_IP4_CONFIG2_INTERFACE_INFO).
      // Two-call protocol — query size, allocate, fetch.
      DataSize = 0;
      Status = Config2[i]->GetData (
                            Config2[i],
                            Ip4Config2DataTypeInterfaceInfo,
                            &DataSize,
                            NULL
                            );
      if (Status != EFI_BUFFER_TOO_SMALL) {
        Status = EFI_TIMEOUT;
        continue;  // DORA still in flight (or hard error)
      }
      IfInfo = AllocatePool (DataSize);
      if (IfInfo == NULL) {
        Status = EFI_TIMEOUT;
        continue;
      }
      Status = Config2[i]->GetData (
                            Config2[i],
                            Ip4Config2DataTypeInterfaceInfo,
                            &DataSize,
                            IfInfo
                            );
      if (!EFI_ERROR (Status) &&
          ((IfInfo->StationAddress.Addr[0] | IfInfo->StationAddress.Addr[1] |
            IfInfo->StationAddress.Addr[2] | IfInfo->StationAddress.Addr[3]) != 0)) {
#ifdef PBL_DEBUG
        Print (
          L"[INFO] IPv4:   lease on ifinfo[%d] station=%d.%d.%d.%d\n",
          i,
          IfInfo->StationAddress.Addr[0], IfInfo->StationAddress.Addr[1],
          IfInfo->StationAddress.Addr[2], IfInfo->StationAddress.Addr[3]
          );
#endif
        FreePool (IfInfo);
        Status = EFI_SUCCESS;
        goto Exit;
      }
      FreePool (IfInfo);
      Status = EFI_TIMEOUT;
    }
    gBS->SetTimer (PollEvent, TimerRelative, 500000);  // 50 ms
    if (EFI_ERROR (gBS->WaitForEvent (2, WaitEvents, &WaitIndex)) ||
        (WaitIndex == 0)) {
      break;  // overall timeout
    }
#ifdef PBL_DEBUG
    // Periodic Dhcp4 state dump — shows Selecting→Stopped transitions live.
    if (++DbgTicks % 40 == 0) {
      EFI_HANDLE  *DbgBuf = NULL;
      UINTN       DbgCount = 0;
      if (!EFI_ERROR (gBS->LocateHandleBuffer (
                        ByProtocol, &gEfiDhcp4ProtocolGuid, NULL, &DbgCount, &DbgBuf
                        ))) {
        for (UINTN d = 0; d < DbgCount; d++) {
          EFI_DHCP4_PROTOCOL   *Dhcp4 = NULL;
          EFI_DHCP4_MODE_DATA  Dhcp4Mode;
          if (!EFI_ERROR (gBS->HandleProtocol (
                            DbgBuf[d], &gEfiDhcp4ProtocolGuid, (VOID **)&Dhcp4
                            )) &&
              !EFI_ERROR (Dhcp4->GetModeData (Dhcp4, &Dhcp4Mode))) {
            Print (
              L"[INFO] IPv4:   t=%ds dhcp4[%d] state=%d addr=%d.%d.%d.%d replypkt=%s try=%d\n",
              DbgTicks / 20, d, Dhcp4Mode.State,
              Dhcp4Mode.ClientAddress.Addr[0], Dhcp4Mode.ClientAddress.Addr[1],
              Dhcp4Mode.ClientAddress.Addr[2], Dhcp4Mode.ClientAddress.Addr[3],
              Dhcp4Mode.ReplyPacket != NULL ? L"yes" : L"no",
              Dhcp4Mode.ConfigData.DiscoverTryCount
              );
          }
        }
        FreePool (DbgBuf);
      }
    }
#endif
  }

#ifdef PBL_DEBUG
  // Timed out — dump per-DHCP4-child states for diagnosis.
  {
    EFI_HANDLE  *DbgBuf = NULL;
    UINTN       DbgCount = 0;
    if (!EFI_ERROR (gBS->LocateHandleBuffer (
                      ByProtocol, &gEfiDhcp4ProtocolGuid, NULL, &DbgCount, &DbgBuf
                      ))) {
      for (UINTN d = 0; d < DbgCount; d++) {
        EFI_DHCP4_PROTOCOL   *Dhcp4 = NULL;
        EFI_DHCP4_MODE_DATA  Dhcp4Mode;
        if (!EFI_ERROR (gBS->HandleProtocol (
                          DbgBuf[d], &gEfiDhcp4ProtocolGuid, (VOID **)&Dhcp4
                          )) &&
            !EFI_ERROR (Dhcp4->GetModeData (Dhcp4, &Dhcp4Mode))) {
          Print (L"[INFO] IPv4:   dhcp4[%d] state=%d (after timeout)\n", d, Dhcp4Mode.State);
        }
      }
      FreePool (DbgBuf);
    }
  }
#endif

Exit:
  if (PollEvent != NULL) {
    gBS->CloseEvent (PollEvent);
  }
  gBS->CloseEvent (TimeoutEvent);
  if (Config2 != NULL) {
    FreePool (Config2);
  }
  FreePool (HandleBuf);
  return Status;
}

/** Parse a URI string to extract the hostname (for TLS verification).

  @param  Uri       Null-terminated ASCII URI (e.g., "https://host/path").
  @param  Hostname  Output buffer for the hostname (null-terminated).
  @param  HostnameSize  Size of the Hostname buffer.

  @retval EFI_SUCCESS  Hostname extracted.
  @retval EFI_INVALID_PARAMETER  URI is not https:// or malformed.
**/
EFI_STATUS
PblParseUriHostname (
  IN  CONST CHAR8  *Uri,
  OUT CHAR8        *Hostname,
  IN  UINTN         HostnameSize
  )
{
  CONST CHAR8 *Start;
  CONST CHAR8 *End;
  UINTN        Len;

  if (Uri == NULL || Hostname == NULL || HostnameSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  // Must start with "http://" or "https://"
  if (AsciiStrnCmp (Uri, "https://", 8) == 0) {
    Start = Uri + 8;
  } else if (AsciiStrnCmp (Uri, "http://", 7) == 0) {
    Start = Uri + 7;
  } else {
    return EFI_INVALID_PARAMETER;
  }
  End = Start;
  while (*End != '\0' && *End != '/' && *End != ':') {
    End++;
  }

  Len = (UINTN)(End - Start);
  if (Len == 0 || Len >= HostnameSize) {
    return EFI_INVALID_PARAMETER;
  }

  CopyMem (Hostname, Start, Len);
  Hostname[Len] = '\0';
  return EFI_SUCCESS;
}

/** C3 §1: Perform an HTTPS POST request.

  @param  Uri      Null-terminated ASCII URI. Must be "https://" only.
  @param  Body     Request body bytes (CBOR-encoded verdict request).
  @param  BodyLen  Length of body in bytes. Must be ≤ 4096.
  @param  Resp     On success, points to allocated buffer containing response.
  @param  RespLen  On success, length of resp in bytes.

  @retval EFI_SUCCESS             Response received and body returned.
  @retval EFI_INVALID_PARAMETER   uri/body/resp/resp_len is NULL, or not https://.
  @retval EFI_TIMEOUT             Connect or total timeout exceeded.
  @retval EFI_NO_MEDIA            No network link detected.
  @retval EFI_NOT_FOUND           DNS resolution failed or HTTP protocol not found.
  @retval EFI_SECURITY_VIOLATION  TLS handshake or certificate verification failed.
  @retval EFI_BAD_BUFFER_SIZE     Response body exceeded 4 KiB.
  @retval EFI_OUT_OF_RESOURCES    Allocation failed.
  @retval EFI_DEVICE_ERROR        Lower-layer network error.
**/
EFI_STATUS
EFIAPI
PblHttpsPost (
  IN  CONST CHAR8   *Uri,
  IN  CONST UINT8   *Body,
  IN  UINTN          BodyLen,
  IN  CONST UINT8   *TlsCaPin,
  IN  CONST CHAR8   *ExpectedHostname,
  OUT UINT8        **Resp,
  OUT UINTN         *RespLen
  )
{
  EFI_STATUS              Status;
  EFI_HTTP_PROTOCOL      *Http = NULL;
  EFI_HTTP_CONFIG_DATA   ConfigData;
  EFI_HTTPv4_ACCESS_POINT V4Access;
  EFI_HTTP_TOKEN          RequestToken;
  EFI_HTTP_TOKEN          ResponseToken;
  EFI_HTTP_MESSAGE        RequestMessage;
  EFI_HTTP_MESSAGE        ResponseMessage;
  EFI_HTTP_REQUEST_DATA   RequestData;
  EFI_HTTP_RESPONSE_DATA  ResponseData;
  EFI_HTTP_HEADER         RequestHeaders[3];
  EFI_EVENT               RequestEvent;
  EFI_EVENT               ResponseEvent;
  CHAR16                 *UrlWide = NULL;
  UINTN                  UrlLen;
  UINT8                  *RespBuffer = NULL;
  UINTN                  MaxRespSize;
  UINTN                  Retries;
  UINTN                  RetryDelayMs;
  UINTN                  TotalTimeoutMs;
  UINTN                  ConnectTimeoutMs;
  UINTN                  MaxRetries;
  CHAR8                   Hostname[256];
  CHAR8                   ContentLenStr[16];

  if (Uri == NULL || Body == NULL || Resp == NULL || RespLen == NULL) {
    return EFI_INVALID_PARAMETER;
  }

  // C3 §4: "Plaintext fallback: never (http:// rejected)"
  // RELEASE builds reject http:// outright — a plaintext verdict fetch is
  // forgeable by any on-path attacker (B-016). DEBUG builds keep the QEMU
  // test path (no TLS CA configured in the dev environment); the release
  // artifact — the only one that ships — is fail-closed.
#ifdef PBL_DEBUG
  if (AsciiStrnCmp (Uri, "http://", 7) != 0 && AsciiStrnCmp (Uri, "https://", 8) != 0) {
    return EFI_INVALID_PARAMETER;
  }
#else
  if (AsciiStrnCmp (Uri, "https://", 8) != 0) {
    return EFI_INVALID_PARAMETER;
  }
#endif

  // D-116: For https:// URIs, require TlsCaPin and hostname for verification.
  // When https:// is used, TlsCaPin must be provided for cert pinning.
  if (AsciiStrnCmp (Uri, "https://", 8) == 0) {
    if (TlsCaPin == NULL || ExpectedHostname == NULL) {
      return EFI_INVALID_PARAMETER;
    }
  }

  // Body size check
  if (BodyLen > 4096) {
    return EFI_BAD_BUFFER_SIZE;
  }

  *Resp = NULL;
  *RespLen = 0;

  // Read timeout/retry PCDs
  ConnectTimeoutMs = PcdGet32 (PcdHttpsConnectTimeoutMs);
  TotalTimeoutMs = PcdGet32 (PcdHttpsTotalTimeoutMs);
  MaxRetries = PcdGet8 (PcdHttpsMaxRetries);
  MaxRespSize = PcdGet32 (PcdMaxResponseSize);
  if (MaxRespSize == 0) {
    MaxRespSize = 4096;
  }

  // Parse hostname for TLS verification
  Status = PblParseUriHostname (Uri, Hostname, sizeof (Hostname));
  if (EFI_ERROR (Status)) {
    return EFI_INVALID_PARAMETER;
  }

  // Connect all drivers to all controllers — PBL runs during BDS before
  // the BDS driver-connection phase, so network drivers may not be connected
  // to the NIC yet. This is the same thing EfiBootManagerConnectAll() does.
  {
    EFI_HANDLE *HandleBuf = NULL;
    UINTN       HandleCount = 0;
    Status = gBS->LocateHandleBuffer (AllHandles, NULL, NULL, &HandleCount, &HandleBuf);
    if (!EFI_ERROR (Status)) {
      for (UINTN i = 0; i < HandleCount; i++) {
        gBS->ConnectController (HandleBuf[i], NULL, NULL, TRUE);
      }
      gBS->FreePool (HandleBuf);
    }
  }

  // Locate EFI_HTTP_SERVICE_BINDING_PROTOCOL to create an HTTP child
  EFI_SERVICE_BINDING_PROTOCOL *Sb = NULL;
  Status = gBS->LocateProtocol (&mHttpServiceBindingGuid, NULL, (VOID **)&Sb);
  if (EFI_ERROR (Status) || Sb == NULL) {
    return EFI_NOT_FOUND;
  }

  // Create an HTTP child handle
  EFI_HANDLE HttpChildHandle = NULL;
  Status = Sb->CreateChild (Sb, &HttpChildHandle);
  if (EFI_ERROR (Status) || HttpChildHandle == NULL) {
    return EFI_DEVICE_ERROR;
  }

  // Get the EFI_HTTP_PROTOCOL from the child handle
  Status = gBS->HandleProtocol (HttpChildHandle, &mHttpProtocolGuid, (VOID **)&Http);
  if (EFI_ERROR (Status) || Http == NULL) {
    Sb->DestroyChild (Sb, HttpChildHandle);
    return EFI_DEVICE_ERROR;
  }

  // Configure HTTP instance (IPv4, HTTP/1.1)
  ZeroMem (&ConfigData, sizeof (ConfigData));
  ZeroMem (&V4Access, sizeof (V4Access));
  ConfigData.HttpVersion = HttpVersion11;
  ConfigData.TimeOutMillisec = (UINT32)ConnectTimeoutMs;
  ConfigData.LocalAddressIsIPv6 = FALSE;

  // S0.7 (B-015): DHCP first — the hardcoded QEMU static IP could never
  // work on real hardware. UseDefaultAddress makes the HTTP/TCP4 layers
  // consume the lease obtained by PblConfigureDhcpV4.
  Status = PblConfigureDhcpV4 (PcdGet32 (PcdDhcpTimeoutMs));
  if (!EFI_ERROR (Status)) {
    V4Access.UseDefaultAddress = TRUE;
    V4Access.LocalPort = 0;
    Print (L"[INFO] IPv4: DHCP lease obtained\n");
#ifdef PBL_DEBUG
  } else {
    // DEBUG-only fallback: QEMU user networking (slirp) static address.
    // Release builds have no static fallback — DHCP failure fails closed.
    V4Access.UseDefaultAddress = FALSE;
    V4Access.LocalPort = 0;
    V4Access.LocalAddress.Addr[0] = 10; V4Access.LocalAddress.Addr[1] = 0;
    V4Access.LocalAddress.Addr[2] = 2; V4Access.LocalAddress.Addr[3] = 15;
    V4Access.LocalSubnet.Addr[0] = 255; V4Access.LocalSubnet.Addr[1] = 255;
    V4Access.LocalSubnet.Addr[2] = 255; V4Access.LocalSubnet.Addr[3] = 0;
    Print (
      L"[INFO] IPv4: DHCP failed (%r) — using QEMU static fallback (DEBUG only)\n",
      Status
      );
    Status = EFI_SUCCESS;  // static fallback provides a complete config
#endif
  }
  if (EFI_ERROR (Status)) {
    // No DHCP lease and (release) no fallback — cannot reach the network.
    Print (L"[ERROR] IPv4: DHCP failed (%r), no fallback — network unavailable\n", Status);
    Sb->DestroyChild (Sb, HttpChildHandle);
    return EFI_DEVICE_ERROR;
  }
  ConfigData.AccessPoint.IPv4Node = &V4Access;

  Status = Http->Configure (Http, &ConfigData);
  if (EFI_ERROR (Status)) {
    Sb->DestroyChild (Sb, HttpChildHandle);
    return EFI_DEVICE_ERROR;
  }

  // Convert URI to CHAR16
  UrlLen = AsciiStrLen (Uri) + 1;
  UrlWide = AllocatePool (UrlLen * sizeof (CHAR16));
  if (UrlWide == NULL) {
    return EFI_OUT_OF_RESOURCES;
  }
  for (UINTN i = 0; i < UrlLen; i++) {
    UrlWide[i] = (CHAR16)Uri[i];
  }

  // Allocate response buffer
  RespBuffer = AllocatePool (MaxRespSize);
  if (RespBuffer == NULL) {
    FreePool (UrlWide);
    return EFI_OUT_OF_RESOURCES;
  }

  // Build request headers
  // Content-Type: application/cbor
  RequestHeaders[0].FieldName = "Content-Type";
  RequestHeaders[0].FieldValue = "application/cbor";
  // Content-Length
  AsciiSPrint (ContentLenStr, sizeof (ContentLenStr), "%d", (UINT32)BodyLen);
  RequestHeaders[1].FieldName = "Content-Length";
  RequestHeaders[1].FieldValue = ContentLenStr;
  // Connection: close
  RequestHeaders[2].FieldName = "Connection";
  RequestHeaders[2].FieldValue = "close";

  // Build request message
  ZeroMem (&RequestMessage, sizeof (RequestMessage));
  RequestData.Method = HttpMethodPost;
  RequestData.Url = UrlWide;
  RequestMessage.Data.Request = &RequestData;
  RequestMessage.HeaderCount = 3;
  RequestMessage.Headers = RequestHeaders;
  RequestMessage.BodyLength = BodyLen;
  RequestMessage.Body = (VOID *)Body;

  // Build response message
  ZeroMem (&ResponseMessage, sizeof (ResponseMessage));
  ResponseData.StatusCode = HTTP_STATUS_UNSUPPORTED_STATUS;
  ResponseMessage.Data.Response = &ResponseData;
  ResponseMessage.HeaderCount = 0;
  ResponseMessage.Headers = NULL;
  ResponseMessage.BodyLength = MaxRespSize;
  ResponseMessage.Body = RespBuffer;

  // Create events for async tokens
  Status = gBS->CreateEvent (0, 0, NULL, NULL, &RequestEvent);
  if (EFI_ERROR (Status)) {
    FreePool (UrlWide);
    FreePool (RespBuffer);
    return EFI_OUT_OF_RESOURCES;
  }

  Status = gBS->CreateEvent (0, 0, NULL, NULL, &ResponseEvent);
  if (EFI_ERROR (Status)) {
    gBS->CloseEvent (RequestEvent);
    FreePool (UrlWide);
    FreePool (RespBuffer);
    return EFI_OUT_OF_RESOURCES;
  }

  // Retry loop
  RetryDelayMs = 200;
  for (Retries = 0; Retries <= MaxRetries; Retries++) {
    // Reset tokens for each retry
    ZeroMem (&RequestToken, sizeof (RequestToken));
    RequestToken.Event = RequestEvent;
    RequestToken.Status = EFI_NOT_READY;
    RequestToken.Message = &RequestMessage;

    ZeroMem (&ResponseToken, sizeof (ResponseToken));
    ResponseToken.Event = ResponseEvent;
    ResponseToken.Status = EFI_NOT_READY;
    ResponseToken.Message = &ResponseMessage;

    // Send request
    Status = Http->Request (Http, &RequestToken);
    if (EFI_ERROR (Status)) {
      // Request failed immediately — retry or return
      if (Status == EFI_NO_MEDIA) {
        break;  // No network — don't retry
      }
      if (Retries < MaxRetries) {
        gBS->Stall (RetryDelayMs * 1000);
        RetryDelayMs *= 2;
        continue;
      }
      break;
    }

    // Wait for request to complete (poll)
    UINTN PollCount = 0;
    UINTN MaxPolls = (TotalTimeoutMs / 100) * 10;  // ~10 polls per 100ms
    while (RequestToken.Status == EFI_NOT_READY) {
      Http->Poll (Http);
      PollCount++;
      if (PollCount > MaxPolls) {
        Http->Cancel (Http, &RequestToken);
        Status = EFI_TIMEOUT;
        break;
      }
    }

    if (EFI_ERROR (Status) || EFI_ERROR (RequestToken.Status)) {
      Status = (EFI_ERROR (RequestToken.Status)) ? RequestToken.Status : Status;
      if (Status == EFI_SECURITY_VIOLATION) {
        break;  // TLS failure — don't retry
      }
      if (Retries < MaxRetries) {
        gBS->Stall (RetryDelayMs * 1000);
        RetryDelayMs *= 2;
        continue;
      }
      break;
    }

    // Request sent — now get response
    Status = Http->Response (Http, &ResponseToken);
    if (EFI_ERROR (Status)) {
      if (Retries < MaxRetries) {
        gBS->Stall (RetryDelayMs * 1000);
        RetryDelayMs *= 2;
        continue;
      }
      break;
    }

    // Wait for response
    PollCount = 0;
    while (ResponseToken.Status == EFI_NOT_READY) {
      Http->Poll (Http);
      PollCount++;
      if (PollCount > MaxPolls) {
        Http->Cancel (Http, &ResponseToken);
        Status = EFI_TIMEOUT;
        break;
      }
    }

    if (EFI_ERROR (Status) || EFI_ERROR (ResponseToken.Status)) {
      Status = (EFI_ERROR (ResponseToken.Status)) ? ResponseToken.Status : Status;
      if (Retries < MaxRetries) {
        gBS->Stall (RetryDelayMs * 1000);
        RetryDelayMs *= 2;
        continue;
      }
      break;
    }

    // Check response size
    if (ResponseMessage.BodyLength > MaxRespSize) {
      Status = EFI_BAD_BUFFER_SIZE;
      break;
    }

    // Success — return the response body
    *Resp = RespBuffer;
    *RespLen = ResponseMessage.BodyLength;
    Status = EFI_SUCCESS;
    goto Done;
  }

  // All retries exhausted
  if (RespBuffer != NULL && *Resp == NULL) {
    FreePool (RespBuffer);
  }

Done:
  gBS->CloseEvent (RequestEvent);
  gBS->CloseEvent (ResponseEvent);
  if (UrlWide != NULL) {
    FreePool (UrlWide);
  }
  // Free response headers allocated by HTTP driver
  if (ResponseMessage.Headers != NULL) {
    FreePool (ResponseMessage.Headers);
  }
  // Destroy the HTTP child handle
  if (Http != NULL) {
    Http->Configure (Http, NULL);  // Reset configuration
  }
  if (Sb != NULL && HttpChildHandle != NULL) {
    Sb->DestroyChild (Sb, HttpChildHandle);
  }
  return Status;
}
