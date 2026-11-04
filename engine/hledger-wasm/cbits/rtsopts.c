/*
 * RTS defaults for the hledger reactor.
 *
 * A reactor is started with hs_init(), which uses defaultRtsConfig and never
 * sees -with-rtsopts (that only reaches hs_main). The RTS calls
 * FlagDefaultsHook() before reading any flags, and this definition replaces
 * the empty one in libHSrts (rts/hooks/FlagDefaults.c), so it is the place to
 * set GC defaults.
 *
 * HLEDGER_RTS_A_MB in the WASI environment overrides the nursery size (MiB),
 * for tuning; 0 keeps the RTS default.
 */
#include <stdlib.h>

#include "Rts.h"

#ifndef HLEDGER_DEFAULT_A_MB
#define HLEDGER_DEFAULT_A_MB 0
#endif

void FlagDefaultsHook(void)
{
  long mb = HLEDGER_DEFAULT_A_MB;
  const char *e = getenv("HLEDGER_RTS_A_MB");
  if (e && *e) mb = strtol(e, NULL, 10);
  if (mb > 0)
    RtsFlags.GcFlags.minAllocAreaSize = (uint32_t)((mb * 1024 * 1024) / BLOCK_SIZE);
  /* hledger's `stats` reports RTS statistics when they are enabled (-T). */
  RtsFlags.GcFlags.giveStats = COLLECT_GC_STATS;
}
