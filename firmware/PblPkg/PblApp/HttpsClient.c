/** @file
  HttpsClient.c — Stub for C3 PblHttpsPost.

  Copyright (c) 2026 Remote Lockdown System. All rights reserved.
**/

#include "PblApp.h"

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
  (VOID)Uri;
  (VOID)Body;
  (VOID)BodyLen;
  (VOID)Resp;
  (VOID)RespLen;
  return EFI_UNSUPPORTED;
}
