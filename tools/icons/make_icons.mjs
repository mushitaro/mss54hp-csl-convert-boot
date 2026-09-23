/**
 * The app icons, drawn from the ///M mark rather than exported from a design tool.
 *
 * Two reasons this is a script and not a set of checked-in binaries with no provenance:
 *
 *  - **The geometry is the brand's, and it is written down.** The stripes come from
 *    `tsunagi-m-design/assets/m-mark.svg`. If the mark changes, this regenerates rather than
 *    someone hand-editing a PNG and the two drifting apart.
 *  - **No native dependency.** A PNG is a zlib stream of filtered scanlines and four CRC'd chunks;
 *    Node has zlib. Adding `sharp` or `resvg` to a repo whose other dependencies are a test runner
 *    and a compiler is a poor trade for six small images.
 *
 * Run: `node tools/icons/make_icons.mjs`
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'web', 'public');

/**
 * The tricolour, with one substitution.
 *
 * The logo navy `#2B115A` is 1.33:1 on black: at icon size the middle stripe reads as a gap
 * between the blue and the red rather than as a stripe. `#9B84E8` is the same substitution the
 * header stripe and the wordmark already make, so the icon agrees with the app it launches.
 */
const BLUE = [0x00, 0x8a, 0xc9];
const VIOLET = [0x9b, 0x84, 0xe8];
const RED = [0xf1, 0x1a, 0x22];
const BLACK = [0x00, 0x00, 0x00];

/** The three stripes from m-mark.svg, in a unit square. */
const STRIPES = [
    { color: BLUE, points: [[2, 30], [8, 30], [16, 2], [10, 2]] },
    { color: VIOLET, points: [[10, 30], [16, 30], [24, 2], [18, 2]] },
    { color: RED, points: [[18, 30], [24, 30], [32, 2], [26, 2]] },
].map((s) => ({ color: s.color, points: s.points.map(([x, y]) => [x / 32, y / 32]) }));

/**
 * How much of the canvas the mark occupies.
 *
 * A maskable icon may be cropped to any shape inside the outer 20%, so the mark has to sit in the
 * central 80% - in practice inside the inscribed circle, which is tighter still. 0.58 keeps all
 * three stripes whole under a circular mask; full bleed is only safe for `purpose: any`.
 */
const SCALE = { any: 1, maskable: 0.58 };

function inPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i];
        const [xj, yj] = points[j];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Render one icon.
 *
 * 4x4 supersampling per pixel: these are steep diagonals, and at 192px an aliased edge on a
 * three-stripe mark is the first thing the eye finds on a home screen.
 */
function render(size, scale) {
    const pixels = Buffer.alloc(size * size * 3);
    const shapes = STRIPES.map((s) => ({
        color: s.color,
        points: s.points.map(([x, y]) => [(x - 0.5) * scale + 0.5, (y - 0.5) * scale + 0.5]),
    }));
    const SS = 4;

    for (let py = 0; py < size; py++) {
        for (let px = 0; px < size; px++) {
            let r = 0, g = 0, b = 0;
            for (let sy = 0; sy < SS; sy++) {
                for (let sx = 0; sx < SS; sx++) {
                    const x = (px + (sx + 0.5) / SS) / size;
                    const y = (py + (sy + 0.5) / SS) / size;
                    const hit = shapes.find((s) => inPolygon(x, y, s.points));
                    const c = hit ? hit.color : BLACK;
                    r += c[0]; g += c[1]; b += c[2];
                }
            }
            const n = SS * SS;
            const at = (py * size + px) * 3;
            pixels[at] = Math.round(r / n);
            pixels[at + 1] = Math.round(g / n);
            pixels[at + 2] = Math.round(b / n);
        }
    }
    return pixels;
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
}

/** Colour type 2 (truecolour), 8 bits, filter 0 on every scanline. */
function encodePng(size, pixels) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;   // bit depth
    ihdr[9] = 2;   // colour type: truecolour
    ihdr[10] = 0;  // deflate
    ihdr[11] = 0;  // adaptive filtering
    ihdr[12] = 0;  // no interlace

    const stride = size * 3;
    const raw = Buffer.alloc((stride + 1) * size);
    for (let y = 0; y < size; y++) {
        raw[y * (stride + 1)] = 0; // filter: none
        pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

const WANTED = [
    { file: 'icon-192.png', size: 192, scale: SCALE.any },
    { file: 'icon-512.png', size: 512, scale: SCALE.any },
    { file: 'icon-maskable-192.png', size: 192, scale: SCALE.maskable },
    { file: 'icon-maskable-512.png', size: 512, scale: SCALE.maskable },
    // iOS masks to a rounded square and does NOT honour `purpose`, so it gets the inset mark.
    { file: 'apple-touch-icon.png', size: 180, scale: SCALE.maskable },
];

mkdirSync(OUT, { recursive: true });
for (const { file, size, scale } of WANTED) {
    const png = encodePng(size, render(size, scale));
    writeFileSync(join(OUT, file), png);
    console.log(`${file.padEnd(26)} ${size}x${size}  ${png.length.toLocaleString()} bytes`);
}

// The vector original, for anything that prefers it (browser tab, desktop install).
writeFileSync(join(OUT, 'icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" fill="#000000"/>
  <path d="M2 30 L8 30 L16 2 L10 2 Z" fill="#008AC9"/>
  <path d="M10 30 L16 30 L24 2 L18 2 Z" fill="#9B84E8"/>
  <path d="M18 30 L24 30 L32 2 L26 2 Z" fill="#F11A22"/>
</svg>
`);
console.log('icon.svg');
