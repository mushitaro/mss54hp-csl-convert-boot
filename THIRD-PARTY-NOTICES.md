# Third-party notices and data provenance

This file records what this project depends on, what it is derived from, and which of
those things are in this repository, which are served by the WORKS build, and which never
leave the developer's machine.

**This is a record of facts, not legal advice.** The provenance questions in §3 are
judgement calls that were made deliberately, and they are written down so they are not
inherited by accident.

The code in this repository is MIT (`LICENSE`, Copyright (c) 2026 TSUNAGI). That licence
covers the code. It does not cover, and cannot relicense, anything in §2.

---

## 1. Dependencies

### 1.1 Shipped in the app

| Package | License |
|---|---|
| react, react-dom | MIT |
| lucide-react | ISC |

Exact versions are in `package.json` and `package-lock.json`.

### 1.2 Build and test only (not shipped)

vite, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite, vitest, eslint,
typescript-eslint, eslint-plugin-react-hooks (MIT); typescript (Apache-2.0). Wrangler is
run through `npx` for local development and deployment and is not a dependency.

### 1.3 What the app talks to

The cable, over WebUSB. In the WORKS build, also its own origin: `/_gate/status` (is the
owner still signed in) and `/api/runs` / `/api/diagnostics` (the owner's saved sessions and
error records). Nothing goes to a third party. The production build makes no request to
any API at all.

---

## 2. Not in this repository

`.gitignore` excludes all of the following, and `scripts/check-public-tree.mjs` (run by
the pre-commit hook) refuses a commit that tracks any `.bin`, `.0pa`, `.0da` file or
anything that looks like a real VIN.

Because git does not see these three folders, the build does instead: they may hold exactly
the files `REQUIRED_BINARIES` names (`packages/web/bundled-files.mjs`) plus a short
`README.txt` each, and the build (and `npm run deploy`) fails on anything else in them - so a
real ECU dump left in `public/program/` never ships to anyone.

### 2.1 BMW SP-DATEN — `packages/web/public/spdaten/`

`7837340A.0PA` (the CSL program, 0401) and the six CSL calibrations `A7837329.0DA`,
`A7837331.0DA`, `A7837333.0DA`, `A7837335.0DA`, `A7837337.0DA`, `A7837339.0DA`, copied
verbatim from BMW's SP-DATEN E46 v74 package (`data/MSS54/`).

These are BMW's proprietary files and are not ours to publish. The app needs them for the
program stage, and they are bundled unmodified - not repacked - so that what the app writes
is provably the bytes the test suite checks against genuine factory dumps.

**To supply them:** copy the seven files from your own SP-DATEN E46 package into
`packages/web/public/spdaten/`. Their names are read from each file's header at run time;
the list above is for a human.

### 2.2 The CSL bootloader — `packages/web/public/bootloader/csl-sa0.bin`

32 KiB: the master SA0 (`0x0000-0x3FFF`) followed by the slave SA0, as BMW shipped it on
the CSL. Only SA0 - never SA1, which holds a car's VIN, AIF and flash counter. It is
byte-identical in every genuine CSL dump and in the Community Patch v1 image, and it is
reproduced byte for byte by applying the known edits to a standard-M3 SA0
(`docs/bootloader-replacement.md`).

It is BMW's code, so it is not in this repository.

**To supply it:** take a genuine 1 MiB CSL (21132500) image and concatenate
`extractSa0(image, 'master')` and `extractSa0(image, 'slave')` from
`packages/dme-flash/src/bootloaderImage.ts`. `bootloaderReference.test.ts` checks the
result against whatever genuine images you also have in `data/`.

### 2.3 The Community Patch program — `packages/web/public/program/211325000401PD31_Community_Patch_v1.bin`

The MSS54HP CSL 0401 Community Patch v1, 21132500 build, a 1 MiB image as the community
distributes it. It is BMW's program with the community's edits, and neither party's to
relicense here. The app does not trust it on arrival: it diffs the file against the factory
`.0PA` and requires exactly the eight spans (and their CRCs) listed in
`packages/dme-flash/src/programVariant.ts`.

**To supply it:** place your copy under that name. When the patch is published by its
authors, that publication is the source to take it from.

### 2.4 Test images — `data/`

Genuine CSL ECU dumps and the Community Patch images, used by tests that compare this
project's derivations against real hardware. A full ECU image carries the service block of
the car it came from - VIN, AIF, flash counter - so these are never published, whatever
their provenance.

**Without them the tests that need them skip** (`it.skip`, reported as skipped), and the
rest run. A fresh clone runs green; it runs *more* with the files present. Some tests also
read a local SP-DATEN folder or a disassembly image outside the repository, by path or by
environment variable (`CSL_0401_BIN`, `CP_V1_BIN`), and skip the same way.

### 2.5 Real sessions

Captures and logs from real cars are uploaded by their owners to the WORKS build's database
(Cloudflare D1), filed under the owner's m3 account and readable only by that account. None
of it is, or ever will be, in this repository.

---

## 3. What is committed and is derived from BMW's data

- `packages/dme-flash/src/regionTable.generated.ts` - the DME's table of flash windows
  (addresses, lengths, flags), generated from a program image by
  `tools/analysis/gen_region_table.py`.
- `packages/dme-flash/src/programVariant.ts`, `bootloaderImage.ts`, `variant.ts` and their
  tests - offsets, lengths, CRCs and the handful of byte values that distinguish one BMW
  build from another.
- `docs/` - what was measured, and where.

These are facts about a piece of hardware and its firmware - where a table sits, what a
byte means, what a checksum covers - rather than the firmware itself. That is an argument,
not a ruling, and it is recorded here as an argument. No BMW file, and no contiguous piece
of one beyond what a fact needs, is committed.

---

## 4. Other projects this one learned from

- **CSL 0401 disassembly notes** (karter16) - the CPU32 disassembly the flash-window and
  command-table work is checked against.
- **MSS54HP CSL CONVERT /// TUNER** (TSUNAGI, MIT) - the DS2 flash implementation proven
  on a car: erase/write/verify, fast entry, transport, data CRC.

---

## 5. The WORKS build serves §2.1-§2.3

The WORKS build (`README.md`, "ワークス版") serves the SP-DATEN files, the bootloader and the
patched program from its own origin so that the app opens and works offline in a garage.
It serves them only behind the owner gate - to signed-in owners who hold `owner_preview` on
m3.tsunagi.app - and never from this repository or any public URL.
