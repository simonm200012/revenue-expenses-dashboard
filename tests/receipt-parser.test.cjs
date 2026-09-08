const {test}=require('node:test');
const assert=require('node:assert/strict');
const p=require('../scripts/receipt-parser.js');
test('Slovenian receipt total, date and merchant; ignores cash and change',()=>{
 const r=p.parse('MERCATOR\nDunajska 10\n08.09.2026 10:20\nVmesni znesek 20,00\nPOPUST 2,10\nSKUPAJ 17,90\nGOTOVINA 20,00\nVRAČILO 2,10');
 assert.equal(r.amount,17.9);assert.equal(r.date,'2026-09-08');assert.equal(r.merchant,'MERCATOR');
});
test('money separators',()=>{assert.equal(p.amount('1.234,56'),1234.56);assert.equal(p.amount('1,234.56'),1234.56);assert.equal(p.amount('12,345'),null);assert.equal(p.amount('-12,50'),-12.5);});
test('never uses subtotal or tender as total',()=>{assert.equal(p.parse('SUBTOTAL 45.00\nCASH 50.00\nCHANGE 5.00').amount,null);});
test('grand total wins, amount on next line supported',()=>{assert.equal(p.parse('TOTAL 10,00\nZA PLAČILO\n12,50 EUR').amount,12.5);});
test('ambiguous totals and foreign currency require manual entry',()=>{assert.equal(p.parse('TOTAL 10,00\nTOTAL 11,00').amount,null);assert.equal(p.parse('TOTAL $10.00').amount,null);});
test('invalid calendar date rejected, ISO parsed correctly',()=>{assert.equal(p.parse('31.02.2026').date,'');assert.equal(p.parse('2026-09-08').date,'2026-09-08');});
test('duplicate uses same date, amount and direction, including another bank',()=>{
 const rows=[{id:1,d:'2026-09-08',v:12.5,t:'Out',b:'NLB'},{id:2,d:'2026-09-08',v:12.5,t:'In'}];
 assert.equal(p.duplicateCandidates(rows,{d:'2026-09-08',v:12.5,t:'Out'}).length,1);
 assert.equal(p.duplicateCandidates(rows,{d:'2026-09-08',v:12.5,t:'Out'},1).length,0);
});
