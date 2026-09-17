const {test}=require('node:test'),assert=require('node:assert/strict');
const invoice=require('../scripts/invoice-data.js'),parser=require('../scripts/receipt-parser.js');
test('invoice details preserve three-decimal prices, weight and already-discounted totals',()=>{
 const value=invoice.clean({invoice_date:'2026-09-10',amount:30.81,line_items:[{description:'Fuel',quantity:19,unit:'L',unit_price:1.622,total:30.81,discount:0}]});
 assert.equal(value.line_items[0].unit_price,1.622);assert.equal(value.line_items[0].quantity,19);assert.equal(invoice.balance(value).matches,true);
 const discounted=invoice.clean({amount:8.75,line_items:[{description:'Calculator',quantity:1,unit_price:12,discount:3.25,total:8.75}]});
 assert.equal(invoice.balance(discounted).sum,8.75);
});
test('invoice validation rejects invalid dates, malformed items and nonfinite amounts',()=>{
 for(const value of [{invoice_date:'2026-02-31'},{amount:-1},{amount:Infinity},{line_items:{}},{line_items:[{description:'',total:1}]},{line_items:[{description:'A',quantity:0,total:1}]}])assert.throws(()=>invoice.clean(value));
 assert.equal(invoice.clean({invoice_date:'2024-02-29'}).invoice_date,'2024-02-29');
});
test('partial items stay explicitly unreconciled and merchant scopes invoice identity',()=>{
 assert.equal(invoice.balance({amount:10,line_items:[{total:8}]}).difference,2);
 assert.equal(invoice.balance({amount:10,line_items:[]}).matches,false);
 assert.notEqual(invoice.identity({merchant:'Shop A',invoice_number:'123'}),invoice.identity({merchant:'Shop B',invoice_number:'123'}));
 assert.equal(invoice.identity({merchant:'Shop A',invoice_number:''}),'');
});
test('fiscal invoice numbers take priority and internal/card references are never promoted',()=>{
 const p=invoice.parse('Invoice no: 123\nRAČUN št.: 111-002-54321\nInterna številka 987654\nREC:7351');
 assert.equal(p.invoice_number,'111-002-54321');assert.equal(p.reference,'Internal reference 987654');
 assert.equal(invoice.parse('Interna številka 987654\nREC:7351\nZOI:abc123').invoice_number,'');
});
test('item parsing handles weighted groceries, repeated goods, fuel and discounts without tax rows',()=>{
 const goods=invoice.parse('123456 Banane za kg 2,00 A\n1,250 kg x 1,60 EUR/kg\n1 DEODORANT 3,50 3,50a\nCalculator 1 12,00 3,25 8,75 C\nA 9,5% Neto 10,20 DDV 0,97');
 assert.equal(goods.line_items.length,3);assert.equal(goods.line_items[0].quantity,1.25);assert.equal(goods.line_items[0].unit_price,1.6);assert.equal(goods.line_items[2].discount,3.25);
 const fuel=invoice.parse('EVO 95\n*6 20.000 L 1.623 EUR/L 32.46 22%D');assert.equal(fuel.line_items[0].quantity,20);assert.equal(fuel.line_items[0].unit_price,1.623);
});
test('receipt scan includes invoice date and item candidates without confusing VAT and payment totals',()=>{
 const p=parser.parse('HOFER TRGOVINA D.O.O. ID za DDV: SI12345678\n123456 Bread 1,20 A\n29.08.2026/08:37:35\nZnesek EUR: 1.20\nHOFER CENA 1.20\nA 9,5% Neto 1,10 DDV 0,10\nRačun št.: 111-002-54321');
 assert.equal(p.merchant,'HOFER');assert.equal(p.amount,1.2);assert.equal(p.invoice_date,'2026-08-29');assert.equal(p.invoice_number,'111-002-54321');assert.equal(p.line_items.length,1);
});
