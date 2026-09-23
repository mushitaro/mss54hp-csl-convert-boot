/**
 * The one Web Crypto name `_owner-gate/gate.ts` uses that @cloudflare/workers-types does not
 * declare (it types key usages as plain strings). The gate is a byte-for-byte copy of the canonical
 * one and is not edited here, so the name is supplied from outside it instead. Types only — nothing
 * here reaches the runtime, and the root tsconfig (which has the DOM's own KeyUsage) never sees it.
 */
type KeyUsage = 'encrypt' | 'decrypt' | 'sign' | 'verify' | 'deriveKey' | 'deriveBits' | 'wrapKey' | 'unwrapKey';
