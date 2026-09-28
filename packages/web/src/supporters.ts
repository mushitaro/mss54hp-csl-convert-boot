// The supporters an app's CREDITS name — read back from the page itself.
//
// Canonical copy: tsunagi-m3/tools/credits/client/supporters.ts. Each app
// carries a byte-identical copy.
//
// The list was written into the built HTML by scripts/inject-supporters.mjs,
// so reading it costs no request: it is already in the document. Null when
// the block is not there (a dev server, a build made with M_SUPPORTERS=off) or
// is not the shape it should be — the dialog then shows only the MESH line.
//
// Call it when the dialog opens, never during server rendering: the block is
// in the document, not in the bundle.

export interface Supporters {
  /** Names, most MILE on this app's line first. Never a figure. */
  names: string[];
  /** Whether anyone who backed it chose not to be named. */
  others: boolean;
  /** YYYY-MM-DD (Japan) — when this build read the list. */
  asOf: string;
}

export function readSupporters(): Supporters | null {
  if (typeof document === 'undefined') return null;
  const el = document.getElementById('m-supporters');
  if (!el?.textContent) return null;
  try {
    const d = JSON.parse(el.textContent) as Partial<Supporters> & { v?: number };
    if (d.v !== 1 || !Array.isArray(d.names) || typeof d.others !== 'boolean' || typeof d.asOf !== 'string') return null;
    const names = d.names.filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
    return { names, others: d.others, asOf: d.asOf };
  } catch {
    return null;
  }
}
