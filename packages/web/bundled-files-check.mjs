// Whether a build's output (or the public folder it is copied from) carries anything in the
// bundled folders beyond REQUIRED_BINARIES - see bundled-files.mjs for why that matters. Node only:
// the Vite plugin and scripts/deploy.mjs run it; the app never does.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BUNDLED_DIRS, REQUIRED_BINARIES } from './bundled-files.mjs';

/**
 * Each folder may also carry the operator's README.txt describing its files. It is allowed only
 * while it is what the name says - short text with no NUL byte - so a binary cannot ride under
 * that name either.
 */
const NOTE = 'README.txt';
const NOTE_MAX_BYTES = 16 * 1024;

/**
 * Everything under `root/{spdaten,program,bootloader}` that the list does not name, as one line
 * each. `root` is a build's output (dist) or the public folder it is copied from. An absent folder
 * is not a stray; whether the required files are present is a separate question.
 */
export function strayBundledFiles(root) {
    const allowed = new Set(REQUIRED_BINARIES);
    const strays = [];
    const walk = (rel) => {
        let entries;
        try {
            entries = readdirSync(join(root, rel), { withFileTypes: true });
        } catch (e) {
            if (e && e.code === 'ENOENT') return;
            throw e;
        }
        for (const entry of entries) {
            const p = `${rel}/${entry.name}`;
            if (entry.isDirectory()) { walk(p); continue; }
            if (allowed.has(p)) continue;
            if (entry.name === NOTE && !rel.includes('/')) {
                const abs = join(root, p);
                if (statSync(abs).size <= NOTE_MAX_BYTES && !readFileSync(abs).includes(0)) continue;
                strays.push(`${p} is not a short text note`);
                continue;
            }
            strays.push(`${p} is not a file the app carries`);
        }
    };
    for (const dir of BUNDLED_DIRS) walk(dir);
    return strays;
}
