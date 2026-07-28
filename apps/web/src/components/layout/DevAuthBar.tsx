import { useState } from 'react';
import { useAuth } from '../../lib/auth.js';
import { Button } from '../primitives/Button.js';

/** Basic sanity checks to avoid persisting obviously-wrong values (L56). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isJwt = (v: string): boolean => v.split('.').length === 3;

/**
 * Dev auth seam (WorkOS AuthKit hosted login replaces this at M4-auth). Paste the JWT +
 * org id printed by `pnpm dev:token`. Renders only when no session exists — once connected
 * it collapses to a thin status strip.
 */
export function DevAuthBar() {
  const { session, activeOrgId, setDevToken, setActiveOrg, signOut } = useAuth();
  const [tok, setTok] = useState('');
  const [org, setOrg] = useState(activeOrgId ?? '');
  const [validationErr, setValidationErr] = useState<string | null>(null);

  if (session) {
    return (
      <div className="flex items-center gap-3 border-b border-[var(--line)] bg-[var(--paper-warm)] px-4 py-1.5 font-mono text-[11px] text-[var(--ink-mut)]">
        <span className="flex items-center gap-1.5 whitespace-nowrap text-[var(--pass)]">
          <span className="live-dot" aria-hidden />
          dev session
        </span>
        <span className="num hidden min-w-0 truncate sm:inline">org: {activeOrgId ?? '—'}</span>
        <button
          className="focus-ring ml-auto whitespace-nowrap underline hover:text-[var(--ink)]"
          onClick={signOut}
        >
          sign out
        </button>
      </div>
    );
  }

  const handleConnect = (): void => {
    // L56: validate before persisting so a bad value doesn't 400 every request indefinitely.
    const t = tok.trim();
    const o = org.trim();
    if (t && !isJwt(t)) {
      setValidationErr('JWT must have three dot-separated segments');
      return;
    }
    if (o && !UUID_RE.test(o)) {
      setValidationErr('Org id must be a UUID (xxxxxxxx-xxxx-…)');
      return;
    }
    setValidationErr(null);
    if (t) setDevToken(t);
    if (o) setActiveOrg(o);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[var(--line)] bg-[var(--paper-warm)] px-4 py-2 text-xs">
      <span className="font-mono text-[11px] text-[var(--amber)]">
        dev auth (WorkOS login pending):
      </span>
      <input
        aria-label="Dev JWT"
        className="focus-ring w-56 rounded-[var(--radius-btn)] bg-[var(--card)] px-2 py-1 font-mono text-[11px] shadow-[inset_0_0_0_1px_var(--line)]"
        placeholder="paste JWT"
        value={tok}
        onChange={(e) => setTok(e.target.value)}
      />
      <input
        aria-label="Org id"
        className="focus-ring w-56 rounded-[var(--radius-btn)] bg-[var(--card)] px-2 py-1 font-mono text-[11px] shadow-[inset_0_0_0_1px_var(--line)]"
        placeholder="org id (UUID)"
        value={org}
        onChange={(e) => setOrg(e.target.value)}
      />
      <Button size="sm" onClick={handleConnect}>
        connect
      </Button>
      {validationErr ? <span className="text-[var(--danger)]">{validationErr}</span> : null}
    </div>
  );
}
