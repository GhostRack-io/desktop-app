import { test, expect } from '@playwright/test';
import { fixture, openDesktop } from './fixtures';

for (const mode of [
  {theme:'light',scheme:'dark',visible:'light'},
  {theme:'dark',scheme:'light',visible:'dark'},
  {theme:'system',scheme:'light',visible:'light'},
  {theme:'system',scheme:'dark',visible:'dark'},
] as const) test(`one click reverses ${mode.theme} with ${mode.scheme} system colors`,async({page})=>{
  await page.emulateMedia({colorScheme:mode.scheme});
  const state=structuredClone(fixture); state.settings.theme=mode.theme;
  await openDesktop(page,state);
  await expect(page.getByRole('heading',{name:'Your account, at a glance.'})).toBeVisible();
  const first=mode.visible === 'dark' ? 'light' : 'dark';
  for (const theme of [first,mode.visible]) {
    await page.getByRole('button',{name:'Change theme',exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe(theme);
    await page.getByRole('button',{name:'Refresh',exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  }
  expect(await page.evaluate(()=>(window as any).calls.filter((r:any)=>r.action === 'save_settings').map((r:any)=>r.settings.theme))).toEqual([first,mode.visible]);
});

test('dark appearance is used even when the system prefers light',async({page})=>{
  await page.emulateMedia({colorScheme:'light'});
  const state=structuredClone(fixture); state.settings.theme='dark';
  await openDesktop(page,state);
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  await page.getByRole('link',{name:'Settings',exact:true}).click();
  await expect(page.getByLabel('Theme',{exact:true})).toHaveValue('dark');
});
