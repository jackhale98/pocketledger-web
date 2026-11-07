// Input options every hledger invocation for a vault should get.
//
// The app runs hledger with --no-conf (a hledger.conf could change report
// shapes the decoders rely on), so it applies the safe parts itself:
// - --auto when the journal has auto-posting rules (`= QUERY` at column 0),
//   because hledger ignores those rules without it;
// - allow-listed general options from the vault's hledger.conf (the lines
//   before its first [command] section).

/** General hledger.conf options that only affect how the journal is read. */
const ALLOWED = new Set([
  '--auto',
  '--infer-market-prices',
  '--infer-costs',
  '--infer-equity',
  '-I',
  '--ignore-assertions',
  '-s',
  '--strict',
]);
/** Options taking a value (`--alias=OLD=NEW` or `--alias OLD=NEW`). */
const WITH_VALUE = new Set(['--alias', '--pivot-not-allowed']);

export const CONF_FILES = ['hledger.conf', '.hledger.conf'];
export const isConfFile = (path: string) => CONF_FILES.includes(path);

/** Split a conf line into words, honouring simple single/double quotes. */
function words(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (/\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** Allow-listed options from a hledger.conf's general section. */
export function confFlags(conf: string): string[] {
  const out: string[] = [];
  for (const raw of conf.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) break; // command sections follow
    const ws = words(line);
    for (let i = 0; i < ws.length; i++) {
      const w = ws[i]!;
      const [name, value] = w.includes('=') && w.startsWith('--') ? [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)] : [w, undefined];
      if (ALLOWED.has(name)) out.push(name);
      else if (name === '--alias') {
        const v = value ?? ws[++i];
        if (v) out.push(`--alias=${v}`);
      } else if (WITH_VALUE.has(name) && value === undefined) i++;
    }
  }
  return out;
}

/** Does any journal file contain an auto-posting rule? */
export const hasAutoRules = (files: Record<string, string>) =>
  Object.entries(files).some(([p, t]) => !p.endsWith('.csv') && !p.endsWith('.rules') && /^=[ \t]*\S/m.test(t));

export function journalFlags(files: Record<string, string>): string[] {
  const flags: string[] = [];
  for (const c of CONF_FILES) if (files[c] != null) flags.push(...confFlags(files[c]!));
  if (hasAutoRules(files) && !flags.includes('--auto')) flags.push('--auto');
  return [...new Set(flags)];
}
