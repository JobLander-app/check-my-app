// Generates public/og.png — the card a shared link shows (CHE-108).
//
// Written by hand rather than with next/og: that path renders through satori
// and resvg WebAssembly, and this product serves from workerd, where a preview
// image failing to render would fail silently and leave us back where we
// started. A file on disk cannot fail at request time.
//
// The logo on the brand ground and nothing else. The logo is the word itself
// (src/components/wordmark.tsx), so the card carries the name — the one piece
// of text that never goes stale. Titles and descriptions still come from the
// meta tags, which are per-page and always current.
//
// The word is drawn from its outline in scripts/brand-wordmark.json: Bricolage
// Grotesque at wght 800, opsz 40, tracked −0.045em, shaped with HarfBuzz and
// outlined with fontTools at 100px per em. Regenerate that file if the logo's
// face, weight or tracking ever changes.
//
//   node scripts/make-og-image.mjs

import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const W = 1200;
const H = 630;

// Brand values, taken from tailwind.config.ts so the card and the product
// cannot drift apart: the page, the text and the accent of the dark theme.
const BG = [8, 9, 12];
const FG = [232, 234, 240];
const ACCENT = [79, 140, 255];

const px = Buffer.alloc(W * H * 3);
const put = (x, y, [r, g, b]) => {
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
};
const get = (x, y) => {
  const i = (y * W + x) * 3;
  return [px[i], px[i + 1], px[i + 2]];
};
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.min(1, Math.max(0, t))));

// Ground, with the same faint upward glow the site paints behind its pages.
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W * 0.55);
    const dy = (y + H * 0.15) / (H * 0.9);
    const glow = Math.max(0, 1 - Math.hypot(dx, dy)) ** 2 * 0.16;
    put(x, y, mix(BG, ACCENT, glow));
  }
}

// --- The outline: SVG path data (absolute M L H V Q C Z, as fontTools writes
// it) flattened into closed polygons.
function polygons(d, k, ox, oy) {
  const tok = d.match(/[MLHVQCZ]|-?\d*\.?\d+(?:e-?\d+)?/g);
  const out = [];
  let poly = null, cx = 0, cy = 0, i = 0, cmd = "";
  const num = () => Number(tok[i++]);
  const pt = (x, y) => poly.push([ox + x * k, oy + y * k]);
  while (i < tok.length) {
    if (/[A-Z]/.test(tok[i])) cmd = tok[i++];
    if (cmd === "M") { poly = []; out.push(poly); cx = num(); cy = num(); pt(cx, cy); cmd = "L"; }
    else if (cmd === "L") { cx = num(); cy = num(); pt(cx, cy); }
    else if (cmd === "H") { cx = num(); pt(cx, cy); }
    else if (cmd === "V") { cy = num(); pt(cx, cy); }
    else if (cmd === "Q") {
      const x1 = num(), y1 = num(), x = num(), y = num();
      for (let s = 1; s <= 8; s++) {
        const t = s / 8, u = 1 - t;
        pt(u * u * cx + 2 * u * t * x1 + t * t * x, u * u * cy + 2 * u * t * y1 + t * t * y);
      }
      cx = x; cy = y;
    } else if (cmd === "C") {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num(), x = num(), y = num();
      for (let s = 1; s <= 12; s++) {
        const t = s / 12, u = 1 - t;
        pt(u ** 3 * cx + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t ** 3 * x,
           u ** 3 * cy + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t ** 3 * y);
      }
      cx = x; cy = y;
    } else if (cmd === "Z") { cmd = ""; }
    else throw new Error(`unexpected path command ${cmd}`);
  }
  return out;
}

// Coverage of a set of polygons per pixel, nonzero winding, antialiased with
// SS sub-scanlines per pixel row and exact horizontal span coverage.
const SS = 8;
function coverage(polys) {
  const cov = new Float32Array(W * H);
  const edges = [];
  for (const p of polys) {
    for (let j = 0; j < p.length; j++) {
      const [x0, y0] = p[j], [x1, y1] = p[(j + 1) % p.length];
      if (y0 !== y1) edges.push(y0 < y1 ? [x0, y0, x1, y1, 1] : [x1, y1, x0, y0, -1]);
    }
  }
  const top = Math.max(0, Math.floor(Math.min(...edges.map((e) => e[1]))));
  const bottom = Math.min(H, Math.ceil(Math.max(...edges.map((e) => e[3]))));
  for (let row = top; row < bottom; row++) {
    for (let s = 0; s < SS; s++) {
      const y = row + (s + 0.5) / SS;
      const hits = [];
      for (const [x0, y0, x1, y1, dir] of edges) {
        if (y >= y0 && y < y1) hits.push([x0 + ((y - y0) / (y1 - y0)) * (x1 - x0), dir]);
      }
      hits.sort((a, b) => a[0] - b[0]);
      let wind = 0;
      for (let h = 0; h < hits.length - 1; h++) {
        wind += hits[h][1];
        if (wind === 0) continue;
        const a = Math.max(0, hits[h][0]), b = Math.min(W, hits[h + 1][0]);
        for (let x = Math.floor(a); x < Math.ceil(b); x++) {
          const span = Math.min(b, x + 1) - Math.max(a, x);
          if (span > 0) cov[row * W + x] += span / SS;
        }
      }
    }
  }
  return cov;
}

// --- The word, centred, about two thirds of the card wide.
const word = JSON.parse(readFileSync(new URL("./brand-wordmark.json", import.meta.url), "utf8"));
const k = 760 / word.width;
const ox = (W - word.width * k) / 2;
const oy = (H - word.height * k) / 2;
const layer = (accent) =>
  coverage(word.glyphs.filter((g) => (g.char === "y") === accent).flatMap((g) => polygons(g.d, k, ox, oy)));
const ink = layer(false);
const blue = layer(true);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (ink[i] > 0 || blue[i] > 0) put(x, y, mix(mix(get(x, y), FG, ink[i]), ACCENT, blue[i]));
  }
}

// PNG: filter byte 0 per scanline, one IDAT, CRC per chunk.
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const raw = Buffer.alloc(H * (W * 3 + 1));
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 2;   // truecolour
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("public", { recursive: true });
writeFileSync("public/og.png", png);
console.log(`public/og.png — ${W}×${H}, ${(png.length / 1024).toFixed(0)} KB`);
