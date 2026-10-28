import { readFile, readdir, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const snapshot = path.join(root, 'public/shared');
export const urls = css => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/url\(\s*(["']?)([^"')]*?)\1\s*\)/g)].map(match => match[2]);

export function appIconSvg(mark, light) {
  const paths = [...mark.matchAll(/<path\b[^>]*\/>/g)].map(match => match[0]);
  const body = paths[0]?.match(/^<path d="([^"]+)"\s*\/>$/)?.[1];
  const accent = paths[1]?.match(/^<path class="logo__accent" d="([^"]+)"\s*\/>$/)?.[1];
  if (!mark.includes('viewBox="0 0 32 32"') || paths.length !== 2 || !body || !accent) {
    throw new Error('logo.svg must supply the 32px mark with a body and an accent path');
  }
  for (const role of ['text', 'bg', 'accent']) {
    if (!/^#[\da-f]{6}$/i.test(light[role])) throw new Error(`The app icon needs the light ${role} color`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="7" fill="${light.text}"/>` +
    '<g transform="translate(16 16) scale(0.857143) translate(-16 -16)">' +
    `<path fill="${light.bg}" d="${body}"/><path fill="${light.accent}" d="${accent}"/></g></svg>\n`;
}

export async function exportAssets(out = snapshot) {
  const manifest = JSON.parse(await readFile(path.join(snapshot, 'manifest.json'), 'utf8'));
  if (manifest.schema !== 1 || !manifest.files || Object.keys(manifest.files).some(name => !/^[a-z0-9.-]+$/.test(name) || name === 'manifest.json')) throw new Error('Invalid asset manifest');
  const names = Object.keys(manifest.files).sort();
  if (JSON.stringify((await readdir(snapshot)).sort()) !== JSON.stringify([...names, 'manifest.json'].sort())) throw new Error('Asset inventory differs');
  for (const name of names) {
    const bytes = await readFile(path.join(snapshot, name));
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[name]) throw new Error(`Asset hash differs: ${name}`);
  }
  const theme = JSON.parse(await readFile(path.join(snapshot, 'theme.json'), 'utf8'));
  const css = await readFile(path.join(snapshot, 'site.css'), 'utf8');
  if (urls(css).some(name => !names.includes(name))) throw new Error('Unresolved stylesheet asset');
  if (await readFile(path.join(snapshot, 'app-icon.svg'), 'utf8') !== appIconSvg(await readFile(path.join(snapshot, 'logo.svg'), 'utf8'), theme.light)) throw new Error('Icon differs from theme and mark');
  if (path.resolve(out) !== snapshot) {
    await mkdir(out, { recursive: true });
    for (const name of [...names, 'manifest.json']) await copyFile(path.join(snapshot, name), path.join(out, name));
  }
  return { active: theme.active, copied: names };
}
