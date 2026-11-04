const XLSX=require('xlsx'), M=require('../public/match.js'), staff=require('./staff.json');
const wb=XLSX.readFile(process.argv[2]);
const sheets=wb.SheetNames.map(n=>({n,m:M.sheetMonth(n)})).filter(s=>s.m);
console.log(sheets.map(s=>s.n+'='+s.m).join(', '));
const read=n=>M.readSheet(XLSX.utils.sheet_to_json(wb.Sheets[n],{header:1,raw:true,defval:null}),n);
const oct=read('Oct-26'); console.log('lines',oct.lines.length,'total',oct.lines.reduce((a,l)=>a+l.sen,0)/100,'problems',oct.problems);
const other=sheets.filter(s=>s.n!=='Oct-26').map(s=>({month:s.m,lines:read(s.n).lines||[]}));
// receipts: simulate - Gopi (TC4737) full, Jailani short, Farid receipt w/o approval, duplicate, toll vs parking split
let id=0;const R=(tc,cat,sen,date='2026-10-05',extra={})=>({id:'r'+(++id),tc_id:tc,claim_month:'2026-10',category:cat,amount_sen:sen,expense_date:date,status:'Submitted',...extra});
const receipts=[R('TC4737','Car Maintenance',68346),R('TC4737','Mileage',24500),R('TC4737','Toll',11863),R('TC4737','Parking',306),R('TC4737','Misc Expenses',10000),
 R('TC4736','Medical',38300),R('TC4736','Car Maintenance',20000),
 R('TC4803','Car Maintenance',87500,'2026-09-10'),
 R('TC4771','Toll',7059,'2026-10-02'),R('TC4771','Parking',1740,'2026-10-02'),R('TC4771','Parking',1740,'2026-10-02'),
 R('TC4771','Streamyx / Internet',6360,'2027-01-01')];
const res=M.match({month:'2026-10',dnLines:oct.lines,receipts,staff,otherMonths:other});
console.log(res.summary);
for(const x of res.lines.filter(x=>['TC4737','TC4736','TC4803','TC4771'].includes(x.tc)||x.tc.startsWith('DN#'))) console.log(x.tc,x.category,x.dn,x.rc,x.supported,x.status,x.severity,'|',x.issues.join(' / '),x.note||'');
