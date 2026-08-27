/*
 * dns_tunnel.c — DNS tunnel fallback for covert check-in
 *
 * When HTTP check-in fails (network stack not ready, firewall blocks HTTP,
 * or the anti-theft server is unreachable), the agent falls back to DNS
 * tunneling. DNS traffic is almost always allowed through firewalls and
 * captive portals, making it an ideal covert channel.
 *
 * Protocol:
 *   1. Encode device ID + state as base32 in DNS query subdomain labels
 *   2. Send DNS query for TXT record at <encoded-data>.<domain>
 *   3. Server responds with TXT record containing base32-encoded response
 *   4. Decode response: "ACTIVATE", "RECOVER", "ACK", or "NET_READY"
 *
 * The DNS tunnel server (dns-tunnel-server.py) must be running on a
 * server that is authoritative for the configured domain.
 *
 * This module uses EFI_DNS4_PROTOCOL to send DNS queries. It requires
 * the network stack to be initialized (DHCP) and the DNS4 service
 * binding to be available.
 */

#include "AntiTheftAgent.h"
#include <Library/UefiBootServicesTableLib.h>
#include <Library/MemoryAllocationLib.h>
#include <Library/BaseMemoryLib.h>
#include <Library/BaseLib.h>
#include <Protocol/ServiceBinding.h>
#include <Protocol/Dns4.h>

//
// DNS tunnel configuration
//
#define DNS_TUNNEL_DOMAIN    "t.antitheft.test"
#define DNS_TUNNEL_DNS_SERVER { 192, 168, 1, 100 }
#define DNS_TUNNEL_PORT      53
#define DNS_TXT_RECORD_TYPE  16
#define DNS_CLASS_IN         1

