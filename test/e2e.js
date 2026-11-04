const { chromium } = require('playwright');
const path = require('path');
const B = 'http://localhost:8787', OUT = path.join(__dirname, 'out'), RC = path.join(__dirname, 'rc');
(async () => {
  const br = await chromium.launch();
  const hr = await br.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
  const p = await hr.newPage(); p.on('dialog', d => d.accept('Receipt not clear, please resend'));
  p.on('pageerror', e => console.log('PAGEERR', e.message));
  await p.goto(B + '/hr.html');
  await p.click('[data-tab=staff]');
  await p.setInputFiles('#sFile', path.join(__dirname, 'staff.xlsx'));
  await p.click('#sSave'); await p.waitForSelector('#sMsg.ok'); console.log('staff:', await p.textContent('#sMsg'));
  await p.screenshot({ path: OUT + '/hr-staff.png' });

  // staff submits on phone
  const st = await br.newContext({ ...require('playwright').devices['iPhone 13'], extraHTTPHeaders: { 'x-dev-user': 'none' } });
  const s = await st.newPage(); s.on('dialog', d => d.accept());
  await s.goto(B + '/');
  await s.fill('#tc', 'TC9999'); await s.click('#idf button'); await s.waitForSelector('#idmsg:not(.hidden)'); console.log('bad id:', await s.textContent('#idmsg'));
  await s.fill('#tc', 'tc4737'); await s.click('#idf button'); await s.waitForSelector('#s2:not(.hidden)'); console.log('who:', await s.textContent('#who'));
  const sub = async (cat, date, amt, file) => {
    await s.selectOption('#claim_month', '2026-10'); await s.selectOption('#category', cat);
    await s.fill('#expense_date', date); await s.fill('#amount', amt); await s.setInputFiles('#file', path.join(RC, file));
    await s.click('#sub'); await s.waitForFunction(() => !document.querySelector('#fmsg').classList.contains('hidden') && document.querySelector('#sub').textContent === 'Submit receipt');
    return s.textContent('#fmsg');
  };
  console.log(await sub('Car Maintenance', '2026-10-03', '683.46', 'r0.jpg'));
  console.log(await sub('Toll', '2026-10-06', '118.63', 'r1.jpg'));
  console.log(await sub('Parking', '2026-10-06', '3.06', 'r2.jpg'));
  console.log(await sub('Mileage', '2026-10-07', '245', 'r3.jpg'));
  console.log('DUP ->', await sub('Misc Expenses', '2026-10-08', '100', 'r0.jpg'));
  console.log(await sub('Misc Expenses', '2026-10-08', '100', 'r4.jpg'));
  await s.screenshot({ path: OUT + '/staff-phone.png', fullPage: true });

  // HR adds for another staff (Jailani), then rejects one
  await p.click('[data-tab=add]');
  await p.selectOption('#a_tc', 'TC4736'); await p.selectOption('#a_month', '2026-10'); await p.selectOption('#a_cat', 'Medical');
  await p.fill('#a_date', '2026-10-09'); await p.fill('#a_amt', '383.00'); await p.fill('#a_rem', 'Sent on WhatsApp 14/10/2026'); await p.setInputFiles('#a_file', path.join(RC, 'r5.jpg'));
  await p.click('#aSub'); await p.waitForSelector('#aMsg:not(.hidden)'); console.log('HR add:', await p.textContent('#aMsg'));
  await p.click('[data-tab=rcpt]'); await p.selectOption('#rMonth', '2026-10'); await p.waitForSelector('#rT [data-rej]');
  await p.click('#rT [data-rej] >> nth=4'); await p.waitForTimeout(500);
  await p.screenshot({ path: OUT + '/hr-receipts.png', fullPage: true });

  // matching
  await p.click('[data-tab=match]');
  await p.setInputFiles('#wbFile', process.argv[2]);
  await p.waitForFunction(() => !document.querySelector('#run').disabled);
  console.log('sheet default:', await p.inputValue('#wbSheet'), await p.inputValue('#wbMonth'));
  await p.selectOption('#wbSheet', 'Oct-26');
  await p.click('#run'); await p.waitForSelector('#res:not(.hidden)');
  console.log('tiles:', (await p.textContent('#tiles')).replace(/\s+/g, ' '));
  await p.fill('#q', 'TC473'); await p.check('#showAll');
  await p.screenshot({ path: OUT + '/hr-match.png', fullPage: true });
  console.log((await p.textContent('#resT')).replace(/\s+/g, ' ').slice(0, 1500));
  await p.fill('#q', ''); await p.uncheck('#showAll');
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#exp')]);
  await dl.saveAs(OUT + '/export.xlsx'); console.log('export saved');
  await br.close();
})().catch(e => { console.error(e); process.exit(1); });
