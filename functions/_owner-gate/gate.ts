// The owner gate — the whole-origin guard in front of a preview app.
//
// CANONICAL COPY. This file lives in tsunagi-m3/tools/owner-gate/server/ and is
// copied, byte for byte, into each preview app as functions/_owner-gate/gate.ts.
// The app's `gate:verify` script fails when its copy differs. Change it here,
// run the tests here (node --test tools/owner-gate/test/), then copy it out.
//
// What it does, in one sentence: nothing on this origin is served to a browser
// that m3 has not confirmed holds `owner_preview` — except the web app manifest
// and its icons, which browsers fetch without cookies, and the gate's own
// /_gate/* routes.
//
//   first visit ─→ 302 m3 /api/access/authorize (state + PKCE, sealed tx cookie)
//   m3 ─→ /_gate/callback?code&state ─→ POST m3 /api/access/token (client secret
//        + verifier) ─→ __Host-owner cookie ─→ 302 back to where they were going
//   every request ─→ POST m3 /api/access/introspect (≤60 s cache) ─→ next()
//
// The rules it keeps, each for a reason written where it is kept:
//   - non-canonical hosts (deployment hashes, branch aliases) answer 404;
//   - a navigation without a session is sent to authorize; anything else gets
//     401 JSON — never a login page a service worker could cache as the app;
//   - m3 unreachable, rate-limited or erroring → 503, never "let it through";
//   - any exception → 503; passThroughOnException is never used, because Pages
//     implements it by serving the asset;
//   - state-changing /api/* requests must come from this origin;
//   - responses that pass are re-marked private: nothing shared may cache them.
//
// Deployment: the Pages project must be set to FAIL CLOSED (Settings → Runtime,
// or the API's deployment_configs.*.fail_open = false). When the daily Functions
// quota runs out this code does not run at all, and a fail-open project would
// then serve every asset to anyone.
//
// No imports and no runtime types from @cloudflare/workers-types, so the same
// bytes compile in every app whatever its tsconfig.

export interface GateConfig {
  /** access_clients.id on m3, e.g. 'tuner-preview'. */
  clientId: string;
  /** The one host this app answers on, e.g. 'mss54hp-csl-convert-tuner-preview.pages.dev'. */
  canonicalHost: string;
  /** What the denied page calls the app. */
  name: string;
  /** Paths served without a session: the manifest and the icons it names. */
  publicPaths: readonly string[];
  /** Browser-facing m3 (authorize). Default https://m3.tsunagi.app. */
  m3Browser?: string;
  /** Server-to-server m3 (token, introspect) — resolved inside Cloudflare. Default https://tsunagi-m3.pages.dev. */
  m3Server?: string;
}

export interface GateEnv {
  M3_CLIENT_SECRET?: string;
  /** Local development only: an account id the gate pretends is signed in. Ignored on any non-localhost host. */
  GATE_DEV_ACCOUNT?: string;
  /** Local development only: point at a local m3 (e.g. http://localhost:8790). Ignored off localhost. */
  GATE_DEV_M3?: string;
}

export interface GateContext {
  request: Request;
  env: GateEnv;
  next: () => Promise<Response>;
  data: Record<string, unknown>;
}

/** What the SYNC handlers read: context.data.owner. */
export interface GateOwner {
  id: string;
  label: string;
}

/** Test seam: the fetch used to reach m3 and the cache used for introspection. */
export interface GateDeps {
  fetch?: typeof fetch;
  cache?: { match(key: string): Promise<Response | undefined>; put(key: string, res: Response): Promise<void> } | null;
  now?: () => number;
}

export const SESSION_COOKIE = '__Host-owner';
const REFRESH_COOKIE = '__Host-owner_r';
const TX_PREFIX = '__Host-owner_tx_';
const SESSION_MAX_AGE = 180 * 86_400;
const TX_MAX_AGE = 600;
const INTROSPECT_TTL_MS = 60_000;
const MAX_TX = 3;

const enc = new TextEncoder();
const dec = new TextDecoder();

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const fromB64url = (s: string): Uint8Array =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function random(n: number): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b64url(b);
}

async function sha256(s: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s))));
}

