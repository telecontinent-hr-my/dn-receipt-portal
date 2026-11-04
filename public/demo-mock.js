// DN Claim Receipts - DEMO mode.
// Active only under /demo. Replaces the server with a fake one kept in this browser.
// Nothing here reaches the real database or file storage. All names and amounts are made up.
// The demo does not run the real receipt reader. It pretends each upload reads as the amount still missing,
// unless the file name has a word below:  half -> reads half,  spouse -> patient is the spouse,  menu -> not a receipt.
(function () {
  if (!location.pathname.startsWith('/demo')) return;
  window.DEMO = true;
  const KEY = 'dnrp_demo_v2';
  const now = () => new Date().toISOString();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now());
  const urls = {}; // file id -> object URL (this visit only)
  const HR = 'demo.hr@example.com';

  function seed() {
    const staff = [
      ['TC9001', 'Ahmad Demo Bin Ali', '90000001'], ['TC9002', 'Siti Contoh Binti Hassan', '90000002'],
      ['TC9003', 'Raj Sample A/L Kumar', '90000003'], ['TC9004', 'Tan Example Wei', '90000004'],
      ['TC9005', 'Nurul Test Binti Omar', '90000005'], ['TC9006', 'Lim Trial Kok Wah', '90000006']
    ].map(([tc_id, name, dn_person_no]) => ({ tc_id, name, dn_person_no, email: '', active: 1 }));
    const claims = [], files = [];
    const C = (tc, month, category, approved, fl = []) => {
      const s = staff.find(x => x.tc_id === tc);
      const c = { id: uid(), month, tc_id: tc, dn_person_no: s.dn_person_no, name: s.name, category, approved, read: 0, status: 'Not submitted',
        flags: [], hr_status: null, hr_note: null, reviewed_by: null, source_ref: `${month} sheet` };
      claims.push(c);
      for (const [name, read, flags] of fl) files.push({ id: uid(), claim_id: c.id, name, read, method: 'Demo', flags: flags || [], hash: uid(), at: now(), by: tc });
      return c;
    };
    C('TC9001', '2026-10', 'Medical', 12000, [['klinik.jpg', 12000]]);
    C('TC9001', '2026-10', 'Toll', 4560, [['toll1.jpg', 2000], ['toll2.jpg', 2000]]);
    C('TC9001', '2026-10', 'Mileage', 21000);
    C('TC9002', '2026-10', 'Medical', 8500, [['clinic.jpg', 8500, ['Patient "Hassan Bin Yusof" is not the staff or a child of the staff.']]]);
    C('TC9002', '2026-10', 'Car Maintenance', 30000, [['bengkel.jpg', 30000]]);
    C('TC9003', '2026-10', 'Parking (Office)', 15000, [['parking.pdf', 15000]]);
    C('TC9004', '2026-10', 'Handphone', 9800, [['bill.jpg', 9800, ['Not a receipt (screenshot of a claim form).']]]);
    C('TC9005', '2026-10', 'Optical/Dental', 35000);
    C('TC9006', '2026-10', 'Transportation', 1400, [['ferry.jpg', 1400]]);
    C('TC9001', '2026-09', 'Toll', 6100, [['tng.pdf', 6100]]);
    C('TC9004', '2026-09', 'Accommodation', 22000, [['hotel.pdf', 22000]]);
    const S = { staff, claims, files, ent: [{ dn_person_no: '90000002', category: 'Car Maintenance', annual_sen: 25000 }],
      audit: [{ id: 1, at: now(), actor: 'demo', action: 'demo_start', ref: null, detail: '{"note":"Demo data loaded"}' }] };
    S.claims.forEach(c => recompute(S, c));
    return S;
  }
  function recompute(S, c) {
    const fl = S.files.filter(f => f.claim_id === c.id);
    const flags = []; let total = 0;
    for (const f of fl) { for (const x of f.flags) flags.push(`${f.name}: ${x}`); total += f.read || 0; }
    const e = S.ent.find(x => x.dn_person_no === c.dn_person_no && x.category === c.category);
    if (e) { const ytd = S.claims.filter(x => x.dn_person_no === c.dn_person_no && x.category === c.category && x.month.slice(0, 4) === c.month.slice(0, 4) && x.month <= c.month).reduce((a, x) => a + x.approved, 0);
      if (ytd > e.annual_sen) flags.push(`Entitlement: approved so far in ${c.month.slice(0, 4)} is RM ${(ytd / 100).toFixed(2)}, above the annual limit of RM ${(e.annual_sen / 100).toFixed(2)}.`); }
    c.read = total; c.flags = flags;
    c.status = !fl.length ? 'Not submitted' : flags.length ? 'HR check' : total >= c.approved ? 'Cleared' : 'Short';
  }
  let S;
  try { S = JSON.parse(localStorage.getItem(KEY)) || seed(); } catch { S = seed(); }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* demo only */ } };
  const log = (actor, action, ref, detail) => { S.audit.unshift({ id: S.audit.length + 1, at: now(), actor, action, ref, detail: JSON.stringify(detail || {}) }); };
  window.demoReset = () => { try { localStorage.removeItem(KEY); } catch {} location.reload(); };

  const isHrPage = /\/demo\/hr/.test(location.pathname);
  const ok = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }));
  const err = (msg, status = 400) => ok({ error: msg }, status);
  const filesOf = (c) => S.files.filter(f => f.claim_id === c.id);
  const pub = (c) => ({ id: c.id, month: c.month, category: c.category, approved: c.approved, read: c.read, status: c.hr_status || c.status, flags: c.flags, hr_note: c.hr_note,
    files: filesOf(c).map(f => ({ id: f.id, name: f.name, read: f.read, method: f.method })) });
  const normTc = (v) => String(v || '').replace(/\s+/g, '').toUpperCase();

  function svgReceipt(f) {
    const t = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="560"><rect width="100%" height="100%" fill="#fff"/>
      <text x="30" y="50" font-family="monospace" font-size="20">DEMO RECEIPT</text>
      <text x="30" y="90" font-family="monospace" font-size="15">${String(f.name).replace(/[<&]/g, '')}</text>
      <text x="30" y="220" font-family="monospace" font-size="22">TOTAL RM ${((f.read || 0) / 100).toFixed(2)}</text>
      <text x="30" y="520" font-family="monospace" font-size="12" fill="#999">Sample only - not a real receipt</text></svg>`;
    return URL.createObjectURL(new Blob([t], { type: 'image/svg+xml' }));
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async function (input, opts = {}) {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, opts);
    const m = (opts.method || 'GET').toUpperCase(), p = url.pathname;
    const body = () => { try { return JSON.parse(opts.body || '{}'); } catch { return {}; } };
    let mm;

    if (p === '/api/me') return ok(isHrPage ? { email: HR, isHR: true } : { open: true });

    if (p === '/api/my-claims' && m === 'POST') {
      const tc = normTc(body().tc_id); const s = S.staff.find(x => x.tc_id === tc && x.active);
      if (!s) return err(`Staff ID ${tc || '?'} is not on the DN staff list. In the demo, use TC9001 to TC9006.`, 404);
      const months = [...new Set(S.claims.filter(c => c.tc_id === tc).map(c => c.month))].sort().reverse().slice(0, 3);
      const list = S.claims.filter(c => c.tc_id === tc && months.includes(c.month)).sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category));
      return ok({ tc_id: s.tc_id, name: s.name, claims: list.map(pub) });
    }

    if ((mm = p.match(/^\/api\/claims\/([^/]+)\/photo$/)) && m === 'POST') {
      const c = S.claims.find(x => x.id === mm[1]); if (!c) return err('Claim not found.', 404);
      const fd = opts.body, tc = normTc(fd.get('tc_id')), file = fd.get('file');
      if (!isHrPage && tc !== c.tc_id) return err('This claim is not under your staff ID.', 403);
      if (c.hr_status) return err('HR has already decided on this claim. Contact HR to change it.');
      const buf = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      const dup = S.files.find(f => f.hash === hash);
      if (dup) return err(`This photo was already uploaded on ${dup.at.slice(0, 10)}. The same receipt cannot be used twice.`);
      await new Promise(r => setTimeout(r, 900)); // pretend to read
      const n = file.name.toLowerCase(), need = Math.max(0, c.approved - c.read), flags = [];
      let read = need || c.approved;
      if (n.includes('half')) read = Math.round(need / 2);
      if (n.includes('spouse')) flags.push('Patient is the spouse. Only the staff and children are covered.');
      if (n.includes('menu')) { flags.push('Not a receipt (menu).'); read = 0; }
      const f = { id: uid(), claim_id: c.id, name: file.name, read, method: 'Demo', flags, hash, at: now(), by: isHrPage ? HR : tc };
      urls[f.id] = URL.createObjectURL(file); S.files.push(f); recompute(S, c);
      log(f.by, 'photo', c.id, { file: file.name, read }); save();
      return ok({ ok: true, file: { id: f.id, name: f.name, read, method: 'Demo', flags }, claim: pub(c) });
    }
    if ((mm = p.match(/^\/api\/claims\/([^/]+)\/photo\/([^/]+)\/remove$/)) && m === 'POST') {
      const c = S.claims.find(x => x.id === mm[1]); if (!c) return err('Claim not found.', 404);
      if (!isHrPage && normTc(body().tc_id) !== c.tc_id) return err('Not your claim.', 403);
      S.files = S.files.filter(f => f.id !== mm[2]); recompute(S, c); log(isHrPage ? HR : c.tc_id, 'photo_remove', c.id, {}); save();
      return ok({ ok: true, claim: pub(c) });
    }

    if (!isHrPage) return err('Not available in the demo.', 404);

    if (p === '/api/dn/upload' && m === 'POST') {
      const b = body(), months = new Set(), seen = new Set(); let unmatched = 0;
      const agg = new Map();
      for (const l of b.lines || []) { const k = `${l.month}|${l.personNo}|${l.category}`; const a = agg.get(k) || { ...l, sen: 0 }; a.sen += l.sen; agg.set(k, a); months.add(l.month); }
      for (const l of agg.values()) {
        const s = S.staff.find(x => String(x.dn_person_no) === String(l.personNo)); if (!s) unmatched++;
        let c = S.claims.find(x => x.month === l.month && String(x.dn_person_no) === String(l.personNo) && x.category === l.category);
        if (!c) { c = { id: uid(), month: l.month, dn_person_no: String(l.personNo), category: l.category, read: 0, flags: [], hr_status: null, hr_note: null, reviewed_by: null }; S.claims.push(c); }
        Object.assign(c, { tc_id: s ? s.tc_id : null, name: s ? s.name : l.name, approved: l.sen, source_ref: l.ref }); seen.add(c.id);
      }
      S.claims = S.claims.filter(c => !months.has(c.month) || seen.has(c.id) || filesOf(c).length);
      S.claims.forEach(c => { if (months.has(c.month) && !seen.has(c.id)) c.approved = 0; recompute(S, c); });
      log(HR, 'dn_upload', null, { file: b.file_name, lines: agg.size }); save();
      return ok({ ok: true, months: [...months].sort(), lines: agg.size, unmatched });
    }
    if (p === '/api/dn/months') {
      const ms = [...new Set(S.claims.map(c => c.month))].sort().reverse();
      return ok({ months: ms.map(mo => { const l = S.claims.filter(c => c.month === mo);
        return { month: mo, lines: l.length, approved: l.reduce((a, c) => a + c.approved, 0), cleared: l.filter(c => ['Cleared', 'Cleared by HR'].includes(c.hr_status || c.status)).length }; }) });
    }
    if (p === '/api/claims' && m === 'GET') {
      const mo = url.searchParams.get('month');
      return ok({ claims: S.claims.filter(c => c.month === mo).sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.category.localeCompare(b.category))
        .map(c => ({ ...pub(c), tc_id: c.tc_id, name: c.name, dn_person_no: c.dn_person_no, source_ref: c.source_ref, hr_status: c.hr_status, reviewed_by: c.reviewed_by })) });
    }
    if ((mm = p.match(/^\/api\/claims\/([^/]+)\/review$/)) && m === 'POST') {
      const c = S.claims.find(x => x.id === mm[1]), b = body(); if (!c) return err('Claim not found.', 404);
      c.hr_status = b.decision || null; c.hr_note = b.note || null; c.reviewed_by = b.decision ? HR : null;
      log(HR, 'claim_review', c.id, b); save(); return ok({ ok: true });
    }
    if (p === '/api/entitlements' && m === 'GET') return ok({ rows: S.ent });
    if (p === '/api/entitlements' && m === 'POST') {
      for (const r of body().rows || []) { const e = S.ent.find(x => x.dn_person_no === String(r.dn_person_no) && x.category === r.category);
        e ? (e.annual_sen = r.annual_sen) : S.ent.push({ dn_person_no: String(r.dn_person_no), category: r.category, annual_sen: r.annual_sen }); }
      S.claims.forEach(c => recompute(S, c)); log(HR, 'entitlements', null, {}); save(); return ok({ ok: true, saved: (body().rows || []).length });
    }
    if (p === '/api/staff' && m === 'GET') return ok({ staff: S.staff });
    if (p === '/api/staff' && m === 'POST') {
      const list = body().staff || [];
      for (const s of list) {
        const tc = normTc(s.tc_id); if (!/^TC\d+$/.test(tc) || !s.name) continue;
        const ex = S.staff.find(x => x.tc_id === tc);
        const row = { tc_id: tc, name: s.name, dn_person_no: s.dn_person_no || null, email: s.email || '', active: s.active === 0 ? 0 : 1 };
        ex ? Object.assign(ex, row) : S.staff.push(row);
      }
      log(HR, 'staff_upload', null, { rows: list.length }); save();
      return ok({ ok: true, saved: list.length });
    }
    if (p === '/api/audit') return ok({ log: S.audit.slice(0, 500) });
    return err('Not available in the demo.', 404);
  };

  window.demoFileUrl = (id) => { const f = S.files.find(x => x.id === id); return urls[id] || (f ? svgReceipt(f) : ''); };

  document.addEventListener('DOMContentLoaded', () => {
    const b = document.createElement('div');
    b.style.cssText = 'background:#fdf2dc;color:#7a4a00;padding:10px 16px;font-size:14px;border-bottom:1px solid #f0d9a8';
    b.innerHTML = `<div class="wrap"><strong>DEMO</strong> · Made-up staff and claims. Nothing is saved to the real system. The demo does not really read receipts: each upload counts as the missing amount (a file name with "half" reads half, "spouse" or "menu" goes to HR).
      ${isHrPage ? 'Try: <a href="/demo/DN%20demo%20workbook.xlsx">sample DN workbook</a> in "Upload DN approvals".' : 'Use staff ID <strong>TC9001</strong> to <strong>TC9006</strong>.'}
      · <a href="${isHrPage ? '/demo/' : '/demo/hr'}">${isHrPage ? 'Open the staff page' : 'Open the HR page'}</a>
      · <a href="#" onclick="demoReset();return false">Reset demo</a></div>`;
    document.body.insertBefore(b, document.body.firstChild);
    document.title = 'DEMO · ' + document.title;
  });
})();
