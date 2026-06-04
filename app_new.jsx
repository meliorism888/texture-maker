import React, { useState, useEffect, useRef, useMemo, useCallback } from "react";
import ReactDOM from "react-dom/client";

// ───────── Seeded PRNG (mulberry32) ─────────
function makeRng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Value noise (lightweight)
function makeNoise(seed) {
  const grid = new Map();
  const rng = makeRng(seed);
  const key = (x, y) => `${x},${y}`;
  const at = (x, y) => {
    const k = key(x, y);
    if (!grid.has(k)) grid.set(k, rng());
    return grid.get(k);
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return function (x, y) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = at(xi, yi), b = at(xi + 1, yi);
    const c = at(xi, yi + 1), d = at(xi + 1, yi + 1);
    const u = smooth(xf), v = smooth(yf);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

function fbm(noise, x, y, octaves, persistence) {
  let total = 0, freq = 1, amp = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    total += noise(x * freq, y * freq) * amp;
    max += amp;
    amp *= persistence;
    freq *= 2;
  }
  return total / max;
}

// ───────── Seamless helpers ─────────
// Draw a primitive and, when seamless, repeat any copy that overlaps an edge on
// the opposite side so the texture wraps cleanly across tile boundaries (torus).
function wrapDraw(x, y, r, w, h, seamless, drawAt) {
  if (!seamless) { drawAt(x, y); return; }
  const oxs = [0];
  if (x - r < 0) oxs.push(w);
  if (x + r > w) oxs.push(-w);
  const oys = [0];
  if (y - r < 0) oys.push(h);
  if (y + r > h) oys.push(-h);
  for (const dx of oxs) for (const dy of oys) drawAt(x + dx, y + dy);
}

// Tileable value noise: integer lattice coords wrap modulo a period, so fbm
// sampled over [0,period) repeats exactly. Period propagates through octaves.
function makeTileNoise(seed) {
  const grid = new Map();
  const rng = makeRng(seed);
  const at = (x, y, period) => {
    if (period > 0) {
      x = ((x % period) + period) % period;
      y = ((y % period) + period) % period;
    }
    const k = x + "," + y;
    if (!grid.has(k)) grid.set(k, rng());
    return grid.get(k);
  };
  const smooth = (t) => t * t * (3 - 2 * t);
  return function (x, y, period) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const a = at(xi, yi, period), b = at(xi + 1, yi, period);
    const c = at(xi, yi + 1, period), d = at(xi + 1, yi + 1, period);
    const u = smooth(xf), v = smooth(yf);
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

function fbmTile(noise, x, y, octaves, persistence, period) {
  let total = 0, freq = 1, amp = 1, max = 0;
  for (let i = 0; i < octaves; i++) {
    total += noise(x * freq, y * freq, period * freq) * amp;
    max += amp;
    amp *= persistence;
    freq *= 2;
  }
  return total / max;
}

// ───────── Texture engines ─────────
const ENGINES = {
  dots: {
    label: "Dots",
    params: {
      density: { min: 4, max: 80, step: 1, default: 28, label: "Density" },
      size: { min: 0.5, max: 12, step: 0.1, default: 2.4, label: "Dot size" },
      sizeJitter: { min: 0, max: 1, step: 0.01, default: 0.4, label: "Size variation" },
      scatter: { min: 0, max: 1, step: 0.01, default: 0.65, label: "Scatter" },
      opacity: { min: 0, max: 1, step: 0.01, default: 1, label: "Opacity" },
    },
    render(ctx, w, h, p, fg, rng, bg, seamless) {
      ctx.fillStyle = fg;
      ctx.globalAlpha = p.opacity;
      const cols = p.density;
      const rows = Math.round(p.density * h / w);
      const cw = w / cols, rh = h / rows;
      // In seamless mode iterate edge-exclusive so the wrapped lattice stays even.
      const iMax = seamless ? cols - 1 : cols;
      const jMax = seamless ? rows - 1 : rows;
      for (let i = 0; i <= iMax; i++) {
        for (let j = 0; j <= jMax; j++) {
          const jx = (rng() - 0.5) * cw * p.scatter * 2;
          const jy = (rng() - 0.5) * rh * p.scatter * 2;
          const sz = Math.max(0.1, p.size * (1 - p.sizeJitter + rng() * p.sizeJitter * 2));
          let px = i * cw + jx, py = j * rh + jy;
          if (seamless) { px = ((px % w) + w) % w; py = ((py % h) + h) % h; }
          wrapDraw(px, py, sz, w, h, seamless, (x, y) => {
            ctx.beginPath();
            ctx.arc(x, y, sz, 0, Math.PI * 2);
            ctx.fill();
          });
        }
      }
      ctx.globalAlpha = 1;
    },
  },
  lines: {
    label: "Hatching",
    params: {
      spacing: { min: 2, max: 60, step: 0.5, default: 10, label: "Spacing" },
      angle: { min: 0, max: 180, step: 1, default: 45, label: "Angle" },
      thickness: { min: 0.2, max: 8, step: 0.1, default: 1.2, label: "Weight" },
      wobble: { min: 0, max: 1, step: 0.01, default: 0.15, label: "Wobble" },
      cross: { min: 0, max: 1, step: 0.01, default: 0, label: "Cross-hatch" },
    },
    render(ctx, w, h, p, fg, rng) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = p.thickness;
      ctx.lineCap = "round";
      const drawSet = (angleDeg, alpha) => {
        ctx.globalAlpha = alpha;
        const rad = (angleDeg * Math.PI) / 180;
        const cx = w / 2, cy = h / 2;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rad);
        const diag = Math.hypot(w, h);
        for (let y = -diag; y <= diag; y += p.spacing) {
          ctx.beginPath();
          const steps = 32;
          for (let i = 0; i <= steps; i++) {
            const x = -diag + (i / steps) * diag * 2;
            const wob = (rng() - 0.5) * p.spacing * p.wobble;
            if (i === 0) ctx.moveTo(x, y + wob);
            else ctx.lineTo(x, y + wob);
          }
          ctx.stroke();
        }
        ctx.restore();
      };
      drawSet(p.angle, 1);
      if (p.cross > 0.01) drawSet(p.angle + 90, p.cross);
      ctx.globalAlpha = 1;
    },
  },
  grid: {
    label: "Grid",
    params: {
      cellSize: { min: 4, max: 120, step: 1, default: 24, label: "Cell size" },
      weight: { min: 0.2, max: 8, step: 0.1, default: 1, label: "Line weight" },
      jitter: { min: 0, max: 1, step: 0.01, default: 0, label: "Jitter" },
      breakage: { min: 0, max: 1, step: 0.01, default: 0, label: "Break-up" },
      diagonal: { min: 0, max: 1, step: 0.01, default: 0, label: "Diagonals" },
    },
    render(ctx, w, h, p, fg, rng) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = p.weight;
      const c = p.cellSize;
      const J = (m) => (rng() - 0.5) * c * p.jitter * m;
      for (let x = 0; x <= w; x += c) {
        for (let y = 0; y <= h; y += c) {
          if (rng() > p.breakage) {
            ctx.beginPath();
            ctx.moveTo(x + J(1), y + J(1));
            ctx.lineTo(x + c + J(1), y + J(1));
            ctx.stroke();
          }
          if (rng() > p.breakage) {
            ctx.beginPath();
            ctx.moveTo(x + J(1), y + J(1));
            ctx.lineTo(x + J(1), y + c + J(1));
            ctx.stroke();
          }
          if (p.diagonal > 0.01 && rng() < p.diagonal) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + c, y + c);
            ctx.stroke();
          }
        }
      }
    },
  },
  noise: {
    label: "Noise",
    params: {
      scale: { min: 1, max: 40, step: 0.5, default: 8, label: "Scale" },
      octaves: { min: 1, max: 6, step: 1, default: 4, label: "Octaves" },
      contrast: { min: 0.2, max: 4, step: 0.05, default: 1.4, label: "Contrast" },
      threshold: { min: 0, max: 1, step: 0.01, default: 0, label: "Threshold" },
      grain: { min: 0, max: 1, step: 0.01, default: 0.1, label: "Grain" },
    },
    render(ctx, w, h, p, fg, rng, bg, seamless) {
      const img = ctx.createImageData(w, h);
      const fgRGB = hexToRgb(fg), bgRGB = hexToRgb(bg);
      const step = 1;
      // Seamless: snap scale to an integer period and wrap the lattice on a torus.
      const period = Math.max(1, Math.round(p.scale));
      const scaleEff = seamless ? period : p.scale;
      const noise = seamless ? makeTileNoise(Math.floor(rng() * 1e9)) : makeNoise(Math.floor(rng() * 1e9));
      const gn = makeRng(Math.floor(rng() * 1e9)); // grain rng, kept out of wrap
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const nx = x / (w / scaleEff);
          const ny = y / (h / scaleEff);
          let v = seamless
            ? fbmTile(noise, nx, ny, p.octaves, 0.5, period)
            : fbm(noise, nx, ny, p.octaves, 0.5);
          v = (v - 0.5) * p.contrast + 0.5;
          if (p.threshold > 0) v = v > p.threshold ? 1 : 0;
          v += (gn() - 0.5) * p.grain;
          v = Math.max(0, Math.min(1, v));
          const r = bgRGB[0] + (fgRGB[0] - bgRGB[0]) * v;
          const g = bgRGB[1] + (fgRGB[1] - bgRGB[1]) * v;
          const b = bgRGB[2] + (fgRGB[2] - bgRGB[2]) * v;
          const i = (y * w + x) * 4;
          img.data[i] = r;
          img.data[i + 1] = g;
          img.data[i + 2] = b;
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  },
  voronoi: {
    label: "Voronoi",
    params: {
      cells: { min: 4, max: 200, step: 1, default: 40, label: "Cell count" },
      strokeWeight: { min: 0, max: 6, step: 0.1, default: 1.2, label: "Edge weight" },
      shading: { min: 0, max: 1, step: 0.01, default: 0.4, label: "Fill shading" },
      irregularity: { min: 0, max: 1, step: 0.01, default: 1, label: "Irregularity" },
      borderFade: { min: 0, max: 1, step: 0.01, default: 0, label: "Edge fade" },
    },
    render(ctx, w, h, p, fg, rng, bg, seamless) {
      const N = p.cells;
      const pts = [];
      const gridCols = Math.ceil(Math.sqrt(N * w / h));
      const gridRows = Math.ceil(N / gridCols);
      for (let i = 0; i < gridCols; i++) {
        for (let j = 0; j < gridRows; j++) {
          const baseX = (i + 0.5) * w / gridCols;
          const baseY = (j + 0.5) * h / gridRows;
          const jx = (rng() - 0.5) * (w / gridCols) * p.irregularity;
          const jy = (rng() - 0.5) * (h / gridRows) * p.irregularity;
          pts.push([baseX + jx, baseY + jy, rng()]);
        }
      }
      // Seamless: mirror every seed into the 8 neighbour tiles so cells flow
      // continuously across edges (distance test wraps on a torus).
      const seeds = pts;
      if (seamless) {
        const ghosts = [];
        for (const pt of pts) {
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              if (dx === 0 && dy === 0) continue;
              ghosts.push([pt[0] + dx * w, pt[1] + dy * h, pt[2]]);
            }
          }
        }
        for (const g of ghosts) seeds.push(g);
      }
      const fgRGB = hexToRgb(fg), bgRGB = hexToRgb(bg);
      const img = ctx.createImageData(w, h);
      const step = 2;
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          let best = Infinity, second = Infinity, bestIdx = 0;
          for (let k = 0; k < seeds.length; k++) {
            const dx = x - seeds[k][0], dy = y - seeds[k][1];
            const d = dx * dx + dy * dy;
            if (d < best) { second = best; best = d; bestIdx = k; }
            else if (d < second) second = d;
          }
          const edge = Math.sqrt(second) - Math.sqrt(best);
          const shade = seeds[bestIdx][2] * p.shading;
          const v = shade;
          let r = bgRGB[0] + (fgRGB[0] - bgRGB[0]) * v;
          let g = bgRGB[1] + (fgRGB[1] - bgRGB[1]) * v;
          let b = bgRGB[2] + (fgRGB[2] - bgRGB[2]) * v;
          if (edge < p.strokeWeight) {
            const t = 1 - edge / Math.max(0.01, p.strokeWeight);
            r = r + (fgRGB[0] - r) * t;
            g = g + (fgRGB[1] - g) * t;
            b = b + (fgRGB[2] - b) * t;
          }
          for (let dy2 = 0; dy2 < step; dy2++) {
            for (let dx2 = 0; dx2 < step; dx2++) {
              const i = ((y + dy2) * w + (x + dx2)) * 4;
              img.data[i] = r;
              img.data[i + 1] = g;
              img.data[i + 2] = b;
              img.data[i + 3] = 255;
            }
          }
        }
      }
      ctx.putImageData(img, 0, 0);
    },
  },
  scatter: {
    label: "Scatter",
    params: {
      count: { min: 10, max: 2000, step: 10, default: 400, label: "Count" },
      sizeMin: { min: 1, max: 30, step: 0.5, default: 4, label: "Min size" },
      sizeMax: { min: 2, max: 80, step: 0.5, default: 18, label: "Max size" },
      rotation: { min: 0, max: 1, step: 0.01, default: 1, label: "Rotation" },
      shape: { min: 0, max: 3, step: 1, default: 0, label: "Shape (◯ □ △ ─)" },
    },
    render(ctx, w, h, p, fg, rng, bg, seamless) {
      ctx.fillStyle = fg;
      ctx.strokeStyle = fg;
      const shape = Math.floor(p.shape);
      for (let i = 0; i < p.count; i++) {
        const x = rng() * w;
        const y = rng() * h;
        const sz = p.sizeMin + rng() * (p.sizeMax - p.sizeMin);
        const rot = rng() * Math.PI * 2 * p.rotation;
        const drawShape = (cx, cy) => {
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(rot);
          ctx.beginPath();
          if (shape === 0) {
            ctx.arc(0, 0, sz / 2, 0, Math.PI * 2);
            ctx.fill();
          } else if (shape === 1) {
            ctx.fillRect(-sz / 2, -sz / 2, sz, sz);
          } else if (shape === 2) {
            ctx.moveTo(0, -sz / 2);
            ctx.lineTo(sz / 2, sz / 2);
            ctx.lineTo(-sz / 2, sz / 2);
            ctx.closePath();
            ctx.fill();
          } else {
            ctx.lineWidth = Math.max(1, sz / 8);
            ctx.moveTo(-sz / 2, 0);
            ctx.lineTo(sz / 2, 0);
            ctx.stroke();
          }
          ctx.restore();
        };
        wrapDraw(x, y, sz, w, h, seamless, drawShape);
      }
    },
  },
  waves: {
    label: "Waves",
    params: {
      frequency: { min: 0.5, max: 20, step: 0.1, default: 4, label: "Frequency" },
      amplitude: { min: 0, max: 100, step: 1, default: 20, label: "Amplitude" },
      spacing: { min: 4, max: 80, step: 1, default: 14, label: "Spacing" },
      thickness: { min: 0.2, max: 6, step: 0.1, default: 1, label: "Weight" },
      phaseShift: { min: 0, max: 1, step: 0.01, default: 0.3, label: "Phase drift" },
    },
    render(ctx, w, h, p, fg, rng) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = p.thickness;
      ctx.lineCap = "round";
      for (let y = -p.amplitude; y < h + p.amplitude; y += p.spacing) {
        ctx.beginPath();
        const phase = rng() * Math.PI * 2 * p.phaseShift;
        for (let x = 0; x <= w; x += 2) {
          const yy = y + Math.sin((x / w) * Math.PI * 2 * p.frequency + phase) * p.amplitude;
          if (x === 0) ctx.moveTo(x, yy);
          else ctx.lineTo(x, yy);
        }
        ctx.stroke();
      }
    },
  },
  truchet: {
    label: "Truchet",
    params: {
      tileSize: { min: 8, max: 120, step: 1, default: 36, label: "Tile size" },
      weight: { min: 0.5, max: 14, step: 0.1, default: 2.4, label: "Weight" },
      variant: { min: 0, max: 2, step: 1, default: 0, label: "Style (arc/diag/quad)" },
      density: { min: 0, max: 1, step: 0.01, default: 1, label: "Density" },
      chaos: { min: 0, max: 1, step: 0.01, default: 0.5, label: "Chaos" },
    },
    render(ctx, w, h, p, fg, rng) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = p.weight;
      ctx.lineCap = "round";
      const s = p.tileSize;
      const variant = Math.floor(p.variant);
      for (let y = 0; y < h; y += s) {
        for (let x = 0; x < w; x += s) {
          if (rng() > p.density) continue;
          const flip = rng() < p.chaos;
          ctx.beginPath();
          if (variant === 0) {
            if (flip) {
              ctx.arc(x, y, s / 2, 0, Math.PI / 2);
              ctx.moveTo(x + s + s / 2, y + s);
              ctx.arc(x + s, y + s, s / 2, Math.PI, 1.5 * Math.PI);
            } else {
              ctx.arc(x + s, y, s / 2, Math.PI / 2, Math.PI);
              ctx.moveTo(x + s / 2, y + s);
              ctx.arc(x, y + s, s / 2, 1.5 * Math.PI, 2 * Math.PI);
            }
          } else if (variant === 1) {
            if (flip) { ctx.moveTo(x, y); ctx.lineTo(x + s, y + s); }
            else { ctx.moveTo(x + s, y); ctx.lineTo(x, y + s); }
          } else {
            const cx = x + s / 2, cy = y + s / 2;
            if (flip) {
              ctx.moveTo(cx, y); ctx.lineTo(cx, cy); ctx.lineTo(x + s, cy);
              ctx.moveTo(x, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, y + s);
            } else {
              ctx.moveTo(cx, y); ctx.lineTo(cx, cy); ctx.lineTo(x, cy);
              ctx.moveTo(x + s, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, y + s);
            }
          }
          ctx.stroke();
        }
      }
    },
  },
  flow: {
    label: "Flow",
    params: {
      particles: { min: 20, max: 1500, step: 10, default: 350, label: "Particles" },
      length: { min: 5, max: 200, step: 1, default: 70, label: "Trail length" },
      stepSize: { min: 0.5, max: 8, step: 0.1, default: 2, label: "Step size" },
      curl: { min: 0.5, max: 20, step: 0.1, default: 3, label: "Curl" },
      weight: { min: 0.2, max: 4, step: 0.1, default: 0.7, label: "Weight" },
    },
    render(ctx, w, h, p, fg, rng, bg, seamless) {
      const period = Math.max(1, Math.round(p.curl));
      const curlEff = seamless ? period : p.curl;
      const noise = seamless ? makeTileNoise(Math.floor(rng() * 1e9)) : makeNoise(Math.floor(rng() * 1e9));
      const sample = (nx, ny) => seamless ? noise(nx, ny, period) : noise(nx, ny);
      ctx.strokeStyle = fg;
      ctx.lineWidth = p.weight;
      ctx.lineCap = "round";
      ctx.globalAlpha = 0.55;
      for (let i = 0; i < p.particles; i++) {
        let x = rng() * w;
        let y = rng() * h;
        ctx.beginPath();
        ctx.moveTo(x, y);
        let px = x, py = y;
        for (let step = 0; step < p.length; step++) {
          const nx = x / (w / curlEff);
          const ny = y / (h / curlEff);
          const angle = sample(nx, ny) * Math.PI * 4;
          x += Math.cos(angle) * p.stepSize;
          y += Math.sin(angle) * p.stepSize;
          if (seamless) {
            const wx = ((x % w) + w) % w;
            const wy = ((y % h) + h) % h;
            // If the wrap jumped the particle across an edge, lift the pen.
            if (Math.abs(wx - px) > w / 2 || Math.abs(wy - py) > h / 2) {
              ctx.moveTo(wx, wy);
            } else {
              ctx.lineTo(wx, wy);
            }
            x = wx; y = wy; px = wx; py = wy;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },
  },
  hex: {
    label: "Hex",
    params: {
      size: { min: 6, max: 80, step: 1, default: 22, label: "Cell radius" },
      weight: { min: 0.2, max: 6, step: 0.1, default: 1, label: "Line weight" },
      fillChance: { min: 0, max: 1, step: 0.01, default: 0, label: "Fill density" },
      inset: { min: 0, max: 0.4, step: 0.01, default: 0, label: "Inset" },
      breakage: { min: 0, max: 1, step: 0.01, default: 0, label: "Break-up" },
    },
    render(ctx, w, h, p, fg, rng) {
      ctx.strokeStyle = fg;
      ctx.fillStyle = fg;
      ctx.lineWidth = p.weight;
      ctx.lineJoin = "round";
      const r = p.size;
      const colStep = r * 1.5;
      const rowStep = r * Math.sqrt(3);
      for (let col = -1; col * colStep < w + r; col++) {
        for (let row = -1; row * rowStep < h + rowStep; row++) {
          if (rng() < p.breakage) continue;
          const cx = col * colStep;
          const cy = row * rowStep + (col % 2 ? rowStep / 2 : 0);
          const rr = r * (1 - p.inset);
          ctx.beginPath();
          for (let k = 0; k < 6; k++) {
            const a = (Math.PI / 3) * k;
            const px = cx + rr * Math.cos(a);
            const py = cy + rr * Math.sin(a);
            if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
          ctx.closePath();
          if (rng() < p.fillChance) ctx.fill();
          else ctx.stroke();
        }
      }
    },
  },
  bricks: {
    label: "Bricks",
    params: {
      width: { min: 10, max: 200, step: 1, default: 64, label: "Brick width" },
      height: { min: 4, max: 80, step: 1, default: 24, label: "Brick height" },
      mortar: { min: 0, max: 10, step: 0.5, default: 3, label: "Mortar" },
      offset: { min: 0, max: 1, step: 0.01, default: 0.5, label: "Stagger" },
      variance: { min: 0, max: 1, step: 0.01, default: 0.15, label: "Variance" },
    },
    render(ctx, w, h, p, fg, rng) {
      ctx.fillStyle = fg;
      const bw = p.width;
      const bh = p.height;
      const m = p.mortar;
      let row = 0;
      for (let y = 0; y < h + bh; y += bh) {
        const xOffset = (row % 2) * bw * p.offset;
        for (let x = -bw; x < w + bw; x += bw) {
          const jx = (rng() - 0.5) * bw * p.variance * 0.3;
          const jw = Math.max(2, bw - m + (rng() - 0.5) * bw * p.variance);
          const jh = Math.max(1, bh - m + (rng() - 0.5) * bh * p.variance * 0.3);
          ctx.fillRect(x + xOffset + jx, y, jw, jh);
        }
        row++;
      }
    },
  },
  rings: {
    label: "Rings",
    params: {
      centers: { min: 1, max: 40, step: 1, default: 5, label: "Origins" },
      spacing: { min: 2, max: 50, step: 0.5, default: 10, label: "Ring spacing" },
      weight: { min: 0.2, max: 4, step: 0.1, default: 1, label: "Weight" },
      maxRadius: { min: 50, max: 1200, step: 10, default: 400, label: "Max radius" },
      breakage: { min: 0, max: 1, step: 0.01, default: 0, label: "Break-up" },
    },
    render(ctx, w, h, p, fg, rng, bg, seamless) {
      ctx.strokeStyle = fg;
      ctx.lineWidth = p.weight;
      const offsets = seamless
        ? [[0,0],[-w,0],[w,0],[0,-h],[0,h],[-w,-h],[w,-h],[-w,h],[w,h]]
        : [[0,0]];
      for (let i = 0; i < p.centers; i++) {
        const cx = rng() * w;
        const cy = rng() * h;
        // Decide each ring once so every wrapped copy of this origin matches.
        const radii = [];
        for (let r = p.spacing; r < p.maxRadius; r += p.spacing) {
          if (rng() < p.breakage) continue;
          radii.push(r);
        }
        for (const [ox, oy] of offsets) {
          for (const r of radii) {
            ctx.beginPath();
            ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    },
  },
};

function hexToRgb(hex) {
  const m = hex.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

// ───────── Default state ─────────
const DEFAULT_STATE = {
  engine: "dots",
  width: 1200,
  height: 800,
  fg: "#1a1816",
  bg: "#f4f1ea",
  seed: 42,
  seamless: true,
  params: Object.fromEntries(
    Object.entries(ENGINES).map(([k, e]) => [
      k,
      Object.fromEntries(Object.entries(e.params).map(([pk, pv]) => [pk, pv.default])),
    ])
  ),
  postfx: {
    invert: false,
    rotation: 0,
    mirror: "none", // none, horizontal, vertical, quad, kaleido
    vignette: 0,
    grain: 0,
    blur: 0,
  },
};

const ASPECT_PRESETS = [
  { label: "1:1", w: 1000, h: 1000 },
  { label: "4:3", w: 1200, h: 900 },
  { label: "3:2", w: 1200, h: 800 },
  { label: "16:9", w: 1600, h: 900 },
  { label: "9:16", w: 720, h: 1280 },
  { label: "A4", w: 1240, h: 1754 },
];

const MIRROR_MODES = [
  { value: "none", label: "Off" },
  { value: "horizontal", label: "H" },
  { value: "vertical", label: "V" },
  { value: "quad", label: "Quad" },
  { value: "kaleido", label: "Kaleido" },
];

const PRESETS = [
  { name: "Linen", engine: "lines", patch: { spacing: 4, angle: 0, thickness: 0.8, wobble: 0.05, cross: 0.6 }, fg: "#3a3530", bg: "#f4f1ea" },
  { name: "Stipple", engine: "dots", patch: { density: 60, size: 1.4, sizeJitter: 0.6, scatter: 0.9, opacity: 0.85 }, fg: "#1a1816", bg: "#f4f1ea" },
  { name: "Fog", engine: "noise", patch: { scale: 4, octaves: 5, contrast: 1.1, threshold: 0, grain: 0.05 }, fg: "#1a1816", bg: "#f4f1ea" },
  { name: "Stone", engine: "voronoi", patch: { cells: 80, strokeWeight: 0.8, shading: 0.5, irregularity: 0.8, borderFade: 0 }, fg: "#2a2520", bg: "#ede8df" },
  { name: "Confetti", engine: "scatter", patch: { count: 600, sizeMin: 2, sizeMax: 14, rotation: 1, shape: 2 }, fg: "#c4593a", bg: "#f4f1ea" },
  { name: "Ripple", engine: "waves", patch: { frequency: 8, amplitude: 14, spacing: 8, thickness: 0.6, phaseShift: 0.5 }, fg: "#1a1816", bg: "#f4f1ea" },
  { name: "Graphite", engine: "noise", patch: { scale: 18, octaves: 6, contrast: 2.2, threshold: 0, grain: 0.3 }, fg: "#1a1816", bg: "#dcd6cb" },
  { name: "Halftone", engine: "dots", patch: { density: 50, size: 4, sizeJitter: 0.05, scatter: 0, opacity: 1 }, fg: "#c4593a", bg: "#f4f1ea" },
  { name: "Arches", engine: "truchet", patch: { tileSize: 48, weight: 2.5, variant: 0, density: 1, chaos: 0.5 }, fg: "#1a1816", bg: "#f4f1ea" },
  { name: "Smoke", engine: "flow", patch: { particles: 500, length: 90, stepSize: 1.8, curl: 3, weight: 0.5 }, fg: "#1a1816", bg: "#ede8df" },
  { name: "Honeycomb", engine: "hex", patch: { size: 18, weight: 1.2, fillChance: 0.15, inset: 0.1, breakage: 0 }, fg: "#c4593a", bg: "#f4f1ea" },
  { name: "Masonry", engine: "bricks", patch: { width: 80, height: 28, mortar: 4, offset: 0.5, variance: 0.2 }, fg: "#7a3a3a", bg: "#f0e8d8" },
];

const COLOR_SWATCHES = [
  { fg: "#1a1816", bg: "#f4f1ea", name: "Paper" },
  { fg: "#f4f1ea", bg: "#1a1816", name: "Ink" },
  { fg: "#c4593a", bg: "#f4f1ea", name: "Terracotta" },
  { fg: "#1a1816", bg: "#dcd6cb", name: "Stone" },
  { fg: "#2c4a3e", bg: "#f0ead8", name: "Moss" },
  { fg: "#3a4a6b", bg: "#e8e4d8", name: "Indigo" },
  { fg: "#7a3a3a", bg: "#f0e8d8", name: "Brick" },
  { fg: "#e8e4d8", bg: "#2a2a2a", name: "Chalk" },
];

// ───────── UI ─────────
function Slider({ label, value, min, max, step, onChange, suffix }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const display = Number.isInteger(step) ? String(Math.round(value)) : value.toFixed(2);
  const commit = () => {
    const n = parseFloat(draft);
    if (!isNaN(n)) onChange(Math.max(min, Math.min(max, n)));
    setEditing(false);
  };
  return (
    <div className="slider">
      <div className="slider-head">
        <span className="slider-label">{label}</span>
        {editing ? (
          <input
            className="slider-value-input mono"
            type="text"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          />
        ) : (
          <span
            className="slider-value mono"
            onClick={() => { setDraft(display); setEditing(true); }}
            title="Click to type a value"
          >
            {display}{suffix || ""}
          </span>
        )}
      </div>
      <div className="slider-track-wrap">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value))}
        />
        <div className="slider-fill" style={{ width: `${((value - min) / (max - min)) * 100}%` }}></div>
      </div>
    </div>
  );
}

function App() {
  // Load initial state from URL hash if present
  const initialState = useMemo(() => {
    try {
      if (window.location.hash.startsWith("#s=")) {
        const decoded = JSON.parse(atob(window.location.hash.slice(3)));
        return { ...DEFAULT_STATE, ...decoded, params: { ...DEFAULT_STATE.params, ...(decoded.params || {}) }, postfx: { ...DEFAULT_STATE.postfx, ...(decoded.postfx || {}) } };
      }
    } catch (e) {}
    return DEFAULT_STATE;
  }, []);

  const [state, setState] = useState(initialState);
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const [renderTime, setRenderTime] = useState(0);
  const [showTile, setShowTile] = useState(false);
  const [history, setHistory] = useState([initialState.seed]);
  const [copied, setCopied] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [library, setLibrary] = useState(() => {
    try { return JSON.parse(localStorage.getItem("tx-library") || "[]"); } catch { return []; }
  });
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const skipUndo = useRef(false);

  const engine = ENGINES[state.engine];

  const updateParam = (key, value) => {
    setState((s) => ({
      ...s,
      params: { ...s.params, [s.engine]: { ...s.params[s.engine], [key]: value } },
    }));
  };

  const setEngine = (key) => setState((s) => ({ ...s, engine: key }));
  const setSeed = (v) => {
    setState((s) => ({ ...s, seed: v }));
    setHistory((h) => [v, ...h.filter((x) => x !== v)].slice(0, 8));
  };
  const randomize = () => setSeed(Math.floor(Math.random() * 99999));
  const setColor = (key, value) => setState((s) => ({ ...s, [key]: value }));
  const toggleSeamless = () => setState((s) => ({ ...s, seamless: !s.seamless }));
  const setPostFX = (key, value) => setState((s) => ({ ...s, postfx: { ...s.postfx, [key]: value } }));
  const setAspect = (w, h) => setState((s) => ({ ...s, width: w, height: h }));
  const applyPreset = (preset) => {
    setState((s) => ({
      ...s,
      engine: preset.engine,
      fg: preset.fg,
      bg: preset.bg,
      params: { ...s.params, [preset.engine]: { ...s.params[preset.engine], ...preset.patch } },
    }));
  };
  const applySwatch = (sw) => setState((s) => ({ ...s, fg: sw.fg, bg: sw.bg }));
  const invertColors = () => setState((s) => ({ ...s, fg: s.bg, bg: s.fg }));
  const resetPostFX = () => setState((s) => ({ ...s, postfx: DEFAULT_STATE.postfx }));

  // ── Two-pass render: draft (fast, low-res) while dragging, full-res when settled ──
  const isDragging = useRef(false);
  const dragTimer = useRef(null);

  const runRender = useCallback((s, preview) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // Draft pass renders at 25% area (50% each dimension) for speed
    const scale = preview ? 0.5 : 1;
    const rw = Math.max(4, Math.round(s.width * scale));
    const rh = Math.max(4, Math.round(s.height * scale));
    canvas.width = s.width;
    canvas.height = s.height;
    const ctx = canvas.getContext("2d");
    const t0 = performance.now();

    // Render to offscreen at draft resolution, then stretch to full canvas
    const off = document.createElement("canvas");
    off.width = rw; off.height = rh;
    const octx = off.getContext("2d");
    const eng = ENGINES[s.engine];

    octx.save();
    octx.fillStyle = s.bg;
    octx.fillRect(0, 0, rw, rh);

    const { mirror, rotation } = s.postfx;
    if (rotation !== 0) {
      octx.translate(rw / 2, rh / 2);
      octx.rotate((rotation * Math.PI) / 180);
      octx.translate(-rw / 2, -rh / 2);
    }

    if (mirror === "none") {
      const rng = makeRng(s.seed);
      eng.render(octx, rw, rh, s.params[s.engine], s.fg, rng, s.bg, s.seamless);
    } else {
      const tw = mirror === "horizontal" ? rw / 2 : (mirror === "vertical" ? rw : rw / 2);
      const th = mirror === "vertical" ? rh / 2 : (mirror === "horizontal" ? rh : rh / 2);
      const moff = document.createElement("canvas");
      moff.width = Math.ceil(tw); moff.height = Math.ceil(th);
      const mctx = moff.getContext("2d");
      mctx.fillStyle = s.bg;
      mctx.fillRect(0, 0, moff.width, moff.height);
      const rng = makeRng(s.seed);
      eng.render(mctx, moff.width, moff.height, s.params[s.engine], s.fg, rng, s.bg, s.seamless);
      if (mirror === "horizontal") {
        octx.drawImage(moff, 0, 0);
        octx.save(); octx.translate(rw, 0); octx.scale(-1, 1); octx.drawImage(moff, 0, 0); octx.restore();
      } else if (mirror === "vertical") {
        octx.drawImage(moff, 0, 0);
        octx.save(); octx.translate(0, rh); octx.scale(1, -1); octx.drawImage(moff, 0, 0); octx.restore();
      } else if (mirror === "quad" || mirror === "kaleido") {
        octx.drawImage(moff, 0, 0);
        octx.save(); octx.translate(rw, 0); octx.scale(-1, 1); octx.drawImage(moff, 0, 0); octx.restore();
        octx.save(); octx.translate(0, rh); octx.scale(1, -1); octx.drawImage(moff, 0, 0); octx.restore();
        octx.save(); octx.translate(rw, rh); octx.scale(-1, -1); octx.drawImage(moff, 0, 0); octx.restore();
      }
    }
    octx.restore();

    // Stretch draft to full canvas (fast — GPU scaled)
    ctx.save();
    ctx.imageSmoothingEnabled = preview;
    ctx.drawImage(off, 0, 0, s.width, s.height);
    ctx.restore();

    // Post-FX (skip on draft for speed)
    if (!preview) {
      const fx = s.postfx;
      if (fx.invert || fx.vignette > 0 || fx.grain > 0) {
        const img = ctx.getImageData(0, 0, s.width, s.height);
        const data = img.data;
        const cx = s.width / 2, cy = s.height / 2;
        const maxD = Math.hypot(cx, cy);
        const rng = makeRng(s.seed + 999);
        for (let y = 0; y < s.height; y++) {
          for (let x = 0; x < s.width; x++) {
            const i = (y * s.width + x) * 4;
            let r = data[i], g = data[i + 1], b = data[i + 2];
            if (fx.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
            if (fx.vignette > 0) {
              const d = Math.hypot(x - cx, y - cy) / maxD;
              const v = 1 - Math.max(0, (d - (1 - fx.vignette)) / fx.vignette) * fx.vignette;
              r *= v; g *= v; b *= v;
            }
            if (fx.grain > 0) {
              const n = (rng() - 0.5) * 255 * fx.grain;
              r += n; g += n; b += n;
            }
            data[i] = Math.max(0, Math.min(255, r));
            data[i + 1] = Math.max(0, Math.min(255, g));
            data[i + 2] = Math.max(0, Math.min(255, b));
          }
        }
        ctx.putImageData(img, 0, 0);
      }
    }
    setRenderTime(performance.now() - t0);
  }, []);

  // Render texture (with post-FX)
  useEffect(() => {
    // Draft render immediately
    runRender(state, true);
    // Full render after 180ms idle
    clearTimeout(dragTimer.current);
    dragTimer.current = setTimeout(() => runRender(state, false), 180);
    return () => clearTimeout(dragTimer.current);
  }, [state, runRender]);

  // DEAD CODE BELOW — kept for shape only, real render logic is above
  const _unused = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = state.width;
    canvas.height = state.height;
    const ctx = canvas.getContext("2d");
    const t0 = performance.now();
    ctx.save();
    ctx.fillStyle = state.bg;
    ctx.fillRect(0, 0, state.width, state.height);

    const { mirror, rotation } = state.postfx;

    // Render with rotation
    if (rotation !== 0) {
      ctx.translate(state.width / 2, state.height / 2);
      ctx.rotate((rotation * Math.PI) / 180);
      ctx.translate(-state.width / 2, -state.height / 2);
    }

    if (mirror === "none") {
      const rng = makeRng(state.seed);
      engine.render(ctx, state.width, state.height, state.params[state.engine], state.fg, rng, state.bg, state.seamless);
    } else {
      // Render base tile to offscreen
      const tw = mirror === "horizontal" ? state.width / 2 : (mirror === "vertical" ? state.width : state.width / 2);
      const th = mirror === "vertical" ? state.height / 2 : (mirror === "horizontal" ? state.height : state.height / 2);
      const off = document.createElement("canvas");
      off.width = Math.ceil(tw); off.height = Math.ceil(th);
      const octx = off.getContext("2d");
      octx.fillStyle = state.bg;
      octx.fillRect(0, 0, off.width, off.height);
      const rng = makeRng(state.seed);
      engine.render(octx, off.width, off.height, state.params[state.engine], state.fg, rng, state.bg, state.seamless);

      if (mirror === "horizontal") {
        ctx.drawImage(off, 0, 0);
        ctx.save();
        ctx.translate(state.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(off, 0, 0);
        ctx.restore();
      } else if (mirror === "vertical") {
        ctx.drawImage(off, 0, 0);
        ctx.save();
        ctx.translate(0, state.height);
        ctx.scale(1, -1);
        ctx.drawImage(off, 0, 0);
        ctx.restore();
      } else if (mirror === "quad" || mirror === "kaleido") {
        // Draw top-left
        ctx.drawImage(off, 0, 0);
        // Top-right (mirror x)
        ctx.save(); ctx.translate(state.width, 0); ctx.scale(-1, 1); ctx.drawImage(off, 0, 0); ctx.restore();
        // Bottom-left (mirror y)
        ctx.save(); ctx.translate(0, state.height); ctx.scale(1, -1); ctx.drawImage(off, 0, 0); ctx.restore();
        // Bottom-right (mirror both)
        ctx.save(); ctx.translate(state.width, state.height); ctx.scale(-1, -1); ctx.drawImage(off, 0, 0); ctx.restore();
      }
    }
    ctx.restore();

    // Post-FX pixel operations
    const fx = state.postfx;
    if (fx.invert || fx.vignette > 0 || fx.grain > 0) {
      const img = ctx.getImageData(0, 0, state.width, state.height);
      const data = img.data;
      const cx = state.width / 2, cy = state.height / 2;
      const maxD = Math.hypot(cx, cy);
      const rng = makeRng(state.seed + 999);
      for (let y = 0; y < state.height; y++) {
        for (let x = 0; x < state.width; x++) {
          const i = (y * state.width + x) * 4;
          let r = data[i], g = data[i + 1], b = data[i + 2];
          if (fx.invert) { r = 255 - r; g = 255 - g; b = 255 - b; }
          if (fx.vignette > 0) {
            const d = Math.hypot(x - cx, y - cy) / maxD;
            const v = 1 - Math.max(0, (d - (1 - fx.vignette)) / fx.vignette) * fx.vignette;
            r *= v; g *= v; b *= v;
          }
          if (fx.grain > 0) {
            const n = (rng() - 0.5) * 255 * fx.grain;
            r += n; g += n; b += n;
          }
          data[i] = Math.max(0, Math.min(255, r));
          data[i + 1] = Math.max(0, Math.min(255, g));
          data[i + 2] = Math.max(0, Math.min(255, b));
        }
      }
      ctx.putImageData(img, 0, 0);
    }

    setRenderTime(performance.now() - t0);
  }; // end _unused

  // Fit canvas to stage
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => {
      if (!stageRef.current) return;
      const r = stageRef.current.getBoundingClientRect();
      const pad = 64;
      const sx = (r.width - pad) / state.width;
      const sy = (r.height - pad) / state.height;
      setScale(Math.min(sx, sy, 1));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [state.width, state.height]);

  const copySeed = () => {
    navigator.clipboard?.writeText(String(state.seed));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const exportPNG = (multiplier = 1) => {
    const src = canvasRef.current;
    if (multiplier === 1) {
      const url = src.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = url;
      a.download = `texture-${state.engine}-${state.seed}.png`;
      a.click();
      return;
    }
    const out = document.createElement("canvas");
    out.width = src.width * multiplier;
    out.height = src.height * multiplier;
    const octx = out.getContext("2d");
    octx.imageSmoothingEnabled = false;
    octx.drawImage(src, 0, 0, out.width, out.height);
    out.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `texture-${state.engine}-${state.seed}@${multiplier}x.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };

  const copyDataURI = async () => {
    const url = canvasRef.current.toDataURL("image/png");
    await navigator.clipboard?.writeText(url);
    flashCopy("uri");
  };

  const copyCSS = async () => {
    const url = canvasRef.current.toDataURL("image/png");
    const css = `background-image: url("${url}");\nbackground-size: ${state.width}px ${state.height}px;\nbackground-repeat: repeat;`;
    await navigator.clipboard?.writeText(css);
    flashCopy("css");
  };

  const copyJSON = async () => {
    const json = JSON.stringify({
      engine: state.engine, seed: state.seed, fg: state.fg, bg: state.bg,
      width: state.width, height: state.height, seamless: state.seamless,
      params: state.params[state.engine], postfx: state.postfx,
    }, null, 2);
    await navigator.clipboard?.writeText(json);
    flashCopy("json");
  };

  const shareURL = async () => {
    const compact = {
      engine: state.engine, seed: state.seed, fg: state.fg, bg: state.bg,
      width: state.width, height: state.height, seamless: state.seamless,
      params: { [state.engine]: state.params[state.engine] },
      postfx: state.postfx,
    };
    const hash = btoa(JSON.stringify(compact));
    const url = `${window.location.origin}${window.location.pathname}#s=${hash}`;
    window.history.replaceState(null, "", `#s=${hash}`);
    await navigator.clipboard?.writeText(url);
    setShareCopied(true);
    setTimeout(() => setShareCopied(false), 1500);
  };

  const [copyFlash, setCopyFlash] = useState(null);
  const [showHelp, setShowHelp] = useState(false);
  const flashCopy = (kind) => {
    setCopyFlash(kind);
    setTimeout(() => setCopyFlash(null), 1500);
  };

  // ─── Library ──────────────────────────────────
  const saveToLibrary = () => {
    const src = canvasRef.current;
    const thumb = document.createElement("canvas");
    thumb.width = 96; thumb.height = 96;
    const tctx = thumb.getContext("2d");
    const tScale = 96 / Math.max(src.width, src.height);
    const tw = src.width * tScale;
    const th = src.height * tScale;
    tctx.fillStyle = state.bg;
    tctx.fillRect(0, 0, 96, 96);
    tctx.drawImage(src, (96 - tw) / 2, (96 - th) / 2, tw, th);
    const entry = {
      id: Date.now(),
      name: `${ENGINES[state.engine].label} ${String(state.seed).padStart(4, "0")}`,
      thumb: thumb.toDataURL("image/png"),
      state: JSON.parse(JSON.stringify(state)),
    };
    const next = [entry, ...library].slice(0, 24);
    setLibrary(next);
    try { localStorage.setItem("tx-library", JSON.stringify(next)); } catch {}
  };

  const loadFromLibrary = (entry) => {
    skipUndo.current = false;
    setState(entry.state);
  };

  const deleteFromLibrary = (id) => {
    const next = library.filter((l) => l.id !== id);
    setLibrary(next);
    try { localStorage.setItem("tx-library", JSON.stringify(next)); } catch {}
  };

  // ─── Undo / redo ──────────────────────────────
  const prevStateRef = useRef(state);
  const isInitialMount = useRef(true);
  useEffect(() => {
    if (isInitialMount.current) {
      isInitialMount.current = false;
      prevStateRef.current = state;
      return;
    }
    if (skipUndo.current) {
      skipUndo.current = false;
      prevStateRef.current = state;
      return;
    }
    // Capture the previous state value BEFORE the updater runs
    // (React runs updater functions lazily — we'd see the mutated ref otherwise)
    const prevValue = prevStateRef.current;
    setUndoStack((u) => [...u, prevValue].slice(-40));
    setRedoStack([]);
    prevStateRef.current = state;
  }, [state]);

  const undo = () => {
    if (undoStack.length === 0) return;
    const prev = undoStack[undoStack.length - 1];
    skipUndo.current = true;
    setRedoStack((r) => [...r, state]);
    setUndoStack((u) => u.slice(0, -1));
    setState(prev);
  };
  const redo = () => {
    if (redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1];
    skipUndo.current = true;
    setUndoStack((u) => [...u, state]);
    setRedoStack((r) => r.slice(0, -1));
    setState(next);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT") return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveToLibrary(); return; }
      if (e.key === "?" || (e.shiftKey && e.key === "/")) { e.preventDefault(); setShowHelp((s) => !s); return; }
      if (e.key === "Escape") { setShowHelp(false); return; }
      if (e.code === "Space") { e.preventDefault(); randomize(); }
      else if (e.key === "e" || e.key === "E") exportPNG();
      else if (e.key === "t" || e.key === "T") setShowTile((s) => !s);
      else if (e.key === "i" || e.key === "I") invertColors();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, undoStack, redoStack, library]);

  const params = state.params[state.engine];

  return (
    <div className="app">
      {/* ─── Top bar ─── */}
      <header className="topbar">
        <div className="brand">
          <div className="logo-mark">
            <div className="lm-dot"></div>
            <div className="lm-dot"></div>
            <div className="lm-dot"></div>
            <div className="lm-dot"></div>
          </div>
          <div>
            <div className="brand-name">texture/maker</div>
            <div className="brand-sub">procedural pattern studio</div>
          </div>
        </div>
        <div className="topbar-right">
          <div className="meta-pill">
            <span className="meta-key">render</span>
            <span className="meta-val">{renderTime.toFixed(1)}ms</span>
          </div>
          <div className="meta-pill">
            <span className="meta-key">size</span>
            <span className="meta-val">{state.width}×{state.height}</span>
          </div>
          <div className="meta-pill">
            <span className="meta-key">seed</span>
            <span className="meta-val mono">{String(state.seed).padStart(6, "0").slice(-6)}</span>
          </div>
          <div className="btn-group">
            <button className="btn ghost icon-btn" onClick={undo} disabled={undoStack.length === 0} title="Undo (⌘Z)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6M21 17a8 8 0 00-14-5l-4 1"/></svg>
            </button>
            <button className="btn ghost icon-btn" onClick={redo} disabled={redoStack.length === 0} title="Redo (⇧⌘Z)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6M3 17a8 8 0 0114-5l4 1"/></svg>
            </button>
          </div>
          <button className="btn ghost icon-btn" onClick={() => setShowHelp(true)} title="How it works">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 015 0c0 1.5-2 2-2.5 3.5M12 17h.01"/></svg>
          </button>
          <button className="btn ghost" onClick={randomize} title="Randomize seed (Space)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>
            Randomize
          </button>
          <button className="btn ghost" onClick={shareURL} title="Copy share URL">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/></svg>
            {shareCopied ? "Link copied!" : "Share"}
          </button>
          <div className="export-wrap">
            <button className="btn primary export-btn" onClick={() => setShowExportMenu((s) => !s)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 3v12m0 0l-4-4m4 4l4-4M5 21h14"/></svg>
              Export
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ marginLeft: 2 }}><path d="M6 9l6 6 6-6"/></svg>
            </button>
            {showExportMenu && (
              <>
                <div className="export-overlay" onClick={() => setShowExportMenu(false)}></div>
                <div className="export-menu">
                  <div className="em-section-label">DOWNLOAD</div>
                  <button className="em-item" onClick={() => { exportPNG(1); setShowExportMenu(false); }}>
                    <span>PNG · 1×</span>
                    <span className="em-spec mono">{state.width}×{state.height}</span>
                  </button>
                  <button className="em-item" onClick={() => { exportPNG(2); setShowExportMenu(false); }}>
                    <span>PNG · 2×</span>
                    <span className="em-spec mono">{state.width * 2}×{state.height * 2}</span>
                  </button>
                  <button className="em-item" onClick={() => { exportPNG(4); setShowExportMenu(false); }}>
                    <span>PNG · 4×</span>
                    <span className="em-spec mono">{state.width * 4}×{state.height * 4}</span>
                  </button>
                  <div className="em-section-label">COPY</div>
                  <button className="em-item" onClick={copyCSS}>
                    <span>CSS background</span>
                    <span className="em-spec mono">{copyFlash === "css" ? "✓ copied" : "css"}</span>
                  </button>
                  <button className="em-item" onClick={copyDataURI}>
                    <span>Data URI</span>
                    <span className="em-spec mono">{copyFlash === "uri" ? "✓ copied" : "uri"}</span>
                  </button>
                  <button className="em-item" onClick={copyJSON}>
                    <span>JSON state</span>
                    <span className="em-spec mono">{copyFlash === "json" ? "✓ copied" : "json"}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="main">
        {/* ─── Stage ─── */}
        <div className="stage" ref={stageRef} style={{ background: state.bg === "#f4f1ea" ? "#ebe7dd" : "#1a1816" }}>
          <div className="stage-grid"></div>
          <div
            className="canvas-wrap"
            style={
              showTile
                ? { position: "absolute", left: "-99999px", top: 0 }
                : { transform: `scale(${scale})`, filter: state.postfx.blur > 0 ? `blur(${state.postfx.blur}px)` : "none" }
            }
          >
            <canvas ref={canvasRef}></canvas>
          </div>
          {showTile && (
            <TilePreview canvas={canvasRef.current} stageRef={stageRef} blur={state.postfx.blur} seamless={state.seamless} stateKey={`${state.engine}-${state.seed}-${state.width}-${state.height}-${state.fg}-${state.bg}-${state.seamless}-${JSON.stringify(state.params[state.engine])}-${JSON.stringify(state.postfx)}`} />
          )}
          <div className="stage-corner tl">
            <div className="corner-line h"></div>
            <div className="corner-line v"></div>
          </div>
          <div className="stage-corner tr">
            <div className="corner-line h"></div>
            <div className="corner-line v"></div>
          </div>
          <div className="stage-corner bl">
            <div className="corner-line h"></div>
            <div className="corner-line v"></div>
          </div>
          <div className="stage-corner br">
            <div className="corner-line h"></div>
            <div className="corner-line v"></div>
          </div>

          {/* Stage toolbar */}
          <div className="stage-toolbar">
            <button className={"st-btn" + (showTile ? " active" : "")} onClick={() => setShowTile((s) => !s)} title="Tile preview (T)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/></svg>
            </button>
            <button className="st-btn" onClick={invertColors} title="Invert colors (I)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 3v18" fill="currentColor"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>
            </button>
            <button className="st-btn" onClick={copySeed} title="Copy seed">
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12l5 5L20 7"/></svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15V5a1 1 0 011-1h10"/></svg>
              )}
            </button>
          </div>

          <div className="stage-footer">
            <span className="mono">{engine.label.toUpperCase()}</span>
            <span className="dot-sep">·</span>
            <span className="mono">{state.width} × {state.height} PX</span>
            <span className="dot-sep">·</span>
            <span className="mono">SCALE {(scale * 100).toFixed(0)}%</span>
            <span className="dot-sep">·</span>
            <span className={"mono" + (state.seamless ? " accent" : "")}>{state.seamless ? "SEAMLESS" : "RAW"}</span>
            {state.postfx.mirror !== "none" && (<><span className="dot-sep">·</span><span className="mono accent">MIRROR {state.postfx.mirror.toUpperCase()}</span></>)}
            {state.postfx.invert && (<><span className="dot-sep">·</span><span className="mono accent">INVERTED</span></>)}
          </div>

          <VariationsStrip state={state} onPick={(seed) => setSeed(seed)} engine={engine} />
        </div>

        {/* ─── Controls ─── */}
        <aside className="panel">
          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">01</span>
              <span className="section-title">Engine</span>
            </div>
            <div className="engine-grid">
              {Object.entries(ENGINES).map(([key, e]) => (
                <button
                  key={key}
                  className={"engine-btn" + (state.engine === key ? " active" : "")}
                  onClick={() => setEngine(key)}
                >
                  <EngineIcon kind={key} />
                  <span>{e.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">02</span>
              <span className="section-title">Parameters</span>
              <span className="section-sub">{engine.label}</span>
            </div>
            <div className="sliders">
              {Object.entries(engine.params).map(([key, def]) => (
                <Slider
                  key={key}
                  label={def.label}
                  value={params[key]}
                  min={def.min}
                  max={def.max}
                  step={def.step}
                  onChange={(v) => updateParam(key, v)}
                />
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">03</span>
              <span className="section-title">Canvas</span>
            </div>
            <div className="aspect-row">
              {ASPECT_PRESETS.map((a) => {
                const active = state.width === a.w && state.height === a.h;
                return (
                  <button key={a.label} className={"aspect-btn" + (active ? " active" : "")} onClick={() => setAspect(a.w, a.h)}>
                    <span className="aspect-shape" style={{ aspectRatio: `${a.w}/${a.h}` }}></span>
                    <span className="aspect-label mono">{a.label}</span>
                  </button>
                );
              })}
            </div>
            <div className="sliders">
              <Slider label="Width" value={state.width} min={200} max={6000} step={10} onChange={(v) => setColor("width", Math.round(v))} suffix="px" />
              <Slider label="Height" value={state.height} min={200} max={6000} step={10} onChange={(v) => setColor("height", Math.round(v))} suffix="px" />
              <Slider label="Seed" value={state.seed} min={1} max={99999} step={1} onChange={(v) => setSeed(Math.round(v))} />
            </div>
            <label className="toggle-row" style={{ marginTop: 14 }} onClick={toggleSeamless}>
              <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <span className="toggle-label">Seamless tiling</span>
                <span style={{ fontSize: 9, color: "#8a857c", letterSpacing: "0.04em" }} className="mono">
                  {state.seamless ? "EDGES WRAP · REPEATS CLEANLY" : "RAW · MAY SHOW SEAMS"}
                </span>
              </span>
              <button className={"toggle-pill" + (state.seamless ? " on" : "")} onClick={(e) => { e.stopPropagation(); toggleSeamless(); }}>
                <span className="toggle-knob"></span>
              </button>
            </label>
            {history.length > 1 && (
              <div className="history-row">
                <span className="history-label mono">RECENT</span>
                <div className="history-chips">
                  {history.map((s, i) => (
                    <button key={i} className={"hist-chip mono" + (s === state.seed ? " active" : "")} onClick={() => setSeed(s)}>
                      {String(s).padStart(5, "0")}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">04</span>
              <span className="section-title">Palette</span>
              <button className="section-action mono" onClick={invertColors}>SWAP</button>
            </div>
            <div className="color-row">
              <label className="color-picker">
                <span className="color-label">FG</span>
                <input type="color" value={state.fg} onChange={(e) => setColor("fg", e.target.value)} />
                <span className="color-hex mono">{state.fg.toUpperCase()}</span>
              </label>
              <label className="color-picker">
                <span className="color-label">BG</span>
                <input type="color" value={state.bg} onChange={(e) => setColor("bg", e.target.value)} />
                <span className="color-hex mono">{state.bg.toUpperCase()}</span>
              </label>
            </div>
            <div className="swatch-row">
              {COLOR_SWATCHES.map((sw, i) => (
                <button key={i} className="swatch" onClick={() => applySwatch(sw)} title={sw.name}>
                  <span className="sw-bg" style={{ background: sw.bg }}></span>
                  <span className="sw-fg" style={{ background: sw.fg }}></span>
                </button>
              ))}
            </div>
          </div>

          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">05</span>
              <span className="section-title">Post-FX</span>
              <button className="section-action mono" onClick={resetPostFX}>RESET</button>
            </div>
            <div className="mirror-row">
              <span className="mirror-label mono">SYMMETRY</span>
              <div className="mirror-seg">
                {MIRROR_MODES.map((m) => (
                  <button key={m.value} className={"mirror-btn" + (state.postfx.mirror === m.value ? " active" : "")} onClick={() => setPostFX("mirror", m.value)}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="sliders" style={{ marginTop: 12 }}>
              <Slider label="Rotation" value={state.postfx.rotation} min={0} max={360} step={1} onChange={(v) => setPostFX("rotation", Math.round(v))} suffix="°" />
              <Slider label="Vignette" value={state.postfx.vignette} min={0} max={1} step={0.01} onChange={(v) => setPostFX("vignette", v)} />
              <Slider label="Grain" value={state.postfx.grain} min={0} max={1} step={0.01} onChange={(v) => setPostFX("grain", v)} />
              <Slider label="Blur" value={state.postfx.blur} min={0} max={20} step={0.5} onChange={(v) => setPostFX("blur", v)} suffix="px" />
            </div>
            <label className="toggle-row">
              <span className="toggle-label">Invert colors</span>
              <button className={"toggle-pill" + (state.postfx.invert ? " on" : "")} onClick={() => setPostFX("invert", !state.postfx.invert)}>
                <span className="toggle-knob"></span>
              </button>
            </label>
          </div>

          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">06</span>
              <span className="section-title">Library</span>
              <button className="section-action mono" onClick={saveToLibrary} title="Save current (⌘S)">+ SAVE</button>
            </div>
            {library.length === 0 ? (
              <div className="lib-empty">
                <div className="lib-empty-icon">
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4"><path d="M3 7h18M3 12h18M3 17h18"/></svg>
                </div>
                <div className="lib-empty-text">No saved textures yet</div>
                <div className="lib-empty-sub">Press <kbd>⌘S</kbd> to save the current one</div>
              </div>
            ) : (
              <div className="lib-grid">
                {library.map((entry) => (
                  <div key={entry.id} className="lib-item" onClick={() => loadFromLibrary(entry)}>
                    <img src={entry.thumb} alt={entry.name} className="lib-thumb" />
                    <div className="lib-meta">
                      <span className="lib-name mono">{entry.name}</span>
                      <button className="lib-del" onClick={(e) => { e.stopPropagation(); deleteFromLibrary(entry.id); }} title="Delete">
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M6 6l12 12M18 6L6 18"/></svg>
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="panel-section">
            <div className="section-head">
              <span className="section-num">07</span>
              <span className="section-title">Presets</span>
            </div>
            <div className="preset-grid">
              {PRESETS.map((p, i) => (
                <button key={i} className="preset-btn" onClick={() => applyPreset(p)}>
                  <PresetThumb preset={p} />
                  <span>{p.name}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="panel-footer">
            <div className="kbd-grid">
              <span className="kbd-row"><kbd>Space</kbd><span>Randomize</span></span>
              <span className="kbd-row"><kbd>E</kbd><span>Export</span></span>
              <span className="kbd-row"><kbd>T</kbd><span>Tile</span></span>
              <span className="kbd-row"><kbd>I</kbd><span>Invert</span></span>
              <span className="kbd-row"><kbd>⌘S</kbd><span>Save</span></span>
              <span className="kbd-row"><kbd>⌘Z</kbd><span>Undo</span></span>
              <span className="kbd-row"><kbd>?</kbd><span>Help</span></span>
            </div>
          </div>
        </aside>
      </div>
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function EngineIcon({ kind }) {
  const stroke = "currentColor";
  const common = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke, strokeWidth: 1.4, strokeLinecap: "round" };
  if (kind === "dots") return <svg {...common}>{[4,12,20].map(y=>[4,12,20].map(x=><circle key={x+'-'+y} cx={x} cy={y} r="1.2" fill={stroke} stroke="none"/>))}</svg>;
  if (kind === "lines") return <svg {...common}><path d="M2 18L18 2M6 22L22 6M-2 14L14 -2"/></svg>;
  if (kind === "grid") return <svg {...common}><path d="M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18"/></svg>;
  if (kind === "noise") return <svg {...common}><path d="M3 8c2 0 2 2 4 2s2-3 4-3 2 2 4 2 2-1 4-1"/><path d="M3 13c2 0 2 1 4 1s2-2 4-2 2 1 4 1 2-1 4-1"/><path d="M3 18c2 0 2-1 4-1s2 1 4 1 2-2 4-2 2 1 4 1"/></svg>;
  if (kind === "voronoi") return <svg {...common}><path d="M3 9l5-6 7 2 6 6-3 8-9 2-6-5z"/><path d="M8 3l2 7-5 4M15 5l-5 5 3 7M21 11l-8-1M12 22l1-10"/></svg>;
  if (kind === "scatter") return <svg {...common}><circle cx="6" cy="7" r="1.5" fill={stroke} stroke="none"/><circle cx="17" cy="9" r="2" fill={stroke} stroke="none"/><circle cx="9" cy="16" r="1" fill={stroke} stroke="none"/><circle cx="18" cy="18" r="1.5" fill={stroke} stroke="none"/><circle cx="4" cy="14" r="0.8" fill={stroke} stroke="none"/><circle cx="13" cy="4" r="0.8" fill={stroke} stroke="none"/></svg>;
  if (kind === "waves") return <svg {...common}><path d="M2 7c3-3 5 3 8 0s5 3 8 0 4 0 4 0"/><path d="M2 13c3-3 5 3 8 0s5 3 8 0 4 0 4 0"/><path d="M2 19c3-3 5 3 8 0s5 3 8 0 4 0 4 0"/></svg>;
  if (kind === "truchet") return <svg {...common}><path d="M3 3a6 6 0 016 6M21 21a6 6 0 01-6-6M21 3a6 6 0 00-6 6M3 21a6 6 0 006-6"/></svg>;
  if (kind === "flow") return <svg {...common}><path d="M3 18c2-2 4-6 6-6s4 4 6 4 4-4 6-6"/><path d="M3 13c2-2 4-6 6-6s4 4 6 4 4-4 6-6" opacity="0.5"/><path d="M3 8c2-2 4-6 6-6" opacity="0.3"/></svg>;
  if (kind === "hex") return <svg {...common}><path d="M9 3l6 0 3 5-3 5-6 0-3-5z"/><path d="M3 13l3 5 3 0M21 13l-3 5-3 0M9 18l3 4 3-4" opacity="0.7"/></svg>;
  if (kind === "bricks") return <svg {...common}><path d="M3 6h6M9 6h6M15 6h6M0 11h3M3 11h6M9 11h6M15 11h6M21 11h3M3 16h6M9 16h6M15 16h6M0 21h3M3 21h6M9 21h6M15 21h6M21 21h3"/></svg>;
  if (kind === "rings") return <svg {...common}><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="9"/></svg>;
  return null;
}

function PresetThumb({ preset }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    c.width = 96; c.height = 96;
    const ctx = c.getContext("2d");
    ctx.fillStyle = preset.bg;
    ctx.fillRect(0, 0, 96, 96);
    const rng = makeRng(7);
    const params = { ...Object.fromEntries(Object.entries(ENGINES[preset.engine].params).map(([k, v]) => [k, v.default])), ...preset.patch };
    ENGINES[preset.engine].render(ctx, 96, 96, params, preset.fg, rng, preset.bg, true);
  }, [preset]);
  return <canvas ref={ref} className="preset-thumb-canvas"></canvas>;
}

function TilePreview({ canvas, stageRef, blur, seamless, stateKey }) {
  const [scale, setScale] = useState(1);
  const [imgSrc, setImgSrc] = useState("");
  useEffect(() => {
    if (!stageRef.current || !canvas) return;
    const r = stageRef.current.getBoundingClientRect();
    const pad = 80;
    const tileW = canvas.width * 3;
    const tileH = canvas.height * 3;
    const sx = (r.width - pad) / tileW;
    const sy = (r.height - pad) / tileH;
    setScale(Math.min(sx, sy));
    // Pull image from canvas (after a tick so the render effect has committed)
    const id = setTimeout(() => {
      try { setImgSrc(canvas.toDataURL()); } catch {}
    }, 80);
    return () => clearTimeout(id);
  }, [canvas, stageRef, stateKey]);
  if (!canvas || !imgSrc) return null;
  const seamColor = seamless ? "rgba(44,74,62,0.55)" : "rgba(196,89,58,0.6)";
  const seamStyleH = { background: `repeating-linear-gradient(to right, ${seamColor} 0 4px, transparent 4px 8px)` };
  const seamStyleV = { background: `repeating-linear-gradient(to bottom, ${seamColor} 0 4px, transparent 4px 8px)` };
  return (
    <>
      <div className="tile-preview" style={{ transform: `scale(${scale})`, filter: blur > 0 ? `blur(${blur}px)` : "none" }}>
        <div
          className="tile-grid"
          style={{
            width: canvas.width * 3,
            height: canvas.height * 3,
            backgroundImage: `url(${imgSrc})`,
            backgroundSize: `${canvas.width}px ${canvas.height}px`,
            backgroundRepeat: "repeat",
          }}
        >
          <div className="tile-seam-h" style={{ top: `${100/3}%`, ...seamStyleH }}></div>
          <div className="tile-seam-h" style={{ top: `${200/3}%`, ...seamStyleH }}></div>
          <div className="tile-seam-v" style={{ left: `${100/3}%`, ...seamStyleV }}></div>
          <div className="tile-seam-v" style={{ left: `${200/3}%`, ...seamStyleV }}></div>
        </div>
      </div>
      <div className={"tile-verdict mono" + (seamless ? " ok" : " warn")}>
        {seamless ? "✓ SEAMLESS — TILES CLEANLY" : "⚠ SEAMS VISIBLE — ENABLE SEAMLESS TILING"}
      </div>
    </>
  );
}

function VariationsStrip({ state, onPick, engine }) {
  const seeds = useMemo(() => {
    const base = state.seed;
    const out = [];
    for (let i = -2; i <= 2; i++) {
      const s = ((base + i * 137 - 1 + 99999) % 99999) + 1;
      out.push(s);
    }
    return out;
  }, [state.seed]);

  return (
    <div className="var-strip">
      <span className="var-label mono">VARIATIONS</span>
      <div className="var-thumbs">
        {seeds.map((s, i) => (
          <VarThumb
            key={i}
            seed={s}
            state={state}
            engine={engine}
            active={s === state.seed}
            onClick={() => onPick(s)}
          />
        ))}
      </div>
      <button className="var-shuffle mono" onClick={() => onPick(Math.floor(Math.random() * 99999))} title="New random seed">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5"/></svg>
      </button>
    </div>
  );
}

function VarThumb({ seed, state, engine, active, onClick }) {
  const ref = useRef(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const thumbSize = 48;
    c.width = thumbSize; c.height = thumbSize;
    const ctx = c.getContext("2d");
    // Render at the texture's natural aspect ratio cropped to a square, then draw to thumb
    const renderW = Math.min(state.width, 400);
    const renderH = Math.round(renderW * state.height / state.width);
    const off = document.createElement("canvas");
    off.width = renderW; off.height = renderH;
    const octx = off.getContext("2d");
    octx.fillStyle = state.bg;
    octx.fillRect(0, 0, renderW, renderH);
    const rng = makeRng(seed);
    engine.render(octx, renderW, renderH, state.params[state.engine], state.fg, rng, state.bg, state.seamless);
    // Center-crop to square for the thumb
    const side = Math.min(renderW, renderH);
    const sx = (renderW - side) / 2;
    const sy = (renderH - side) / 2;
    ctx.drawImage(off, sx, sy, side, side, 0, 0, thumbSize, thumbSize);
  }, [seed, state, engine]);
  return (
    <button className={"var-thumb" + (active ? " active" : "")} onClick={onClick} title={`Seed ${seed}`}>
      <canvas ref={ref} />
      <span className="var-thumb-seed mono">{String(seed).padStart(5, "0").slice(-5)}</span>
    </button>
  );
}

function HelpOverlay({ onClose }) {
  const sections = [
    {
      num: "01",
      title: "Engine",
      desc: "The texture algorithm. Each one has its own visual language and its own set of parameters.",
      items: [
        ["Dots", "Scattered round marks. Halftone, stipple, pointillism."],
        ["Hatching", "Parallel lines with optional cross-hatching. Sketchy, fabric-like."],
        ["Grid", "Mesh of cells with optional jitter, breakage, diagonals."],
        ["Noise", "Smooth procedural noise (clouds, fog, marble, graphite)."],
        ["Voronoi", "Cellular pattern — stone, leather, scales, foam."],
        ["Scatter", "Random shapes: circles, squares, triangles, lines."],
        ["Waves", "Sinusoidal lines — ripples, contour maps."],
        ["Truchet", "Classic tile patterns from rotating arcs or diagonals."],
        ["Flow", "Particle trails following a curl noise field — smoky."],
        ["Hex", "Hexagonal grid (honeycomb) with fills and breaks."],
        ["Bricks", "Staggered rectangles — masonry, woven, mosaic."],
        ["Rings", "Concentric circles from random origins — ripples, topo."],
      ],
    },
    {
      num: "02",
      title: "Parameters",
      desc: "Sliders specific to the active engine. Drag to change, or click the number to type an exact value.",
    },
    {
      num: "03",
      title: "Canvas",
      desc: "Output dimensions and randomness seed.",
      items: [
        ["Aspect presets", "1:1, 4:3, 3:2, 16:9, 9:16, A4 — one click sizing."],
        ["Width / Height", "Pixel dimensions of the final exported texture."],
        ["Seed", "Random number that drives all jitter. Same seed = same texture."],
        ["Seamless tiling", "Wraps the pattern across all four edges so the export repeats with no visible seam — essential for backgrounds. Toggle the tile preview (T) to verify."],
        ["Recent", "Last 8 seeds you've used — click any to revisit it."],
      ],
    },
    {
      num: "04",
      title: "Palette",
      desc: "Foreground and background colors. Click any color picker for a custom hex, or use the swatch row for curated combos.",
      items: [
        ["SWAP", "Flips FG ↔ BG instantly."],
        ["Swatches", "Eight pre-made color pairs to jump-start a vibe."],
      ],
    },
    {
      num: "05",
      title: "Post-FX",
      desc: "Effects applied AFTER the engine renders. Stackable.",
      items: [
        ["Symmetry", "Off / H / V / Quad / Kaleido — mirrors the texture for symmetric patterns."],
        ["Rotation", "Rotates the rendered texture in place."],
        ["Vignette", "Darkens the edges inward."],
        ["Grain", "Adds film-grain noise on top."],
        ["Blur", "CSS blur applied to preview (does not affect export)."],
        ["Invert", "Negates all pixel colors."],
        ["RESET", "Returns all Post-FX to defaults."],
      ],
    },
    {
      num: "06",
      title: "Library",
      desc: "Your saved textures, persisted in your browser. Click the SAVE button (or press ⌘S) to snapshot the current texture into the gallery. Click any thumb to recall it; hover and click ✕ to delete.",
    },
    {
      num: "07",
      title: "Presets",
      desc: "Curated starting points. Each preset jumps to a specific engine + parameter combination + color pair.",
    },
  ];

  const stage = [
    ["Tile preview", "Repeats your texture in a 3×3 grid and grades it: green seams + a \u2018tiles cleanly\u2019 badge when Seamless tiling is on, amber when raw. Press T."],
    ["Invert palette", "Flips FG ↔ BG (same as the SWAP button)."],
    ["Copy seed", "Copies the current seed number to your clipboard."],
    ["Variations strip", "Bottom-right of the stage. Shows 5 nearby seeds as thumbnails. Click any to jump to that seed. The shuffle button generates a fresh random seed."],
  ];

  const topbar = [
    ["Undo / Redo", "Step backward or forward through up to 40 changes. ⌘Z and ⇧⌘Z."],
    ["Randomize", "New random seed. Keyboard: Space."],
    ["Share", "Copies a URL that encodes the entire current state. Opening that URL recreates the exact texture."],
    ["Export menu", "PNG at 1×, 2×, 4× resolution; copy as CSS background snippet, data URI, or JSON state."],
  ];

  const shortcuts = [
    ["Space", "Randomize seed"],
    ["E", "Export PNG"],
    ["T", "Toggle tile preview"],
    ["I", "Invert palette (swap FG/BG)"],
    ["⌘S", "Save to library"],
    ["⌘Z", "Undo"],
    ["⇧⌘Z", "Redo"],
  ];

  return (
    <div className="help-backdrop" onClick={onClose}>
      <div className="help-modal" onClick={(e) => e.stopPropagation()}>
        <div className="help-head">
          <div>
            <div className="help-eyebrow mono">HOW IT WORKS</div>
            <div className="help-title">texture/maker · field guide</div>
          </div>
          <button className="help-close" onClick={onClose}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>

        <div className="help-body">
          <p className="help-intro">
            Pick an engine, tweak its sliders, dial in a color pair. Layer Post-FX, save snapshots you like, and export when you're done. Everything updates live.
          </p>

          <div className="help-section">
            <div className="help-section-title">The right panel</div>
            {sections.map((s) => (
              <div key={s.num} className="help-block">
                <div className="help-block-head">
                  <span className="help-block-num mono">{s.num}</span>
                  <span className="help-block-title">{s.title}</span>
                </div>
                <div className="help-block-desc">{s.desc}</div>
                {s.items && (
                  <div className="help-list">
                    {s.items.map(([k, v]) => (
                      <div key={k} className="help-item">
                        <span className="help-item-key mono">{k}</span>
                        <span className="help-item-val">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className="help-section">
            <div className="help-section-title">The stage (preview area)</div>
            <div className="help-list">
              {stage.map(([k, v]) => (
                <div key={k} className="help-item">
                  <span className="help-item-key mono">{k}</span>
                  <span className="help-item-val">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="help-section">
            <div className="help-section-title">The topbar</div>
            <div className="help-list">
              {topbar.map(([k, v]) => (
                <div key={k} className="help-item">
                  <span className="help-item-key mono">{k}</span>
                  <span className="help-item-val">{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="help-section">
            <div className="help-section-title">Keyboard shortcuts</div>
            <div className="help-kbd-grid">
              {shortcuts.map(([k, v]) => (
                <div key={k} className="help-kbd-row">
                  <kbd className="mono">{k}</kbd>
                  <span>{v}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="help-footer">
            <span className="mono">·</span>
            <span>Click outside this card or hit the × to dismiss.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
