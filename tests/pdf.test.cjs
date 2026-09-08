const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function twoPagePdf(){
 const text=n=>`BT /F1 12 Tf 40 750 Td (TEST SHOP ${n}) Tj 0 -20 Td (Date: 08.09.2026) Tj 0 -20 Td (TOTAL EUR 12,50) Tj ET`;
 const stream=n=>`<< /Length ${text(n).length} >>\nstream\n${text(n)}\nendstream`;
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',...([1,2].flatMap(n=>[`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 3 0 R >> >> /Contents ${n===1?5:7} 0 R >>`,stream(n)]))];
 let pdf='%PDF-1.4\n',offsets=[0];objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${s}\nendobj\n`;});const start=Buffer.byteLength(pdf);pdf+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;return new Uint8Array(Buffer.from(pdf));
}
test('real two-page PDF text preserves receipt lines for amount and date parsing',async()=>{
 const pdfjs=await import('pdfjs-dist/legacy/build/pdf.mjs');const context=vm.createContext({});vm.runInContext(fs.readFileSync('scripts/receipt-parser.js','utf8'),context);vm.runInContext(fs.readFileSync('scripts/finance-workflows.js','utf8'),context);
 const doc=await pdfjs.getDocument({data:twoPagePdf(),isEvalSupported:false,disableFontFace:true,standardFontDataUrl:require('node:path').resolve('vendor/pdfjs/standard_fonts')+'/'}).promise;assert.equal(doc.numPages,2);
 try{for(let n=1;n<=2;n++){const page=await doc.getPage(n),text=context.pdfReceiptText((await page.getTextContent()).items),parsed=context.ReceiptParser.parse(text);assert.equal(parsed.amount,12.5);assert.equal(parsed.date,'2026-09-08');assert.match(parsed.merchant,new RegExp('TEST SHOP '+n));}}finally{await doc.destroy();}
});
