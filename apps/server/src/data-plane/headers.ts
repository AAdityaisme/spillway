/**
 * Build the `x-spillway-dropped-params` header value with control characters (CR/LF/C0/DEL)
 * stripped from each param name. The names come from arbitrary client JSON keys
 * (zod .passthrough), so a hostile key like `"x\r\nX-Injected: 1"` would otherwise inject a
 * header or throw synchronously inside `writeHead`/`reply.headers` — on the streaming path that
 * throw escaped the tee and lost the whole reconcile (red-team ADR-034). No regex (avoids the
 * no-control-regex lint + never embeds literal control bytes in source).
 */
export function droppedParamsHeader(names: string[]): string {
  const safe: string[] = [];
  for (const name of names) {
    let clean = '';
    for (const ch of name) {
      const c = ch.charCodeAt(0);
      if (c > 0x1f && c !== 0x7f) clean += ch;
    }
    if (clean.length > 0) safe.push(clean);
  }
  return safe.join(',');
}
