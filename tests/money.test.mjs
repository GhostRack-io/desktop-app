import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const source = await fs.readFile(new URL('../src/money.ts',import.meta.url),'utf8');
const js = ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const { usd,usdExact,mmx,topUpUsd,payoutMmx,memoBytes,escape } = await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
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
test('funding and payout estimates match exact settlement rounding',()=>{
  assert.equal(topUpUsd('2','0.2'),'$0.40');
  assert.equal(payoutMmx('65500001','0.2'),'327.500005 MMX');
  assert.equal(topUpUsd('0.000001','0.999999999999999999'),'$0.00');
  assert.equal(topUpUsd('9007199254.740993','1'),'$9,007,199,254.740993');
  assert.equal(payoutMmx('9007199254740993','1'),'9007199254.740993 MMX');
  assert.equal(payoutMmx('1000000','3'),'0.333333 MMX');
  assert.equal(payoutMmx('1','0.000001'),'1 MMX');
  for (const rate of [null,undefined,'','0','-1','NaN','1e-2','0.0000000000000000001','1.2.3']) {
    assert.equal(topUpUsd('2',rate),null);
    assert.equal(payoutMmx('1000000',rate),null);
  }
});
