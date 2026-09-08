const fs=require('node:fs'),vm=require('node:vm');
const html=fs.readFileSync('index.html','utf8');
for(const [i,m]of [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].entries())if(m[1].trim())new vm.Script(m[1],{filename:'inline-'+i});
for(const path of ['scripts/receipt-parser.js','scripts/transaction-entry.js','apps-script/Code.gs','sw.js'])new vm.Script(fs.readFileSync(path,'utf8'),{filename:path});
console.log('All app and Apps Script JavaScript parses successfully.');
