import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportAssets, urls, appIconSvg } from '../scripts/website-assets.mjs';

const code = css => css.replace(/\/\*[\s\S]*?\*\//g, '');
const declared = css => [...code(css).matchAll(/(?<![\w-])--([\w-]+)\s*:/g)].map(match => match[1]);
const used = css => [...code(css).matchAll(/var\(\s*--([\w-]+)/g)].map(match => match[1]);

async function exported() {
  const out = await mkdtemp(path.join(tmpdir(), 'gigahost-desktop-assets-'));
  try {
    await exportAssets(out);
    return { files: await readdir(out), site: await readFile(path.join(out, 'site.css'), 'utf8') };
  } finally {
    await rm(out, { recursive: true, force: true });
  }
}

test('the stylesheet resolves every asset, and the fonts\' licences', async () => {
  const { files, site } = await exported();
  const named = urls(site);
  assert.ok(named.includes('instrument-sans.woff2') && named.includes('geist-mono.woff2'), named.join(', '));
  for (const name of named) assert.ok(files.includes(name), `site.css names ${name}, which the app does not get`);
  for (const licence of ['instrument-sans-ofl.txt', 'geist-mono-ofl.txt']) assert.ok(files.includes(licence), licence);
  assert.deepEqual(urls('/* a url() in a comment */ a{src:url("a.woff2"),url(\'b.svg\'),url( c.png )}'), ['a.woff2', 'b.svg', 'c.png']);
});

test('light and dark artwork is copied without changing its bytes', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'gigahost-desktop-art-'));
  try {
    await exportAssets(out);
    for (const mode of ['light', 'dark']) for (const kind of ['hero', 'rail-start', 'rail-end', 'strip']) {
      const name = `art-${kind}-${mode}.svg`;
      const source = new URL(`../public/shared/${name}`, import.meta.url);
      assert.deepEqual(await readFile(path.join(out, name)), await readFile(source), name);
    }
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('the desktop icon uses the mark geometry and theme', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'gigahost-desktop-icon-'));
  try {
    await exportAssets(out);
    const theme = JSON.parse(await readFile(new URL('../public/shared/theme.json', import.meta.url), 'utf8'));
    const mark = await readFile(new URL('../public/shared/logo.svg', import.meta.url), 'utf8');
    const icon = await readFile(path.join(out, 'app-icon.svg'), 'utf8');
    assert.match(icon, /width="1024" height="1024" viewBox="0 0 32 32"/);
    assert.ok(icon.includes(`<rect width="32" height="32" rx="7" fill="${theme.light.text}"/>`));
    assert.ok(icon.includes('transform="translate(16 16) scale(0.857143) translate(-16 -16)"'));
    const paths = [...mark.matchAll(/ d="([^"]+)"/g)].map(match => match[1]);
    assert.ok(icon.includes(`<path fill="${theme.light.bg}" d="${paths[0]}"/>`));
    assert.ok(icon.includes(`<path fill="${theme.light.accent}" d="${paths[1]}"/>`));
    assert.doesNotMatch(icon, /currentColor|url\(|@media/);
    assert.throws(() => appIconSvg(mark.replace('logo__accent', 'unknown'), theme.light), /body and an accent/);
    assert.throws(() => appIconSvg(mark.replace('</svg>', '<path d="M0 0Z"/></svg>'), theme.light), /body and an accent/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('all platform builds generate their icons through the same vector source', async () => {
  const desktop = new URL('../', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('package.json', desktop), 'utf8'));
  assert.equal(pkg.scripts.icons, 'npm run assets && tauri icon public/shared/app-icon.svg');
  for (const platform of ['linux.sh', 'macos.sh', 'windows.ps1']) {
    const script = await readFile(new URL(`scripts/build-${platform}`, desktop), 'utf8');
    assert.match(script, platform === 'windows.ps1' ? /npm\.cmd run icons/ : /npm run icons/);
    assert.doesNotMatch(script, /apple-touch-icon\.png|run tauri icon/);
  }
});

test('every custom property the app\'s stylesheets read is defined', async () => {
  const { site } = await exported();
  const app = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  const defined = new Set([...declared(site), ...declared(app)]);
  assert.ok(defined.has('color-bg') && defined.has('font-sans'));
  const missing = [...used(site).map(name => `site.css: --${name}`), ...used(app).map(name => `src/style.css: --${name}`)]
    .filter(entry => !defined.has(entry.slice(entry.indexOf('--') + 2)));
  assert.deepEqual([...new Set(missing)], []);
  assert.deepEqual(used('a{color:var(--x,var( --y))}'), ['x', 'y']);
  assert.deepEqual(declared('a{--x: 1; b--y:2; color:var(--z)}'), ['x']);
});
