import { readFile } from 'node:fs/promises';
const data = JSON.parse(await readFile('/var/lib/seating-studio/workspaces.json','utf8'));
const guests = data.workspaces.flatMap(w => w.guests || []);
const companies = Object.values(guests.reduce((m,g) => { const c=(g.company || '').trim(); if(c && !/not provided/i.test(c)) m[c]=(m[c]||0)+1; return m; },{}));
const senior = title => /\b(chair(?:man|woman)?|ceo|chief executive|president|founder|managing director|secretary general|director general|chief|cfo|coo|cto|cmo|vice president|vp|partner|general manager|executive director|director|head)\b/i.test(title||'');
console.log(JSON.stringify({guests:guests.length,companyProvided:companies.reduce((a,b)=>a+b,0),uniqueCompanies:companies.length,companySizeHistogram:Object.fromEntries([...new Set(companies)].sort((a,b)=>a-b).map(n=>[n,companies.filter(x=>x===n).length])),seniorTitles:guests.filter(g=>senior(g.title)).length,vips:guests.filter(g=>g.vip).length,seated:guests.filter(g=>g.tableId).length}));
