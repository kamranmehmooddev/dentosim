/**
 * Minimal headless software renderer (orthographic, z-buffer, headlight
 * Lambert shading, 2× supersampling) + PNG encoder. Used for package
 * thumbnails and mapping-screen file previews on GPU-less workers.
 */
import { deflateSync } from "node:zlib";
import type { Mesh } from "../mesh/mesh.js";
import { crc32 } from "../tsm2/tsm2.js";

export type Rgb = [number, number, number];

export const COLORS = {
  tooth: [236, 228, 208] as Rgb,
  gums: [214, 120, 128] as Rgb,
  attachment: [170, 186, 204] as Rgb,
  base: [205, 205, 210] as Rgb,
  arch: [228, 200, 190] as Rgb,
  scan: [180, 190, 200] as Rgb,
};

export type View = "front" | "right" | "left" | "top" | "bottom" | "auto";

export interface RenderItem {
  mesh: Mesh;
  color: Rgb;
}

export interface RenderOptions {
  width: number;
  height: number;
  view: View;
  background?: [number, number, number, number];
  marginFraction?: number;
}

/** Project world → view: returns [screenRight, screenUp, towardViewer]. */
function viewBasis(view: View, items: RenderItem[]): (x: number, y: number, z: number) => [number, number, number] {
  switch (view) {
    case "front": return (x, y, z) => [x, y, z];
    case "right": return (x, y, z) => [z, y, -x]; // patient's right side (−X) faces the viewer
    case "left": return (x, y, z) => [-z, y, x];
    case "top": return (x, y, z) => [x, -z, y]; // looking down, anterior at the bottom of the image
    case "bottom": return (x, y, z) => [x, z, -y];
    case "auto": {
      // unknown orientation (raw upload preview): look along the smallest extent
      let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (const it of items)
        for (let i = 0; i < it.mesh.positions.length; i += 3)
          for (let k = 0; k < 3; k++) {
            mn[k] = Math.min(mn[k], it.mesh.positions[i + k]);
            mx[k] = Math.max(mx[k], it.mesh.positions[i + k]);
          }
      const ext = [0, 1, 2].map((k) => mx[k] - mn[k]);
      const small = ext.indexOf(Math.min(...ext));
      if (small === 0) return (x, y, z) => [z, y, x];
      if (small === 1) return (x, y, z) => [x, -z, y];
      return (x, y, z) => [x, y, z];
    }
  }
}

export function renderRgba(items: RenderItem[], opts: RenderOptions): Uint8Array {
  const ss = 2;
  const W = opts.width * ss, H = opts.height * ss;
  const color = new Float32Array(W * H * 4);
  const depth = new Float32Array(W * H).fill(-Infinity);
  const bg = opts.background ?? [0, 0, 0, 0];
  const proj = viewBasis(opts.view, items);
  // bounds in view space
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const projected = items.map((it) => {
    const p = it.mesh.positions;
    const out = new Float32Array(p.length);
    for (let i = 0; i < p.length; i += 3) {
      const v = proj(p[i], p[i + 1], p[i + 2]);
      out[i] = v[0]; out[i + 1] = v[1]; out[i + 2] = v[2];
      if (v[0] < minX) minX = v[0]; if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1]; if (v[1] > maxY) maxY = v[1];
    }
    return out;
  });
  const margin = opts.marginFraction ?? 0.06;
  const s = Math.min((W * (1 - 2 * margin)) / Math.max(1e-6, maxX - minX), (H * (1 - 2 * margin)) / Math.max(1e-6, maxY - minY));
  const ox = W / 2 - ((minX + maxX) / 2) * s, oy = H / 2 + ((minY + maxY) / 2) * s;
  items.forEach((it, n) => {
    const p = projected[n], I = it.mesh.indices;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      // view-space normal → headlight shading (light along +view z)
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const nl = Math.hypot(nx, ny, nz);
      if (nl === 0) continue;
      const shade = 0.28 + 0.72 * Math.abs(nz / nl);
      const x0 = ox + p[a] * s, y0 = oy - p[a + 1] * s, z0 = p[a + 2];
      const x1 = ox + p[b] * s, y1 = oy - p[b + 1] * s, z1 = p[b + 2];
      const x2 = ox + p[c] * s, y2 = oy - p[c + 1] * s, z2 = p[c + 2];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (area === 0) continue;
      const bx0 = Math.max(0, Math.floor(Math.min(x0, x1, x2))), bx1 = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
      const by0 = Math.max(0, Math.floor(Math.min(y0, y1, y2))), by1 = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
      for (let y = by0; y <= by1; y++)
        for (let x = bx0; x <= bx1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area;
          const w1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          const z = w0 * z0 + w1 * z1 + w2 * z2;
          const k = y * W + x;
          if (z <= depth[k]) continue;
          depth[k] = z;
          color[k * 4] = it.color[0] * shade;
          color[k * 4 + 1] = it.color[1] * shade;
          color[k * 4 + 2] = it.color[2] * shade;
          color[k * 4 + 3] = 255;
        }
    }
  });
  // downsample with background compositing
  const out = new Uint8Array(opts.width * opts.height * 4);
  for (let y = 0; y < opts.height; y++)
    for (let x = 0; x < opts.width; x++) {
      const acc = [0, 0, 0, 0];
      for (let dy = 0; dy < ss; dy++)
        for (let dx = 0; dx < ss; dx++) {
          const k = ((y * ss + dy) * W + x * ss + dx) * 4;
          const covered = color[k + 3] > 0;
          for (let c = 0; c < 4; c++) acc[c] += covered ? color[k + c] : bg[c];
        }
      for (let c = 0; c < 4; c++) out[(y * opts.width + x) * 4 + c] = Math.round(acc[c] / (ss * ss));
    }
  return out;
}

export function encodePng(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw, { level: 9 }))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { png.set(p, o); o += p.length; }
  return png;
}

export function renderPng(items: RenderItem[], opts: RenderOptions): Uint8Array {
  return encodePng(renderRgba(items, opts), opts.width, opts.height);
}