//
// Base32 encoding table (RFC 4648, no padding)
//
static const CHAR8 Base32Table[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

//
// Encode bytes to base32 string (no padding)
// Returns number of characters written
//
static UINTN
Base32Encode (
  IN  CONST UINT8  *Data,
  IN  UINTN         DataLen,
  OUT CHAR8         *Out,
  IN  UINTN         OutSize
  )
{
  UINTN  i, j;
  UINTN  bits = 0;
  UINT32 value = 0;

  if (Out == NULL || OutSize == 0) {
    return 0;
  }

  j = 0;
  for (i = 0; i < DataLen && j < OutSize - 1; i++) {
    value = (value << 8) | Data[i];
    bits += 8;
    while (bits >= 5 && j < OutSize - 1) {
      bits -= 5;
      Out[j++] = Base32Table[(value >> bits) & 0x1F];
    }
  }
  if (bits > 0 && j < OutSize - 1) {
    Out[j++] = Base32Table[(value << (5 - bits)) & 0x1F];
  }
  Out[j] = '\0';
  return j;
}

//
// Build a DNS tunnel query name from device data
// Format: <base32-encoded-data>.<domain>
//
static UINTN
BuildTunnelQueryName (
  IN  CONST CHAR8  *DeviceData,
  OUT CHAR8         *QueryName,
  IN  UINTN         QuerySize
  )
{
  UINTN  DataLen;
  UINTN  EncodedLen;
  UINTN  DomainLen;
  UINTN  TotalLen;

  if (DeviceData == NULL || QueryName == NULL || QuerySize == 0) {
    return 0;
  }

  DataLen = AsciiStrLen(DeviceData);
  DomainLen = AsciiStrLen(DNS_TUNNEL_DOMAIN);

  // Base32 encoding: 8 bytes → 13 chars (ratio ~1.625)
  // Max label: 63 chars → max 38 bytes per label
  // For simplicity, encode the whole device data as one label
  if (DataLen > 38) {
    DataLen = 38;  // Truncate to fit in one DNS label
  }

  EncodedLen = Base32Encode((CONST UINT8 *)DeviceData, DataLen, QueryName, QuerySize);
  if (EncodedLen == 0 || EncodedLen > 63) {
    return 0;
  }

  // Append ".<domain>"
  TotalLen = EncodedLen + 1 + DomainLen;
  if (TotalLen >= QuerySize) {
    return 0;
  }

  QueryName[EncodedLen] = '.';
  CopyMem(QueryName + EncodedLen + 1, DNS_TUNNEL_DOMAIN, DomainLen + 1);

  return TotalLen;
}

//
// Parse TXT record from DNS response
// The TXT record data is the base32-encoded server response
//
static EFI_STATUS
ParseTxtResponse (
  IN  EFI_DNS4_COMPLETION_TOKEN  *Token,
  OUT CHAR16                      *Response,
  IN  UINTN                       ResponseSize
  )
{
  DNS_GENERAL_LOOKUP_DATA  *LookupData;
  DNS_RESOURCE_RECORD      *RR;
  UINTN                    i;

  if (Token == NULL || Response == NULL || ResponseSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  Response[0] = L'\0';

  // Check if the DNS query completed successfully
  if (Token->Status != EFI_SUCCESS) {
    return Token->Status;
  }

  LookupData = Token->RspData.GLookupData;
  if (LookupData == NULL || LookupData->RRCount == 0 || LookupData->RRList == NULL) {
    return EFI_NOT_FOUND;
  }

  // Walk the resource records looking for TXT records
  for (i = 0; i < LookupData->RRCount; i++) {
    RR = &LookupData->RRList[i];

    if (RR->QType == DNS_TXT_RECORD_TYPE && RR->RData != NULL) {
      // Found a TXT record — extract the RData
      // RData for TXT records contains length-prefixed strings
      // The first byte is the length, followed by the string data
      UINT8  TxtLen = (UINT8)RR->RData[0];
      CHAR8  *TxtData = RR->RData + 1;
      UINTN  j;

      for (j = 0; j < TxtLen && j < ResponseSize - 1; j++) {
        Response[j] = (CHAR16)TxtData[j];
      }
      Response[j] = L'\0';

      return EFI_SUCCESS;
    }
  }

  return EFI_NOT_FOUND;
}

//
// DNS tunnel check-in
//
EFI_STATUS
DnsTunnelCheckIn (
  IN  CONST CHAR8  *DeviceData,
  OUT CHAR16        *Response,
  IN  UINTN         ResponseSize
  )
{
  EFI_STATUS                    Status;
  UINTN                         HandleCount;
  EFI_HANDLE                    *HandleBuffer;
  EFI_HANDLE                    DnsChildHandle;
  EFI_SERVICE_BINDING_PROTOCOL  *DnsServiceBinding;
  EFI_DNS4_PROTOCOL             *Dns4;
  EFI_DNS4_CONFIG_DATA          ConfigData;
  EFI_DNS4_COMPLETION_TOKEN     Token;
  EFI_EVENT                     TimeoutEvent;
  CHAR8                         QueryName[128];
  UINTN                         QueryLen;
  UINTN                         WaitIndex;

  if (Response == NULL || ResponseSize == 0) {
    return EFI_INVALID_PARAMETER;
  }

  Response[0] = L'\0';

  //
  // Step 1: Build the DNS tunnel query name
  //
  QueryLen = BuildTunnelQueryName(DeviceData, QueryName, sizeof(QueryName));
  if (QueryLen == 0) {
    Print(L"  [DNS] Failed to build query name\n");
    return EFI_INVALID_PARAMETER;
  }

  Print(L"  [DNS] Tunnel query: %a\n", QueryName);

  //
  // Step 2: Find DNS4 service binding
  //
  Status = gBS->LocateHandleBuffer(
    ByProtocol,
    &gEfiDns4ServiceBindingProtocolGuid,
    NULL,
    &HandleCount,
    &HandleBuffer
  );

  if (EFI_ERROR(Status) || HandleCount == 0) {
    Print(L"  [DNS] DNS4 service binding not found\n");
    return EFI_NOT_FOUND;
  }

  Status = gBS->HandleProtocol(
    HandleBuffer[0],
    &gEfiDns4ServiceBindingProtocolGuid,
    (VOID **)&DnsServiceBinding
  );
  if (EFI_ERROR(Status)) {
    FreePool(HandleBuffer);
    return Status;
  }

  //
  // Step 3: Create DNS4 child
  //
  DnsChildHandle = NULL;
  Status = DnsServiceBinding->CreateChild(DnsServiceBinding, &DnsChildHandle);
  if (EFI_ERROR(Status)) {
    Print(L"  [DNS] Failed to create DNS4 child: %r\n", Status);
    FreePool(HandleBuffer);
    return Status;
  }

  Status = gBS->HandleProtocol(
    DnsChildHandle,
    &gEfiDns4ProtocolGuid,
    (VOID **)&Dns4
  );
  if (EFI_ERROR(Status)) {
    Print(L"  [DNS] Failed to get DNS4 protocol: %r\n", Status);
    DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
    FreePool(HandleBuffer);
    return Status;
  }

  //
  // Step 4: Configure DNS4 (use DHCP for DNS server)
  //
  ZeroMem(&ConfigData, sizeof(ConfigData));
  ConfigData.UseDefaultSetting = TRUE;
  ConfigData.DnsServerListCount = 0;
  ConfigData.DnsServerList = NULL;

  Status = Dns4->Configure(Dns4, &ConfigData);
  if (EFI_ERROR(Status)) {
    Print(L"  [DNS] DNS4 configure failed: %r (DHCP may not be ready)\n", Status);
    DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
    FreePool(HandleBuffer);
    return Status;
  }

  Print(L"  [DNS] DNS4 configured (DHCP)\n");

  //
  // Step 5: Create completion token and send GeneralLookUp
  //
  ZeroMem(&Token, sizeof(Token));
  Status = gBS->CreateEvent(EVT_NOTIFY_SIGNAL, TPL_CALLBACK, NULL, NULL, &Token.Event);
  if (EFI_ERROR(Status)) {
    Dns4->Configure(Dns4, NULL);
    DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
    FreePool(HandleBuffer);
    return Status;
  }

  // Send TXT query
  Status = Dns4->GeneralLookUp(
    Dns4,
    QueryName,
    DNS_TXT_RECORD_TYPE,
    DNS_CLASS_IN,
    &Token
  );

  if (EFI_ERROR(Status)) {
    Print(L"  [DNS] GeneralLookUp failed: %r\n", Status);
    gBS->CloseEvent(Token.Event);
    Dns4->Configure(Dns4, NULL);
    DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
    FreePool(HandleBuffer);
    return Status;
  }

  Print(L"  [DNS] TXT query sent, waiting for response...\n");

  //
  // Step 6: Wait for response (with timeout)
  //
  Status = gBS->CreateEvent(EVT_TIMER, TPL_CALLBACK, NULL, NULL, &TimeoutEvent);
  if (EFI_ERROR(Status)) {
    gBS->CloseEvent(Token.Event);
    Dns4->Configure(Dns4, NULL);
    DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
    FreePool(HandleBuffer);
    return Status;
  }

  gBS->SetTimer(TimeoutEvent, TimerRelative, CHECKIN_TIMEOUT_MS * 10000);  // ms to 100ns units

  // Wait for either the DNS token event or the timeout
  EFI_EVENT  WaitEvents[2] = { Token.Event, TimeoutEvent };
  Status = gBS->WaitForEvent(2, WaitEvents, &WaitIndex);

  if (WaitIndex == 1) {
    // Timeout
    Print(L"  [DNS] Query timed out\n");
    Dns4->Cancel(Dns4, &Token);
    gBS->CloseEvent(Token.Event);
    gBS->CloseEvent(TimeoutEvent);
    Dns4->Configure(Dns4, NULL);
    DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
    FreePool(HandleBuffer);
    return EFI_TIMEOUT;
  }

  gBS->CloseEvent(TimeoutEvent);

  //
  // Step 7: Parse the TXT response
  //
  Status = ParseTxtResponse(&Token, Response, ResponseSize);
  if (EFI_ERROR(Status)) {
    Print(L"  [DNS] No TXT record in response: %r\n", Status);
    StrCpyS(Response, ResponseSize, L"DNS_NO_RESPONSE");
  } else {
    Print(L"  [DNS] Server response: %s\n", Response);
  }

  //
  // Cleanup
  //
  gBS->CloseEvent(Token.Event);
  Dns4->Configure(Dns4, NULL);
  DnsServiceBinding->DestroyChild(DnsServiceBinding, DnsChildHandle);
  FreePool(HandleBuffer);

  return EFI_SUCCESS;
}
