/* Structured invoice metadata. This contains no financial records or credentials. */
(function(root){
 'use strict';
 const cents=n=>Math.round(Number(n)*100);
 const text=(s,max=500)=>String(s??'').trim().slice(0,max);
 function number(value,field,optional=false){
  if(value==null||value===''){if(optional)return null;throw new Error(field+' is required.');}
  const n=Number(value);if(!Number.isFinite(n)||Math.abs(n)>999999999)throw new Error(field+' must be a finite number.');return n;
 }
 function clean(input){
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid invoice details.');
  const date=text(input.invoice_date||input.date,10);
  if(date&&(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date))throw new Error('Enter a valid invoice date.');
  const amount=number(input.amount,'Invoice total',true);if(amount!==null&&amount<=0)throw new Error('Invoice total must be positive.');
  if(input.line_items!=null&&!Array.isArray(input.line_items))throw new Error('Invoice items must be a list.');
  if((input.line_items||[]).length>200)throw new Error('An invoice can contain up to 200 item lines.');
  const line_items=(input.line_items||[]).map((item,i)=>{
   const description=text(item.description);if(!description)throw new Error('Item '+(i+1)+' needs a description.');
   const quantity=number(item.quantity,'Quantity',true),unit_price=number(item.unit_price,'Unit price',true),discount=number(item.discount,'Discount',true);
   if(quantity!==null&&quantity<=0||unit_price!==null&&unit_price<0||discount!==null&&discount<0)throw new Error('Use a positive quantity and nonnegative unit price and discount.');
   return {description,sku:text(item.sku,100),quantity,unit:text(item.unit,30),unit_price,discount,total:cents(number(item.total,'Item total'))/100,category:text(item.category,100)};
  });
  return {merchant:text(input.merchant),invoice_date:date,date,invoice_number:text(input.invoice_number,160),invoice_number_note:text(input.invoice_number_note),reference:text(input.reference,200),amount:amount===null?null:cents(amount)/100,currency:text(input.currency||'EUR',10),notes:text(input.notes,2000),line_items};
 }
 function balance(invoice){const items=invoice.line_items||[];const sum=items.reduce((s,item)=>s+cents(item.total),0);const difference=invoice.amount==null?null:cents(invoice.amount)-sum;return {sum:sum/100,difference:difference===null?null:difference/100,matches:items.length>0&&difference===0};}
 function identity(invoice){return invoice.invoice_number?[text(invoice.merchant).toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,''),text(invoice.invoice_number).toUpperCase(),invoice.invoice_date||invoice.date||''].join('|'):'';}
 function parse(textValue){
  const lines=String(textValue||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  const invoiceNumbers=lines.map(line=>line.match(/(?:ra[cč]un\s*(?:[šs]t(?:evilka)?\.?|number|no\.?)|invoice\s*(?:number|no\.?|#))\s*[:.]?\s*([A-Z0-9][A-Z0-9/-]{2,})/i)?.[1]).filter(Boolean);
  const invoice_number=invoiceNumbers.find(n=>/\d[-/]\d/.test(n))||invoiceNumbers[0]||'';
  const ref=lines.join('\n').match(/interna\s+[šs]tevilka\s*[:.]?\s*(\d+)/i);
  const decimal=s=>Number(String(s).replace(',','.'));
  const line_items=[];
  for(let i=0;i<lines.length;i++){
   const line=lines[i];let match,item;
   if(/\b(DDV|VAT|NETO|SKUPAJ|TOTAL|PLAČ|PLAC|MASTERCARD|GOTOVINA|VMESNA|VRAČ|VRAC)\b/i.test(line))continue;
   if((match=line.match(/^(\d{5,8})\s+(.+?)\s+(\d+[.,]\d{2})\s*[A-E]$/i))){
    item={sku:match[1],description:match[2],quantity:1,unit:'pcs',unit_price:decimal(match[3]),discount:0,total:decimal(match[3])};
    const weight=lines[i+1]?.match(/^(\d+[.,]\d{1,3})\s*(kg|l)\s*x\s*(\d+[.,]\d{2,3})\s*EUR\/(?:kg|l)/i);
    if(weight){item.quantity=decimal(weight[1]);item.unit=weight[2].toLowerCase();item.unit_price=decimal(weight[3]);i++;}
   }else if((match=line.match(/^(\d+)\s+(.+?)\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})[a-e]?$/i))){
    item={description:match[2],quantity:Number(match[1]),unit:'pcs',unit_price:decimal(match[3]),discount:0,total:decimal(match[4])};
   }else if((match=line.match(/^(.+?)\s+(\d+)\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s+(\d+[.,]\d{2})\s*[A-E]$/i))){
    item={description:match[1],quantity:Number(match[2]),unit:'pcs',unit_price:decimal(match[3]),discount:decimal(match[4]),total:decimal(match[5])};
   }else if((match=line.match(/^(.+?)\s+(\d+)\s*x\s+(\d+[.,]\d{2})\s*[A-E]$/i))){
    item={description:match[1],quantity:Number(match[2]),unit:'pcs',unit_price:decimal(match[3])/Number(match[2]),discount:0,total:decimal(match[3])};
   }else if(/^(EVO|DIESEL|BENCIN|EUROSUPER)\b/i.test(line)){
    const fuel=lines[i+1]?.match(/^\*?\d+\s+(\d+[.,]\d{3})\s*L\s+(\d+[.,]\d{3})\s*EUR\/L\s+(\d+[.,]\d{2})/i);
    if(fuel){item={description:line,quantity:decimal(fuel[1]),unit:'L',unit_price:decimal(fuel[2]),discount:0,total:decimal(fuel[3])};i++;}
   }
   if(item&&/[a-zčšž]/i.test(item.description))line_items.push(item);
  }
  return {invoice_number,reference:ref?'Internal reference '+ref[1]:'',line_items};
 }
 const api={clean,balance,identity,parse};if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.InvoiceData=api;
})(typeof window!=='undefined'?window:globalThis);
