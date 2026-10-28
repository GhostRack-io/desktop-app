import { defineConfig } from '@playwright/test';
const offline = process.env.DESKTOP_UI_OFFLINE === '1';
export default defineConfig({ testDir:'./tests/ui',use:{baseURL:offline ? 'http://desktop.test' : 'http://127.0.0.1:1420',viewport:{width:1180,height:820},serviceWorkers:'block'},webServer:offline ? undefined : {command:'npm run build && npm run preview',url:'http://127.0.0.1:1420',reuseExistingServer:!process.env.CI},reporter:'list' });
