/*
 * stderr capture for the hledger reactor.
 *
 * hledger writes to stderr two ways: through the Haskell `stderr` Handle
 * (error messages, via hPutStrLn) and through Debug.Trace (warnings, via
 * `warn`), which goes base:debugBelch2 -> RTS debugBelch -> *debugMsgFn and
 * never touches the Handle. Both are collected here, in one buffer, in the
 * order they happen: the Haskell side's stderr Handle is unbuffered and
 * appends through hledger_err_append, and debugMsgFn is pointed at
 * capture_debug_msg while a call is running.
 */
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "Rts.h"

static char *buf = NULL;
static size_t len = 0;
static size_t cap = 0;
static RtsMsgFunctionRetLen *saved = NULL;

static int reserve(size_t extra)
{
  if (len + extra + 1 <= cap) return 1;
  size_t ncap = cap ? cap : 4096;
  while (ncap < len + extra + 1) ncap *= 2;
  char *n = realloc(buf, ncap);
  if (!n) return 0;
  buf = n;
  cap = ncap;
  return 1;
}

void hledger_err_append(const char *p, size_t n)
{
  if (n == 0 || !reserve(n)) return;
  memcpy(buf + len, p, n);
  len += n;
}

static int capture_debug_msg(const char *fmt, va_list ap)
{
  va_list ap2;
  va_copy(ap2, ap);
  int n = vsnprintf(NULL, 0, fmt, ap2);
  va_end(ap2);
  if (n <= 0 || !reserve((size_t)n)) return n;
  vsnprintf(buf + len, (size_t)n + 1, fmt, ap);
  len += (size_t)n;
  return n;
}

void hledger_capture_begin(void)
{
  len = 0;
  if (debugMsgFn != capture_debug_msg) {
    saved = debugMsgFn;
    debugMsgFn = capture_debug_msg;
  }
}

void hledger_capture_end(void)
{
  if (debugMsgFn == capture_debug_msg && saved) debugMsgFn = saved;
}

const char *hledger_err_ptr(void) { return buf ? buf : ""; }
size_t hledger_err_len(void) { return len; }