async function hkdf(secret: string, info: string, algo: 'AES-GCM' | 'HMAC', usage: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('tsunagi-owner-gate'), info: enc.encode(info) },
    base,
    algo === 'HMAC' ? { name: 'HMAC', hash: 'SHA-256', length: 256 } : { name: 'AES-GCM', length: 256 },
    false,
    usage
  );
}

// ── cookies ────────────────────────────────────────────────────────────────

function readCookies(req: Request): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return out;
}

const cookie = (name: string, value: string, maxAge: number) =>
  `${name}=${value}; Max-Age=${maxAge}; Path=/; Secure; HttpOnly; SameSite=Lax`;
const clear = (name: string) => `${name}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;

// ── the sealed transaction cookie ────────────────────────────────────────────

interface Tx {
  id: string;
  state: string;
  verifier: string;
  ret: string;
  iat: number;
}

async function seal(secret: string, name: string, host: string, tx: Tx): Promise<string> {
  const key = await hkdf(secret, 'tx', 'AES-GCM', ['encrypt']);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(`${name}|${host}`) }, key, enc.encode(JSON.stringify(tx)))
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(iv);
  out.set(ct, 12);
  return b64url(out);
}

async function open(secret: string, name: string, host: string, sealed: string): Promise<Tx | null> {
  try {
    const bytes = fromB64url(sealed);
    if (bytes.length <= 12) return null;
    const key = await hkdf(secret, 'tx', 'AES-GCM', ['decrypt']);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: enc.encode(`${name}|${host}`) },
      key,
      bytes.slice(12)
    );
    const tx = JSON.parse(dec.decode(pt)) as Tx;
    return typeof tx.state === 'string' && typeof tx.verifier === 'string' && typeof tx.ret === 'string' ? tx : null;
  } catch {
    return null;
  }
}

// ── small responses ──────────────────────────────────────────────────────────

const NO_STORE = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' };

function jsonRes(body: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE, 'content-type': 'application/json; charset=utf-8', ...extra },
  });
}

function redirect(location: string, cookies: string[] = []): Response {
  const h = new Headers({ ...NO_STORE, location, 'referrer-policy': 'no-referrer' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 302, headers: h });
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A plain page from the gate itself. Japanese or English by Accept-Language. */
function page(req: Request, status: number, ja: { title: string; body: string[] }, en: { title: string; body: string[] }, cookies: string[] = []): Response {
  const isJa = (req.headers.get('accept-language') ?? 'ja').toLowerCase().startsWith('ja');
  const t = isJa ? ja : en;
  const html = `<!doctype html><html lang="${isJa ? 'ja' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(t.title)}</title><style>body{margin:0;background:#000;color:#e8e6e3;font:15px/1.8 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:560px;margin:0 auto;padding:64px 20px}h1{font-size:18px;letter-spacing:.04em;margin:0 0 20px}p{margin:0 0 14px}a{color:#e8e6e3}</style></head><body><main><h1>${esc(t.title)}</h1>${t.body.map((p) => `<p>${p}</p>`).join('')}</main></body></html>`;
  const h = new Headers({ ...NO_STORE, 'content-type': 'text/html; charset=utf-8', 'referrer-policy': 'no-referrer' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(html, { status, headers: h });
}

// ── the gate ─────────────────────────────────────────────────────────────────

type Session = { owner: GateOwner } | null | 'error';

export function createGate(config: GateConfig, deps: GateDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const doFetch = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const memo = new Map<string, { owner: GateOwner; exp: number }>();
  const publicPaths = new Set(config.publicPaths);

  const cacheFor = () => {
    if (deps.cache !== undefined) return deps.cache;
    const c = (globalThis as { caches?: { default?: GateDeps['cache'] } }).caches?.default;
    return c ?? null;
  };

  return async function onRequest(ctx: GateContext): Promise<Response> {
    try {
      return await handle(ctx);
    } catch (e) {
      console.error('owner gate failed:', e instanceof Error ? e.name : typeof e);
      return jsonRes({ error: 'unavailable' }, 503);
    }
  };

  async function handle(ctx: GateContext): Promise<Response> {
    const { request, env } = ctx;
    const url = new URL(request.url);
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';

    // A deployment hash or a branch alias is not this app. 404, and no cookie
    // is ever set on those hosts.
    if (!local && url.host !== config.canonicalHost) return new Response('Not found', { status: 404, headers: NO_STORE });

    const secret = env.M3_CLIENT_SECRET;
    if (!secret || secret.length < 32) return jsonRes({ error: 'unavailable' }, 503);

    const origin = local ? url.origin : `https://${config.canonicalHost}`;
    const m3Browser = (local && env.GATE_DEV_M3) || config.m3Browser || 'https://m3.tsunagi.app';
    const m3Server = (local && env.GATE_DEV_M3) || config.m3Server || 'https://tsunagi-m3.pages.dev';
    const callback = `${origin}/_gate/callback`;
    const path = url.pathname;

    // ── the gate's own routes ──────────────────────────────────────────────
    if (path === '/_gate/start') return start(request, secret, url.host, origin, m3Browser, callback, safeReturn(url.searchParams.get('return')));
    if (path === '/_gate/callback') return finish(ctx, secret, url, m3Server, callback);
    if (path === '/_gate/status') {
      const s = await resolve(ctx, secret, local, m3Server);
      if (s === 'error') return jsonRes({ state: 'unknown' }, 200);
      return jsonRes(s ? { state: 'active', account_label: s.owner.label } : { state: 'expired' }, 200);
    }
    if (path === '/_gate/denied') return denied(request);
    if (path.startsWith('/_gate/')) return new Response('Not found', { status: 404, headers: NO_STORE });

    // ── what browsers fetch without cookies ────────────────────────────────
    if ((request.method === 'GET' || request.method === 'HEAD') && publicPaths.has(path)) return ctx.next();

    // ── everything else needs a session ────────────────────────────────────
    const s = await resolve(ctx, secret, local, m3Server);
    if (s === 'error') return jsonRes({ error: 'unavailable' }, 503);
    if (!s) {
      if (isNavigation(request)) return start(request, secret, url.host, origin, m3Browser, callback, safeReturn(path + url.search));
      return jsonRes({ error: 'unauthorized' }, 401);
    }

    // Writes to the app's API only from the app's own pages. SameSite=Lax is
    // not enough on its own: a deployment hash is same-site with this host.
    if (path.startsWith('/api/') && request.method !== 'GET' && request.method !== 'HEAD') {
      const from = request.headers.get('origin');
      if (from !== origin) return jsonRes({ error: 'bad_origin' }, 403);
    }

    ctx.data.owner = s.owner;
    const res = await ctx.next();
    const out = new Response(res.body, res);
    out.headers.set('cache-control', privateCaching(res, path));
    // Keep the cookie as long-lived as the session it carries: re-issued on a
    // page load at most once a day, never on every asset.
    if (isNavigation(request)) {
      const cookies = readCookies(request);
      const last = Number(cookies.get(REFRESH_COOKIE) ?? 0);
      const token = cookies.get(SESSION_COOKIE);
      if (token && now() - last > 86_400_000) {
        out.headers.append('set-cookie', cookie(SESSION_COOKIE, token, SESSION_MAX_AGE));
        out.headers.append('set-cookie', cookie(REFRESH_COOKIE, String(now()), SESSION_MAX_AGE));
      }
    }
    return out;
  }

  /** Who is this — from the cookie, through m3, cached for up to a minute. */
  async function resolve(ctx: GateContext, secret: string, local: boolean, m3Server: string): Promise<Session> {
    if (local && ctx.env.GATE_DEV_ACCOUNT) return { owner: { id: ctx.env.GATE_DEV_ACCOUNT, label: '#DEV0' } };

    const token = readCookies(ctx.request).get(SESSION_COOKIE);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;

    const t = now();
    const hit = memo.get(token);
    if (hit && hit.exp > t) return { owner: hit.owner };

    // The cache key is an HMAC of the token under a key only this app holds:
    // nobody without the secret can compute it, target it, or read it back.
    const hkey = await hkdf(secret, 'introspect-cache', 'HMAC', ['sign']);
    const keyId = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', hkey, enc.encode(token))));
    const cacheKey = `https://${config.canonicalHost}/_gate/cache/${keyId}`;
    const cache = cacheFor();
    if (cache) {
      const cached = await cache.match(cacheKey).catch(() => undefined);
      if (cached) {
        const v = (await cached.json().catch(() => null)) as { owner?: GateOwner; exp?: number } | null;
        if (v?.owner && typeof v.exp === 'number' && v.exp > t) {
          memo.set(token, { owner: v.owner, exp: v.exp });
          return { owner: v.owner };
        }
      }
    }

    let res: Response;
    try {
      res = await doFetch(`${m3Server}/api/access/introspect`, {
        method: 'POST',
        headers: { authorization: basic(config.clientId, secret), 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch {
      return 'error';
    }
    if (res.status !== 200) return 'error';
    const body = (await res.json().catch(() => null)) as {
      active?: boolean;
      account_id?: string;
      account_label?: string;
      scopes?: string[];
    } | null;
    if (!body || typeof body.active !== 'boolean') return 'error';
    // Inactive, or active without the right: treated alike, and never cached,
    // so a right granted a moment ago works on the next request.
    if (!body.active || !body.account_id || !(body.scopes ?? []).includes('owner_preview')) return null;

    const owner: GateOwner = { id: body.account_id, label: body.account_label ?? '' };
    const exp = t + INTROSPECT_TTL_MS;
    if (memo.size > 500) memo.clear();
    memo.set(token, { owner, exp });
    if (cache) {
      await cache
        .put(cacheKey, new Response(JSON.stringify({ owner, exp }), { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } }))
        .catch(() => {});
    }
    return { owner };
  }

  /** Begin a round trip to m3: a fresh state and verifier, sealed in a cookie of their own. */
  async function start(
    request: Request,
    secret: string,
    host: string,
    origin: string,
    m3Browser: string,
    callback: string,
    ret: string
  ): Promise<Response> {
    const cookies: string[] = [];
    // At most MAX_TX transactions in flight per browser: the oldest go first,
    // so repeated launches cannot grow the Cookie header without bound.
    const txs: { name: string; iat: number }[] = [];
    for (const [name, value] of readCookies(request)) {
      if (!name.startsWith(TX_PREFIX)) continue;
      const tx = await open(secret, name, host, value);
      txs.push({ name, iat: tx?.iat ?? 0 });
    }
    txs.sort((a, b) => b.iat - a.iat);
    for (const old of txs.slice(MAX_TX - 1)) cookies.push(clear(old.name));

    const tx: Tx = { id: random(6), state: random(32), verifier: random(32), ret, iat: now() };
    const name = TX_PREFIX + tx.id;
    cookies.push(cookie(name, await seal(secret, name, host, tx), TX_MAX_AGE));

    const q = new URLSearchParams({
      response_type: 'code',
      client_id: config.clientId,
      redirect_uri: callback,
      state: tx.state,
      code_challenge: await sha256(tx.verifier),
      code_challenge_method: 'S256',
      scope: 'owner_preview',
    });
    return redirect(`${m3Browser}/api/access/authorize?${q}`, cookies);
  }

  /** Back from m3: match the state to a sealed transaction, exchange the code, set the session. */
  async function finish(ctx: GateContext, secret: string, url: URL, m3Server: string, callback: string): Promise<Response> {
    const { request } = ctx;
    const state = url.searchParams.get('state') ?? '';
    const cookies = readCookies(request);

    let found: { name: string; tx: Tx } | null = null;
    for (const [name, value] of cookies) {
      if (!name.startsWith(TX_PREFIX)) continue;
      const tx = await open(secret, name, url.host, value);
      if (tx && tx.state === state && now() - tx.iat <= TX_MAX_AGE * 1000) {
        found = { name, tx };
        break;
      }
    }
    const spent = found ? [clear(found.name)] : [];

    if (url.searchParams.get('error') === 'access_denied') return redirect('/_gate/denied', spent);

    // No matching transaction: this callback was not started by this browser,
    // or it is a second load of one that already finished. If a working
    // session is already here, just go on; otherwise say so — never restart
    // automatically, which could loop.
    const code = url.searchParams.get('code') ?? '';
    if (!found || !/^[A-Za-z0-9_-]{43}$/.test(code)) {
      const s = await resolve(ctx, secret, false, m3Server);
      if (s && s !== 'error') return redirect(found?.tx.ret ?? '/', spent);
      return retryPage(request, spent);
    }

    let res: Response;
    try {
      res = await doFetch(`${m3Server}/api/access/token`, {
        method: 'POST',
        headers: { authorization: basic(config.clientId, secret), 'content-type': 'application/json' },
        body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: found.tx.verifier, redirect_uri: callback }),
      });
    } catch {
      return jsonRes({ error: 'unavailable' }, 503);
    }
    if (res.status === 400 || res.status === 401) {
      const s = await resolve(ctx, secret, false, m3Server);
      if (s && s !== 'error') return redirect(found.tx.ret, spent);
      return retryPage(request, spent);
    }
    if (res.status !== 200) return jsonRes({ error: 'unavailable' }, 503);
    const body = (await res.json().catch(() => null)) as { access_token?: string } | null;
    if (!body?.access_token || !/^[A-Za-z0-9_-]{43}$/.test(body.access_token)) return jsonRes({ error: 'unavailable' }, 503);

    return redirect(found.tx.ret, [
      ...spent,
      cookie(SESSION_COOKIE, body.access_token, SESSION_MAX_AGE),
      cookie(REFRESH_COOKIE, String(now()), SESSION_MAX_AGE),
    ]);
  }

  function retryPage(request: Request, cookies: string[]): Response {
    return page(
      request,
      400,
      {
        title: config.name,
        body: [
          '確認に時間がかかったため、もう一度開き直してください。',
          `<a href="/_gate/start?return=%2F">${esc(config.name)} を開く</a>`,
        ],
      },
      {
        title: config.name,
        body: ['That took too long to confirm. Please open it again.', `<a href="/_gate/start?return=%2F">Open ${esc(config.name)}</a>`],
      },
      cookies
    );
  }

  function denied(request: Request): Response {
    return page(
      request,
      403,
      {
        title: config.name,
        body: [
          'このプレビュー版は、MILE をご購入いただいた方と、施工をご依頼いただいたオーナーさんにお使いいただいています。',
          'ご購入済みの方は、<a href="https://m3.tsunagi.app/restore">この端末で使えるように</a>してから開き直してください。',
          '<a href="https://m3.tsunagi.app/mesh">MILE について</a>',
        ],
      },
      {
        title: config.name,
        body: [
          'This preview is for those who have bought MILE and for owners whose cars we have worked on.',
          'If you have bought MILE, <a href="https://m3.tsunagi.app/restore?lang=en">set this device up</a> and open it again.',
          '<a href="https://m3.tsunagi.app/en/mesh">About MILE</a>',
        ],
      }
    );
  }
}

// ── helpers with no state ────────────────────────────────────────────────────

function basic(id: string, secret: string): string {
  return 'Basic ' + btoa(`${id}:${secret}`);
}

/**
 * A place on this site to come back to, or '/'.
 * One leading slash, not two, no backslash, not the gate's own routes — so the
 * value can never name another host, however it is encoded.
 */
export function safeReturn(raw: string | null): string {
  if (!raw || raw.length > 1000) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  try {
    const u = new URL(raw, 'https://gate.invalid');
    if (u.origin !== 'https://gate.invalid' || u.pathname.startsWith('/_gate/')) return '/';
    return u.pathname + u.search;
  } catch {
    return '/';
  }
}

/** A top-level page load — the one kind of request that may be redirected to m3. */
export function isNavigation(req: Request): boolean {
  if (req.method !== 'GET') return false;
  const mode = req.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate';
  // Older browsers without Fetch Metadata: a document request asks for HTML.
  return (req.headers.get('accept') ?? '').includes('text/html');
}

/**
 * The Cache-Control a passed response leaves with. Nothing a shared cache may
 * keep: `public` becomes `private`; documents, the service worker and the
 * manifest must be revalidated every time.
 */
export function privateCaching(res: Response, path: string): string {
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html') || path === '/sw.js' || path.endsWith('.webmanifest')) return 'private, no-cache';
  const cc = res.headers.get('cache-control');
  if (!cc) return 'private, no-cache';
  return cc.replace(/\bpublic\b/gi, 'private').replace(/\bs-maxage=\d+\s*,?\s*/gi, '');
}
