// The website's backdrop (site.css's body::before glows and body::after hero art, both drawn
// from bitmaps already soft, the art with a masked top edge) drawn once into a bitmap that
// scrolls with the page. WebKitGTK without GPU compositing (NVIDIA on X11) otherwise repaints
// them in every scrolled frame: six large images and the art, about half of each frame. The
// pseudo-elements stay the source: their computed style is read and painted the same way, and
// anything that cannot be read or drawn leaves them be. Everything in it is soft, so a quarter
// of the resolution looks the same and stays small.

type Layer = { url:string; x:string; width:number; height:number };

const root = document.documentElement;
const SCALE = 0.25;
// Drawn this far below the page, so that a longer view seldom needs a new bitmap.
const HEADROOM = 1600;
let current = '';
let drawn = { key:'', height:0 };
let pending = 0;
let generation = 0;

// A computed list ("a, calc(1% + max(0px, 2px)), b") split at its top-level commas.
function items(list:string) {
  const out:string[] = []; let depth = 0, start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '(') depth++; else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { out.push(list.slice(start, i).trim()); start = i + 1; }
  }
  out.push(list.slice(start).trim());
  return out;
}

// The glows: one url() each, tiled down the page at its size, placed across by a
// background-position-x such as "calc(7% - 605.44px + 0.86 * max(0px, 50% - 16px))".
function layers(before:CSSStyleDeclaration): Layer[] | null {
  const urls = items(before.backgroundImage).map(u => u.match(/^url\("?(.*?)"?\)$/)?.[1]);
  const xs = items(before.backgroundPositionX), sizes = items(before.backgroundSize);
  if (!urls.length || urls.some(u => !u) || xs.length !== urls.length || sizes.length !== urls.length) return null;
  const found = urls.map((url, i) => { const [w, h] = sizes[i].split(' ').map(parseFloat); return { url:url!, x:xs[i], width:w, height:h }; });
  return found.every(l => l.width > 0 && l.height > 0) ? found : null;
}

// A background position's percentages take the image's size off the box: the engine resolves
// the expression as an element's left in a box of that width. A box narrower than the image
// has a negative one, where the expressions site.css uses are linear (no art-side percentage).
function across(x:string, room:number) {
  const box = document.createElement('div'), probe = document.createElement('div');
  box.style.cssText = 'position:absolute;visibility:hidden;top:0;left:0;height:0';
  probe.style.cssText = 'position:absolute';
  probe.style.left = x;
  box.append(probe); document.body.append(box);
  const at = (width:number) => { box.style.width = `${width}px`; return parseFloat(getComputedStyle(probe).left); };
  const value = room >= 0 ? at(room) : at(0) + (at(1) - at(0)) * room;
  box.remove();
  return value;
}

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
// CSS blur() then saturate(), as the element's filter applies them; canvas filters are
// missing in WebKitGTK.
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

// The pseudo-elements' computed style, read with them shown for that moment only: style
// and layout run for the read, nothing is painted in between.
function read() {
  const shown = root.hasAttribute('data-backdrop');
  if (shown) root.removeAttribute('data-backdrop');
  const before = getComputedStyle(document.body, '::before'), after = getComputedStyle(document.body, '::after');
  const style = {
    width:parseFloat(before.width), height:parseFloat(before.height), glows:layers(before),
    glowAlpha:+before.opacity, art:after.display === 'none' ? '' : after.backgroundImage, left:parseFloat(after.left), top:parseFloat(after.top),
    artWidth:parseFloat(after.width), artAlpha:+after.opacity, filter:after.filter,
    artOffset:parseFloat(after.backgroundPositionY.match(/-?[\d.]+px/)?.[0] ?? '0'), fade:after.maskImage,
  };
  if (shown) root.setAttribute('data-backdrop', '');
  return style;
}

