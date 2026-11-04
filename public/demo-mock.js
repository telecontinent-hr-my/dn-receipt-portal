// DN Receipt Portal - DEMO mode.
// Active only under /demo. Replaces the server with a fake one kept in this browser.
// Nothing here reaches the real database or file storage. All names and amounts are made up.
(function () {
  if (!location.pathname.startsWith('/demo')) return;
  window.DEMO = true;
  const KEY = 'dnrp_demo_v1';
  const CATS = ['Medical', 'Optical/Dental', 'Car Road Tax', 'Car Insurance', 'Car Maintenance', 'Parking (Office)', 'Meal Allowance',
    'Mileage', 'Parking', 'Toll', 'Accommodation', 'Transportation', 'Streamyx / Internet', 'Handphone', 'Entertainment', 'Gift',
    'Misc Expenses', 'Swab Test', 'Staff Relation'];
  const now = () => new Date().toISOString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  const refOf = (id) => 'DNR-' + id.replace(/-/g, '').slice(0, 8).toUpperCase();
  const files = {}; // id -> object URL (this visit only)

  function seed() {
    const staff = [
      ['TC9001', 'Ahmad Demo Bin Ali', '90000001'], ['TC9002', 'Siti Contoh Binti Hassan', '90000002'],
      ['TC9003', 'Raj Sample A/L Kumar', '90000003'], ['TC9004', 'Tan Example Wei', '90000004'],
      ['TC9005', 'Nurul Test Binti Omar', '90000005'], ['TC9006', 'Lim Trial Kok Wah', '90000006']
    ].map(([tc_id, name, dn_person_no]) => ({ tc_id, name, dn_person_no, email: '', active: 1 }));
    const R = (tc, category, sen, expense_date, status = 'Submitted', extra = {}) => ({
      id: uid(), tc_id: tc, claim_month: '2026-10', category, amount_sen: sen, expense_date, status,
      merchant: extra.merchant || 'Demo Shop Sdn Bhd', receipt_no: extra.receipt_no || null, remark: null,
      file_name: 'demo-receipt.svg', file_type: 'image/svg+xml', channel: extra.channel || 'Staff portal',
      submitted_by: extra.channel ? 'demo.hr@example.com' : `${tc} (staff form)`, submitted_at: now(), hr_note: null
    });
    const receipts = [
      R('TC9001', 'Medical', 12000, '2026-10-03', 'Accepted', { merchant: 'Klinik Demo' }),
      R('TC9001', 'Toll', 4560, '2026-10-08'),
      R('TC9001', 'Toll', 4560, '2026-10-08'),                       // possible duplicate
      R('TC9002', 'Car Maintenance', 30000, '2026-10-10', 'Submitted', { merchant: 'Bengkel Demo' }),
      R('TC9002', 'Mileage', 21000, '2026-10-12'),
      R('TC9004', 'Parking', 2000, '2026-10-05'),
      R('TC9004', 'Toll', 7520, '2026-10-05'),                       // DN booked parking inside Toll
      R('TC9005', 'Optical/Dental', 35000, '2026-10-15', 'Submitted', { merchant: 'Optik Demo' }),
      R('TC9003', 'Car Maintenance', 35000, '2026-09-20'),           // approved in Sep sheet, not Oct
      R('TC9006', 'Misc Expenses', 5000, '2026-10-18', 'Submitted', { channel: 'HR on behalf' })
    ];
    return { staff, receipts, audit: [{ id: 1, at: now(), actor: 'demo', action: 'demo_start', ref: null, detail: '{"note":"Demo data loaded"}' }] };
  }
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { S = seed(); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* demo only */ } };
  const log = (actor, action, ref, detail) => { S.audit.unshift({ id: S.audit.length + 1, at: now(), actor, action, ref, detail: JSON.stringify(detail || {}) }); };
  window.demoReset = () => { try { localStorage.removeItem(KEY); } catch {} location.reload(); };

  const isHrPage = /\/demo\/hr/.test(location.pathname);
  const ok = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }));
  const err = (msg, status = 400) => ok({ error: msg }, status);
  const staffName = (tc) => (S.staff.find(s => s.tc_id === tc) || {}).name || '';

  function svgReceipt(r) {
    const t = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560"><rect width="100%" height="100%" fill="#fff"/>
      <text x="30" y="50" font-family="monospace" font-size="20">DEMO RECEIPT</text>
      <text x="30" y="90" font-family="monospace" font-size="15">${r.merchant || 'Demo Shop'}</text>
      <text x="30" y="130" font-family="monospace" font-size="15">Date: ${r.expense_date}</text>
      <text x="30" y="160" font-family="monospace" font-size="15">${r.category}</text>
      <text x="30" y="220" font-family="monospace" font-size="22">TOTAL RM ${(r.amount_sen / 100).toFixed(2)}</text>
      <text x="30" y="520" font-family="monospace" font-size="12" fill="#999">Sample only - not a real receipt</text></svg>`;
    return URL.createObjectURL(new Blob([t], { type: 'image/svg+xml' }));
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, opts = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    const m = (opts.method || 'GET').toUpperCase(), p = url.pathname;
    let mm;

    if (p === '/api/me') return ok(isHrPage ? { email: 'demo.hr@example.com', isHR: true, staff: null, categories: CATS } : { open: true, categories: CATS });

    if (p === '/api/lookup' && m === 'POST') {
      const tc = String(JSON.parse(opts.body || '{}').tc_id || '').replace(/\s+/g, '').toUpperCase();
      const s = S.staff.find(x => x.tc_id === tc && x.active);
      return s ? ok({ tc_id: s.tc_id, name: s.name }) : err(`Staff ID ${tc || '?'} is not on the DN staff list. In the demo, use TC9001 to TC9006.`, 404);
    }

    if (p === '/api/receipts' && m === 'POST') {
      const fd = opts.body, f = (k) => String(fd.get(k) ?? '').trim();
      const tc = f('tc_id').toUpperCase();
      if (!S.staff.find(s => s.tc_id === tc && s.active)) return err(`Staff ID ${tc || '?'} is not on the DN staff list.`);
      if (!CATS.includes(f('category'))) return err('Choose a claim category.');
      const amt = f('amount').replace(/,/g, '');
      if (!/^\d+(\.\d{1,2})?$/.test(amt) || +amt <= 0) return err('Enter the receipt amount, e.g. 45.60');
      const file = fd.get('file');
      if (!file || typeof file === 'string') return err('Attach the receipt photo or PDF.');
      const buf = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      const dup = S.receipts.find(r => r.file_hash === hash && ['Submitted', 'Accepted'].includes(r.status));
      if (dup) return err(`This same file was already submitted on ${dup.submitted_at.slice(0, 10)}. It is not accepted again.`);
      const [ri, rd = ''] = amt.split('.');
      const r = { id: uid(), tc_id: tc, claim_month: f('claim_month'), category: f('category'), expense_date: f('expense_date'),
        amount_sen: +ri * 100 + +((rd + '00').slice(0, 2)), merchant: f('merchant') || null, receipt_no: f('receipt_no') || null,
        remark: f('remark') || null, file_name: file.name, file_type: file.type, file_hash: hash,
        channel: isHrPage ? 'HR on behalf' : 'Staff portal', submitted_by: isHrPage ? 'demo.hr@example.com' : `${tc} (staff form)`,
        submitted_at: now(), status: 'Submitted', hr_note: null };
      files[r.id] = URL.createObjectURL(file);
      S.receipts.push(r); log(r.submitted_by, 'submit', r.id, { tc, category: r.category }); save();
      return ok({ ok: true, id: r.id, ref: refOf(r.id), name: staffName(tc) });
    }

    if (p === '/api/receipts' && m === 'GET') {
      if (!isHrPage) return err('Not signed in.', 401);
      const month = url.searchParams.get('month');
      return ok({ receipts: S.receipts.filter(r => !month || r.claim_month === month).map(r => ({ ...r, staff_name: staffName(r.tc_id) })) });
    }

    if ((mm = p.match(/^\/api\/receipts\/([^/]+)\/review$/)) && m === 'POST') {
      const r = S.receipts.find(x => x.id === mm[1]); const b = JSON.parse(opts.body || '{}');
      if (!r) return err('Receipt not found.', 404);
      r.status = b.status; r.hr_note = b.note || null; r.reviewed_by = 'demo.hr@example.com'; r.reviewed_at = now();
      log('demo.hr@example.com', 'review', r.id, { to: b.status, note: b.note }); save();
      return ok({ ok: true });
    }

    if (p === '/api/staff' && m === 'GET') return ok({ staff: S.staff });
    if (p === '/api/staff' && m === 'POST') {
      const list = JSON.parse(opts.body || '{}').staff || [];
      for (const s of list) {
        const tc = String(s.tc_id || '').replace(/\s+/g, '').toUpperCase(); if (!/^TC\d+$/.test(tc) || !s.name) continue;
        const ex = S.staff.find(x => x.tc_id === tc);
        const row = { tc_id: tc, name: s.name, dn_person_no: s.dn_person_no || null, email: s.email || '', active: s.active === 0 ? 0 : 1 };
        ex ? Object.assign(ex, row) : S.staff.push(row);
      }
      log('demo.hr@example.com', 'staff_upload', null, { rows: list.length }); save();
      return ok({ ok: true, saved: list.length });
    }

    if (p === '/api/audit') return ok({ log: S.audit.slice(0, 500) });
    return err('Not available in the demo.', 404);
  };

  window.demoFileUrl = (id) => {
    const r = S.receipts.find(x => x.id === id);
    return files[id] || (r ? svgReceipt(r) : '');
  };

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.style.cssText = 'background:#fdf2dc;color:#7a4a00;padding:10px 16px;font-size:14px;border-bottom:1px solid #f0d9a8';
    b.innerHTML = `<div class="wrap"><strong>DEMO</strong> · Made-up staff and receipts. Nothing here is saved to the real system.
      ${isHrPage ? 'Try: download the <a href="/demo/DN%20demo%20workbook.xlsx">sample DN workbook</a>, upload it in Match &amp; validate, then click Match receipts.'
                 : 'Use staff ID <strong>TC9001</strong> to <strong>TC9006</strong>.'}
      · <a href="${isHrPage ? '/demo/' : '/demo/hr'}">${isHrPage ? 'Open the staff page' : 'Open the HR page'}</a>
      · <a href="#" onclick="demoReset();return false">Reset demo</a></div>`;
    document.body.insertBefore(b, document.body.firstChild);
    document.title = 'DEMO · ' + document.title;
  });
})();
