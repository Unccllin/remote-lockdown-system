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

// EFI_HTTP_PROTOCOL GUID
STATIC EFI_GUID mHttpProtocolGuid = EFI_HTTP_PROTOCOL_GUID;

/** Parse a URI string to extract the hostname (for TLS verification).

  @param  Uri       Null-terminated ASCII URI (e.g., "https://host/path").
  @param  Hostname  Output buffer for the hostname (null-terminated).
  @param  HostnameSize  Size of the Hostname buffer.

  @retval EFI_SUCCESS  Hostname extracted.
  @retval EFI_INVALID_PARAMETER  URI is not https:// or malformed.
**/
STATIC
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

  // Must start with "https://"
  if (AsciiStrnCmp (Uri, "https://", 8) != 0) {
    return EFI_INVALID_PARAMETER;
  }

  Start = Uri + 8;
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

  // Reject plaintext http://
  if (AsciiStrnCmp (Uri, "https://", 8) != 0) {
    return EFI_INVALID_PARAMETER;
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

  // Locate EFI_HTTP_PROTOCOL
  Status = gBS->LocateProtocol (&mHttpProtocolGuid, NULL, (VOID **)&Http);
  if (EFI_ERROR (Status) || Http == NULL) {
    return EFI_NOT_FOUND;
  }

  // Configure HTTP instance (IPv4, HTTP/1.1)
  ZeroMem (&ConfigData, sizeof (ConfigData));
  ZeroMem (&V4Access, sizeof (V4Access));
  ConfigData.HttpVersion = HttpVersion11;
  ConfigData.TimeOutMillisec = (UINT32)ConnectTimeoutMs;
  ConfigData.LocalAddressIsIPv6 = FALSE;
  V4Access.UseDefaultAddress = TRUE;
  V4Access.LocalPort = 0;
  ConfigData.AccessPoint.IPv4Node = &V4Access;

  Status = Http->Configure (Http, &ConfigData);
  if (EFI_ERROR (Status)) {
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
  return Status;
}