async function draw() {
  const style = read();
  const key = [style.width, JSON.stringify(style.glows), style.glowAlpha, style.art, style.left, style.top, style.artWidth, style.artAlpha, style.filter, style.artOffset, style.fade].join('|');
  if (key === drawn.key && style.height <= drawn.height) return;
  const mine = ++generation;
  const fail = () => { if (mine === generation) { root.removeAttribute('data-backdrop'); drawn = { key:'', height:0 }; } };
  const width = style.width, height = Math.ceil((style.height + HEADROOM) / 400) * 400;
  const list = style.glows;
  const art = style.art ? style.art.match(/^url\("?(.*?)"?\)$/)?.[1] : null;
  const filter = style.filter.match(/^blur\(([\d.]+)px\)(?: saturate\(([\d.]+)\))?$/);
  // site.css fades the art's top edge in with a mask: transparent to opaque over a length.
  const fade = style.fade.match(/^linear-gradient\(rgba\(0, 0, 0, 0\), rgb[a]?\([^)]*\) ([\d.]+)px\)$/);
  if (!list || !(width > 0) || (style.art && !art) || (style.filter !== 'none' && !filter) || (style.fade !== 'none' && !fade)) return fail();
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * SCALE); canvas.height = Math.ceil(height * SCALE);
  const context = canvas.getContext('2d', { willReadFrequently:true });
  if (!context) return fail();
  context.scale(SCALE, SCALE);
  const images = list.map(layer => { const image = new Image(); image.src = layer.url; return image; });
  try { await Promise.all(images.map(image => image.decode())); } catch { return fail(); }
  if (mine !== generation) return;
  context.globalAlpha = style.glowAlpha;
  for (const [i, layer] of list.entries()) {
    const x = across(layer.x, width - layer.width);
    if (Number.isNaN(x)) return fail();
    for (let y = 0; y < height; y += layer.height) context.drawImage(images[i], x, y, layer.width, layer.height);
  }
  if (art) {
    const image = new Image(); image.src = art;
    try { await image.decode(); } catch { return fail(); }
    if (mine !== generation) return;
    const step = style.artWidth * image.naturalHeight / image.naturalWidth;
    if (!(style.artWidth > 0 && step > 0) || Number.isNaN(style.left + style.top + style.artOffset)) return fail();
    // The box clips the tiles and the blur then reaches past it, as the element's filter does.
    const layer = document.createElement('canvas');
    layer.width = canvas.width; layer.height = canvas.height;
    const tiles = layer.getContext('2d', { willReadFrequently:true })!;
    tiles.scale(SCALE, SCALE);
    tiles.beginPath(); tiles.rect(style.left, style.top, style.artWidth, height - style.top); tiles.clip();
    for (let y = style.top + style.artOffset % step - (style.artOffset > 0 ? step : 0); y < height; y += step) tiles.drawImage(image, style.left, y, style.artWidth, step);
    if (fade) {
      const mask = tiles.createLinearGradient(0, style.top, 0, style.top + +fade[1]);
      mask.addColorStop(0, 'rgba(0,0,0,0)'); mask.addColorStop(1, 'rgba(0,0,0,1)');
      tiles.globalCompositeOperation = 'destination-in'; tiles.fillStyle = mask;
      tiles.fillRect(style.left, style.top, style.artWidth, height - style.top);
      tiles.globalCompositeOperation = 'source-over';
    }
    const sigma = filter ? +filter[1] * SCALE : 0, saturation = filter?.[2] ? +filter[2] : 1;
    if (sigma > 0 || saturation !== 1) tiles.putImageData(soften(tiles.getImageData(0, 0, layer.width, layer.height), sigma, saturation), 0, 0);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = style.artAlpha;
    context.drawImage(layer, 0, 0);
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve));
  if (mine !== generation) return;
  if (!blob) return fail();
  const previous = current;
  current = URL.createObjectURL(blob);
  root.style.setProperty('--desktop-backdrop', `url("${current}")`);
  root.style.setProperty('--desktop-backdrop-height', `${height}px`);
  root.setAttribute('data-backdrop', '');
  drawn = { key, height };
  if (previous) URL.revokeObjectURL(previous);
}

function schedule() { clearTimeout(pending); pending = window.setTimeout(() => { void draw(); }, 150); }

export function startBackdrop() {
  void draw();
  addEventListener('resize', schedule);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', schedule);
  // refresh() writes the theme on every snapshot: only a different one is drawn again.
  new MutationObserver(records => { if (records.some(r => r.oldValue !== root.getAttribute('data-theme'))) schedule(); })
    .observe(root, { attributes:true, attributeFilter:['data-theme'], attributeOldValue:true });
  // A longer view needs more of the bitmap; a shorter one is clipped by the body.
  new ResizeObserver(() => { if (document.body.offsetHeight > drawn.height) schedule(); }).observe(document.body);
}
