const { chromium, devices } = require('playwright'); const path=require('path');
const B='http://localhost:8787', OUT=path.join(__dirname,'out');
(async()=>{
  const br=await chromium.launch();
  const st=await br.newContext({...devices['iPhone 13']}); const s=await st.newPage();
  s.on('pageerror',e=>console.log('ERR',e.message));
  await s.goto(B+'/demo/'); await s.fill('#tc','tc9002'); await s.click('#idf button'); await s.waitForSelector('#s2:not(.hidden)');
  console.log(await s.textContent('#who'));
  await s.selectOption('#claim_month','2026-10'); await s.selectOption('#category','Car Maintenance'); await s.fill('#expense_date','2026-10-20'); await s.fill('#amount','180'); await s.setInputFiles('#file',path.join(__dirname,'rc','r0.jpg'));
  await s.click('#sub'); await s.waitForSelector('#fmsg.ok'); console.log(await s.textContent('#fmsg'));
  await s.screenshot({path:OUT+'/demo-staff.png',fullPage:true});
  const p=await st.browser().newContext({viewport:{width:1360,height:900}}); const h=await p.newPage(); h.on('pageerror',e=>console.log('ERR',e.message));
  // same localStorage origin needed: reuse staff context instead
  const h2=await st.newPage(); await h2.setViewportSize({width:1360,height:900});
  await h2.goto(B+'/demo/hr'); await h2.waitForSelector('#app:not(.hidden)');
  await h2.setInputFiles('#wbFile',path.join(__dirname,'..','public','demo','DN demo workbook.xlsx'));
  await h2.waitForFunction(()=>!document.querySelector('#run').disabled);
  console.log('sheet',await h2.inputValue('#wbSheet'));
  await h2.selectOption('#wbSheet','Oct-26'); await h2.click('#run'); await h2.waitForSelector('#res:not(.hidden)');
  console.log((await h2.textContent('#tiles')).replace(/\s+/g,' '));
  console.log((await h2.textContent('#resT')).replace(/\s+/g,' ').slice(0,1400));
  await h2.screenshot({path:OUT+'/demo-hr.png',fullPage:true});
  await br.close();
})().catch(e=>{console.error(e);process.exit(1)});
