import { defineConfig } from 'vite';
import { readFile } from 'node:fs/promises';

export default defineConfig({
  server: { port: 1420, strictPort: true },
  clearScreen: false,
  plugins: [{
    name: 'gigahost-logo',
    async transformIndexHtml(html) {
      const logo = (await readFile(new URL('./public/shared/lockup.svg', import.meta.url), 'utf8'))
        .replace('role="img" aria-label="Gigahost"', 'class="brand__lockup" aria-hidden="true" focusable="false"')
        .replace(/<title>.*?<\/title>\s*/, '');
      return html.replace('<!-- gigahost-logo -->', logo.trim());
    },
  }],
});
