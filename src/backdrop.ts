// The website's backdrop (site.css's body::before glows and body::after hero art) drawn once
// into a bitmap. WebKitGTK without GPU compositing (NVIDIA on X11) otherwise repaints it in
// every scrolled frame: six large gradients and a blurred SVG cost about half of each frame.
// The pseudo-elements stay the source: their computed style is read and painted the same
// way, and anything that cannot be read or drawn leaves them as they are.

type Glow = { rx:number; ry:number; x:number; y:number; color:string; stop:number };

const root = document.documentElement;
let current = '';
let pending = 0;
let generation = 0;

function length(value:string, of:number) { return value.endsWith('%') ? parseFloat(value) / 100 * of : parseFloat(value); }

// "radial-gradient(928px 576px at 7% 416px, rgba(…), rgba(0, 0, 0, 0) 70%)", one per glow.
function glows(image:string, width:number): Glow[] | null {
  const found:Glow[] = [];
  const pattern = /radial-gradient\(([\d.]+)px ([\d.]+)px at ([\d.]+(?:px|%)) ([\d.]+(?:px|%)), (rgba?\([^)]*\))(?: 0%)?, rgba\(0, 0, 0, 0\) ([\d.]+)%\)/g;
  for (const m of image.matchAll(pattern)) found.push({ rx:+m[1], ry:+m[2], x:length(m[3],width), y:parseFloat(m[4]), color:m[5], stop:+m[6]/100 });
  return found.length && found.length === (image.match(/radial-gradient/g) ?? []).length ? found : null;
}

// The glow's own colour at no alpha: canvas gradients blend unpremultiplied, so fading to
// transparent black would darken the edge that CSS fades cleanly.
function clear(color:string) { return color.replace(/^rgba?\(([^,]+),([^,]+),([^,)]+).*$/, 'rgba($1,$2,$3,0)'); }

// Three box blurs approximate a Gaussian of this standard deviation (premultiplied pixels).
function boxes(sigma:number) {
  const ideal = Math.sqrt(4 * sigma * sigma + 1), low = Math.floor(ideal) % 2 ? Math.floor(ideal) : Math.floor(ideal) - 1;
  const lows = Math.round((12 * sigma * sigma - 3 * low * low - 12 * low - 9) / (-4 * low - 4));
  return [0, 1, 2].map(i => ((i < lows ? low : low + 2) - 1) / 2);
}
function pass(from:Float32Array, to:Float32Array, w:number, h:number, r:number, horizontal:boolean) {
  const lines = horizontal ? h : w, length = horizontal ? w : h, stride = horizontal ? 4 : w * 4, scale = 1 / (2 * r + 1);
  for (let line = 0; line < lines; line++) {
    const start = horizontal ? line * w * 4 : line * 4;
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let i = -r; i <= r; i++) sum += from[start + Math.min(length - 1, Math.max(0, i)) * stride + c];
      for (let i = 0; i < length; i++) {
        to[start + i * stride + c] = sum * scale;
        sum += from[start + Math.min(length - 1, i + r + 1) * stride + c] - from[start + Math.max(0, i - r) * stride + c];
      }
    }
  }
}
// CSS blur() then saturate(), as the element's filter applies them.
function soften(data:ImageData, sigma:number, saturation:number) {
  const { width:w, height:h, data:px } = data;
  const a = new Float32Array(px.length), b = new Float32Array(px.length);
  for (let i = 0; i < px.length; i += 4) { const alpha = px[i + 3] / 255; a[i] = px[i] * alpha; a[i + 1] = px[i + 1] * alpha; a[i + 2] = px[i + 2] * alpha; a[i + 3] = px[i + 3]; }
  for (const r of boxes(sigma)) if (r > 0) { pass(a, b, w, h, r, true); pass(b, a, w, h, r, false); }
  const s = saturation, m = [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s, 0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s];
  for (let i = 0; i < px.length; i += 4) {
    const alpha = a[i + 3]; if (alpha <= 0) { px[i + 3] = 0; continue; }
    const r = a[i] / alpha * 255, g = a[i + 1] / alpha * 255, bl = a[i + 2] / alpha * 255;
    px[i] = m[0] * r + m[1] * g + m[2] * bl; px[i + 1] = m[3] * r + m[4] * g + m[5] * bl; px[i + 2] = m[6] * r + m[7] * g + m[8] * bl; px[i + 3] = alpha;
  }
  return data;
}

