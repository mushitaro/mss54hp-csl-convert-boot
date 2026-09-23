/**
 * The bundled folders serve REQUIRED_BINARIES and nothing else. They are git-ignored, so this check
 * is the only thing that sees a real ECU dump dropped beside BMW's files before it ships.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { REQUIRED_BINARIES, bundledNames } from '../bundled-files.mjs';
import { strayBundledFiles } from '../bundled-files-check.mjs';

let root: string;
const put = (rel: string, bytes: Uint8Array | string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), bytes);
};

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'bundled-'));
    for (const f of REQUIRED_BINARIES) put(f, new Uint8Array([0, 1, 2]));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('the bundled folders', () => {
    it('pass with exactly the listed files, a text note each, and other folders untouched', () => {
        put('program/README.txt', 'what these are\n');
        put('icons/anything.png', new Uint8Array([0]));
        expect(strayBundledFiles(root)).toEqual([]);
    });

    it('refuse a stray dump, whatever it is called and however deep', () => {
        put('program/my-car-full-read.bin', new Uint8Array(1024 * 1024));
        put('spdaten/old/7837340A.0PA', new Uint8Array([0]));
        put('bootloader/csl-sa1.bin', new Uint8Array([0]));
        expect(strayBundledFiles(root).sort()).toEqual([
            'bootloader/csl-sa1.bin is not a file the app carries',
            'program/my-car-full-read.bin is not a file the app carries',
            'spdaten/old/7837340A.0PA is not a file the app carries',
        ]);
    });

    it('refuse a binary under the note\'s name', () => {
        put('program/README.txt', new Uint8Array([0x5a, 0x00, 0xff]));
        expect(strayBundledFiles(root)).toEqual(['program/README.txt is not a short text note']);
    });

    it('treat an absent folder as nothing to refuse', () => {
        rmSync(join(root, 'bootloader'), { recursive: true });
        expect(strayBundledFiles(root)).toEqual([]);
    });

    it('give the app one program and one bootloader, and the seven SP-DATEN files', () => {
        expect(bundledNames('spdaten')).toHaveLength(7);
        expect(bundledNames('program')).toEqual(['211325000401PD31_Community_Patch_v1.bin']);
        expect(bundledNames('bootloader')).toEqual(['csl-sa0.bin']);
    });
});
