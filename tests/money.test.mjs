import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/money.ts',import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { usd,usdExact,mmx,topUpUsd,usdRate,memoBytes,escape } = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
test('money stays exact above the JavaScript integer boundary',()=>{
  assert.equal(mmx('9007199254740993'),'9007199254.740993');
  assert.equal(mmx('1'),'0.000001');
  assert.equal(usdExact('1954'),'$0.001954');
  assert.equal(usdExact('1000000'),'$1.00');
  assert.equal(usd('9007199254740993'),'$9,007,199,254.74');
  assert.equal(usd(-1235000),'−$1.24');
});
test('UTF-8 memo boundaries and unsafe display strings',()=>{
  assert.equal(memoBytes('é'.repeat(32)),64);
  assert.equal(memoBytes('🔑'.repeat(17)),68);
  assert.equal(escape('<img src=x onerror="bad">'), '&lt;img src=x onerror=&quot;bad&quot;&gt;');
});
test('funding estimates match exact settlement rounding',()=>{
  assert.equal(topUpUsd('2','0.2'),'$0.40');
  assert.equal(topUpUsd('0.000001','0.999999999999999999'),'$0.00');
  assert.equal(topUpUsd('9007199254.740993','1'),'$9,007,199,254.740993');
  for (const rate of [null,undefined,'','0','-1','NaN','1e-2','0.0000000000000000001','1.2.3']) {
    assert.equal(topUpUsd('2',rate),null);
  }
});
test('conversion rates print exactly without floating point',()=>{
  assert.equal(usdRate('5.000000000000000000'),'$5.00');
  assert.equal(usdRate('0.123456789012345678'),'$0.123456789012345678');
  assert.equal(usdRate('0.200000000000000000'),'$0.20');
  assert.equal(usdRate('1234.5'),'$1,234.50');
  assert.equal(usdRate(null),'—');
  assert.equal(usdRate('1e3'),'—');
});