async function draw() {
  const mine = ++generation;
  delete root.dataset.backdrop;
  const body = document.body, width = body.clientWidth, height = innerHeight, scale = devicePixelRatio || 1;
  const before = getComputedStyle(body, '::before'), after = getComputedStyle(body, '::after');
  const tile = parseFloat(before.backgroundSize.split(' ')[1] ?? '');
  const list = glows(before.backgroundImage, width);
  const art = after.display === 'none' ? null : after.backgroundImage.match(/^url\("?(.*?)"?\)$/)?.[1];
  if (!list || !(tile > 0) || (after.display !== 'none' && !art)) return;
  const left = parseFloat(after.left), top = parseFloat(after.top), boxWidth = parseFloat(after.width);
  const opacity = +after.opacity, glowAlpha = +before.opacity;
  const filter = after.filter.match(/^blur\(([\d.]+)px\)(?: saturate\(([\d.]+)\))?$/);
  if (after.filter !== 'none' && !filter) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale); canvas.height = Math.round(height * scale);
  const context = canvas.getContext('2d');
  if (!context) return;
  context.scale(scale, scale);
  context.globalAlpha = glowAlpha;
  for (let y = 0; y < height; y += tile) for (const glow of list) {
    context.save();
    context.translate(glow.x, y + glow.y);
    context.scale(1, glow.ry / glow.rx);
    const gradient = context.createRadialGradient(0, 0, 0, 0, 0, glow.rx);
    gradient.addColorStop(0, glow.color); gradient.addColorStop(glow.stop, clear(glow.color)); gradient.addColorStop(1, clear(glow.color));
    context.fillStyle = gradient;
    context.fillRect(-glow.rx, -glow.rx, glow.rx * 2, glow.rx * 2);
    context.restore();
  }
  if (art) {
    const image = new Image(); image.src = art;
    try { await image.decode(); } catch { return; }
    if (mine !== generation) return;
    const step = boxWidth * image.naturalHeight / image.naturalWidth;
    if (!(boxWidth > 0 && step > 0) || Number.isNaN(left + top)) return;
    // The box clips the tiles and the blur then reaches past it, as the element's filter does.
    // A quarter of the size is enough for a blur this wide, and quick to blur by hand: canvas
    // filters are missing in WebKitGTK.
    const sigma = filter ? +filter[1] : 0, saturation = filter?.[2] ? +filter[2] : 1, small = sigma >= 8 ? 0.25 : 1;
    const layer = document.createElement('canvas');
    layer.width = Math.ceil(width * small); layer.height = Math.ceil(height * small);
    const tiles = layer.getContext('2d', { willReadFrequently:true })!;
    tiles.scale(small, small);
    tiles.beginPath(); tiles.rect(left, top, boxWidth, height - top); tiles.clip();
    for (let y = top; y < height; y += step) tiles.drawImage(image, left, y, boxWidth, step);
    if (sigma > 0 || saturation !== 1) {
      tiles.setTransform(1, 0, 0, 1, 0, 0);
      tiles.putImageData(soften(tiles.getImageData(0, 0, layer.width, layer.height), sigma * small, saturation), 0, 0);
    }
    context.globalAlpha = opacity;
    context.imageSmoothingQuality = 'high';
    context.drawImage(layer, 0, 0, layer.width / small, layer.height / small);
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
  if (!blob || mine !== generation) return;
  const previous = current;
  current = URL.createObjectURL(blob);
  root.style.setProperty('--desktop-backdrop', `url("${current}")`);
  root.dataset.backdrop = '';
  if (previous) URL.revokeObjectURL(previous);
}

function schedule() { clearTimeout(pending); pending = window.setTimeout(() => { void draw(); }, 120); }

export function startBackdrop() {
  void draw();
  addEventListener('resize', schedule);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  new MutationObserver(schedule).observe(root, { attributes:true, attributeFilter:['data-theme'] });
}
