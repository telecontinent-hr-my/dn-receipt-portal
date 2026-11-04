// DN approved claims: staff see their DN-approved claim lines, upload receipt photos per line,
// the system reads each receipt (PDF text rules or Cloudflare Workers AI) and checks it automatically.

const AI_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const OPEN_MONTHS = 3; // staff see the latest 3 DN months that have approved claims

// What each DN column means, for the AI category check.
const CATEGORY_HINT = {
  'Medical': 'clinic, hospital, pharmacy or medical bill',
  'Optical/Dental': 'optical shop, spectacles, contact lens or dental clinic',
  'Car Road Tax': 'road tax (JPJ / MyEG)', 'Car Insurance': 'motor insurance / takaful',
  'Car Maintenance': 'car workshop, service, tyres, battery, car parts',
  'Parking (Office)': 'parking', 'Parking': 'parking', 'Toll': 'toll / Touch n Go / highway',
  'Meal Allowance': 'food or meals', 'Mileage': 'fuel / petrol / diesel (mileage claims are paid on fuel receipts)',
  'Accommodation': 'hotel or lodging', 'Transportation': 'ferry, bus, train, flight, taxi, e-hailing or car rental',
  'Streamyx / Internet': 'internet bill', 'Handphone': 'mobile phone bill or prepaid reload',
  'Entertainment': 'meals or entertainment', 'Gift': 'gift purchase', 'Misc Expenses': 'small items, hardware, stationery, car wash or other expenses',
  'Swab Test': 'covid swab or medical test', 'Staff Relation': 'staff event or meals'
};
const PATIENT_CATS = ['Medical', 'Optical/Dental', 'Swab Test'];

const now = () => new Date().toISOString();
class HttpErr extends Error { constructor(s, m) { super(m); this.status = s; } }
const bad = (m) => { throw new HttpErr(400, m); };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const normTc = (v) => { const t = String(v || '').replace(/\s+/g, '').toUpperCase(); return /^TC\d{3,6}$/.test(t) ? t : ''; };
const toSen = (v) => (v === null || v === undefined || v === '' || isNaN(+v)) ? null : Math.round(+v * 100);

let ready = false;
export async function ensureClaimTables(env) {
  if (ready) return;
  const s = [
    `CREATE TABLE IF NOT EXISTS dn_claims (id TEXT PRIMARY KEY, claim_month TEXT NOT NULL, dn_person_no TEXT NOT NULL, dn_name TEXT,
      tc_id TEXT, category TEXT NOT NULL, approved_sen INTEGER NOT NULL, source_ref TEXT, status TEXT NOT NULL DEFAULT 'Not submitted',
      read_sen INTEGER NOT NULL DEFAULT 0, flags TEXT, hr_status TEXT, hr_note TEXT, reviewed_by TEXT, reviewed_at TEXT, updated_at TEXT,
      UNIQUE (claim_month, dn_person_no, category))`,
    'CREATE INDEX IF NOT EXISTS idx_dn_claims_tc ON dn_claims(tc_id, claim_month)',
    `CREATE TABLE IF NOT EXISTS claim_files (id TEXT PRIMARY KEY, claim_id TEXT NOT NULL, tc_id TEXT, file_key TEXT NOT NULL, file_name TEXT,
      file_type TEXT, file_size INTEGER, file_hash TEXT NOT NULL, read_sen INTEGER, read_json TEXT, method TEXT, removed INTEGER NOT NULL DEFAULT 0,
      uploaded_by TEXT, uploaded_at TEXT)`,
    'CREATE INDEX IF NOT EXISTS idx_claim_files_claim ON claim_files(claim_id)',
    'CREATE INDEX IF NOT EXISTS idx_claim_files_hash ON claim_files(file_hash)',
    `CREATE TABLE IF NOT EXISTS entitlements (dn_person_no TEXT NOT NULL, category TEXT NOT NULL, annual_sen INTEGER NOT NULL, updated_at TEXT,
      PRIMARY KEY (dn_person_no, category))`,
    `CREATE TABLE IF NOT EXISTS dn_uploads (id INTEGER PRIMARY KEY AUTOINCREMENT, file_name TEXT, months TEXT, lines INTEGER, uploaded_by TEXT, at TEXT)`
  ];
  for (const q of s) await env.DB.prepare(q).run();
  ready = true;
}

// ---------------- names ----------------
const STOP = new Set(['BIN', 'BINTI', 'BT', 'BN', 'AL', 'AP', 'A', 'L', 'P', 'ANAK', 'AK', 'MOHD', 'MOHAMAD', 'MOHAMMAD', 'MUHAMMAD', 'MUHAMAD', 'MUHD', 'MD', 'NUR', 'NOR', 'SITI', 'ABDUL', 'ABD']);
const toks = (n) => String(n || '').toUpperCase().replace(/\(.*?\)/g, ' ').split(/[^A-Z]+/).filter(x => x.length > 1);
function givenName(staffName) {
  const t = String(staffName).toUpperCase().split(/\s+/); const out = [];
  for (const w of t) { if (/^(BIN|BINTI|BT|BN|A\/L|A\/P|AL|AP|ANAK|@)$/.test(w)) break; out.push(w); }
  return out.join(' ').split(/[^A-Z]+/).filter(x => x.length > 1 && !STOP.has(x));
}
// Staff themselves, or a child (child's name carries the staff's own given name as father's name).
function patientCheck(patient, staffName) {
  if (!patient) return { ok: false, why: 'Patient name not found on the receipt.' };
  const P = new Set(toks(patient)), S = toks(staffName).filter(x => !STOP.has(x));
  const common = S.filter(x => P.has(x)).length;
  if (S.length && common / S.length >= 0.75) return { ok: true, who: 'staff' };
  const G = givenName(staffName);
  const ptoks = toks(patient);
  const firstP = ptoks[0];
  if (G.length && G.every(g => ptoks.slice(1).includes(g)) && !G.includes(firstP)) return { ok: true, who: 'child' };
  return { ok: false, why: `Patient "${patient}" is not the staff or the staff's child. Spouse and others are not covered.` };
}

// ---------------- reading ----------------
function readPdfText(category, text) {
  if (!text || text.length < 30) return null;
  const t = text.replace(/\r/g, '');
  const isTng = /TNG WALLET|Touch\s*'?n\s*Go|Customer Transactions Statement|ANPR/i.test(t);
  if (category === 'Toll' && isTng) {
    let sen = 0, n = 0;
    for (const m of t.matchAll(/Total Amount\s+([\d,]+\.\d{2})/gi)) { sen += toSen(m[1].replace(/,/g, '')); n++; }
    for (const line of t.split('\n')) {
      if (/(PayDirect Payment|RFID Payment)/i.test(line)) {
        const a = line.match(/RM\s?([\d,]+\.\d{2})/i);
        if (a) { sen += toSen(a[1].replace(/,/g, '')); n++; }
      }
    }
    return n ? { sen, method: 'PDF text (toll lines only)', note: `${n} toll item(s) counted` } : null;
  }
  // generic statement: last "Total ... RM x" line
  const all = [...t.matchAll(/\bTotal(?:\s+Amount)?\s*:?\s*(?:RM|MYR)?\s*([\d,]+\.\d{2})/gi)];
  if (all.length) { const v = all[all.length - 1][1].replace(/,/g, ''); return { sen: toSen(v), method: 'PDF text (statement total)' }; }
  return null;
}

// all dates printed in a PDF's text, as YYYY-MM-DD
function textDates(text) {
  const out = new Set();
  for (const m of String(text || '').matchAll(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/g)) {
    const d = +m[1], mo = +m[2]; if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.add(`${m[3]}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  }
  for (const m of String(text || '').matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) out.add(m[0]);
  return [...out].sort();
}
const MAX_AGE_MONTHS = 6;   // receipt older than this (before the claim month) goes to HR
const TOLERANCE_SEN = 100;  // receipts within RM 1.00 of the DN amount count as a match

function aiPrompt(category, staffName) {
  return `You check expense receipts for a Malaysian company. The staff is "${staffName}". The claim category is "${category}" (${CATEGORY_HINT[category] || 'expense'}).
Look at the image and reply with JSON only (an array if the image shows more than one receipt):
{"is_receipt": true/false, "doc_type": "...", "merchant": "...", "date": "YYYY-MM-DD or null", "patient_or_payer": "... or null", "amount_paid_rm": number or null, "matches_category": true/false, "notes": "short"}
Rules:
- amount_paid_rm = what the customer actually paid in RM, after any subsidy (e.g. BUDI95) or panel/insurance part. Read handwritten amounts carefully (e.g. "400" is four hundred).
- A Touch n Go / toll statement: add up ONLY toll transactions (not reloads, food, investment, car wash, parking).
- A screenshot of a claim or expense app (e.g. SAP Concur), a quotation, a chat, or a page with no payment is NOT a receipt: is_receipt false, amount null.
- If the total cannot be read clearly, amount_paid_rm null.
- matches_category: true ONLY if the document is clearly for "${category}". If it is for something else (e.g. food for a toll claim, petrol for a medical claim) or you are not sure, false.
- date: the transaction date printed on the receipt. If not printed, null.`;
}

function parseAi(out) {
  let v = out && (out.response ?? out.result?.response);
  if (v === undefined && out?.choices) v = out.choices[0]?.message?.content;
  if (typeof v === 'string') {
    const m = v.match(/(\[[\s\S]*\]|\{[\s\S]*\})/); if (!m) return null;
    try { v = JSON.parse(m[1]); } catch { return null; }
  }
  if (!v) return null;
  return Array.isArray(v) ? v : [v];
}

async function aiRead(env, b64, category, staffName) {
  if (!env.AI) return { error: 'AI reader not available' };
  try {
    const out = await env.AI.run(AI_MODEL, {
      messages: [{ role: 'user', content: [{ type: 'text', text: aiPrompt(category, staffName) }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } }] }],
      max_tokens: 700, temperature: 0
    });
    const items = parseAi(out);
    return items ? { items } : { error: 'AI reply not understood' };
  } catch (e) { return { error: 'AI error: ' + String(e.message || e).slice(0, 120) }; }
}

// ---------------- status ----------------
async function recompute(env, claimId) {
  const c = await env.DB.prepare('SELECT * FROM dn_claims WHERE id=?').bind(claimId).first();
  if (!c) return null;
  const files = (await env.DB.prepare('SELECT * FROM claim_files WHERE claim_id=? AND removed=0').bind(claimId).all()).results;
  const flags = [];
  let total = 0;
  for (const f of files) {
    const r = f.read_json ? JSON.parse(f.read_json) : {};
    for (const x of (r.flags || [])) flags.push(`${f.file_name}: ${x}`);
    if (f.read_sen === null) flags.push(`${f.file_name}: amount could not be read.`);
    else total += f.read_sen;
    // receipt date must be inside the claim month or up to 6 months before it
    const okDate = (d) => /^20\d{2}-\d{2}-\d{2}$/.test(d || '');
    const dates = (String(f.method || '').startsWith('PDF text') && r.text_dates && r.text_dates.length ? r.text_dates : (r.items || []).map(i => i.date)).filter(okDate).sort();
    const [y, mo] = c.claim_month.split('-').map(Number);
    const end = `${c.claim_month}-31`, startD = new Date(Date.UTC(y, mo - 1 - MAX_AGE_MONTHS, 1)).toISOString().slice(0, 10);
    const fmt = (d) => d.split('-').reverse().join('/');
    if (!dates.length) flags.push(`${f.file_name}: receipt date could not be read.`);
    else if (dates[dates.length - 1] > end) flags.push(`${f.file_name}: dated ${fmt(dates[dates.length - 1])}, after the claim month.`);
    else if (dates[0] < startD) flags.push(`${f.file_name}: dated ${fmt(dates[0])}, more than ${MAX_AGE_MONTHS} months before the claim month.`);
  }
  if (files.length && total > c.approved_sen + TOLERANCE_SEN)
    flags.push(`Receipts total RM ${(total / 100).toFixed(2)} is more than the DN amount of RM ${(c.approved_sen / 100).toFixed(2)}. Check that these are the right receipts.`);
  // entitlement (per DN person, per year)
  const ent = await env.DB.prepare('SELECT annual_sen FROM entitlements WHERE dn_person_no=? AND category=?').bind(c.dn_person_no, c.category).first();
  if (ent) {
    const y = c.claim_month.slice(0, 4);
    const ytd = await env.DB.prepare("SELECT COALESCE(SUM(approved_sen),0) AS s FROM dn_claims WHERE dn_person_no=? AND category=? AND claim_month LIKE ? AND claim_month<=?")
      .bind(c.dn_person_no, c.category, y + '-%', c.claim_month).first();
    if (ytd.s > ent.annual_sen) flags.push(`Entitlement: approved so far in ${y} is RM ${(ytd.s / 100).toFixed(2)}, above the annual limit of RM ${(ent.annual_sen / 100).toFixed(2)}.`);
  }
  let status;
  if (!files.length) status = 'Not submitted';
  else if (flags.length) status = 'HR check';
  else if (total >= c.approved_sen - TOLERANCE_SEN) status = 'Cleared';
  else status = 'Short';
  await env.DB.prepare('UPDATE dn_claims SET status=?, read_sen=?, flags=?, updated_at=? WHERE id=?')
    .bind(status, total, JSON.stringify(flags), now(), claimId).run();
  return { ...c, status, read_sen: total, flags: JSON.stringify(flags) };
}

const pubClaim = (c, files) => ({
  id: c.id, month: c.claim_month, category: c.category, approved: c.approved_sen, read: c.read_sen,
  status: c.hr_status || c.status, flags: JSON.parse(c.flags || '[]'), hr_note: c.hr_note,
  files: (files || []).map(f => ({ id: f.id, name: f.file_name, read: f.read_sen, method: f.method }))
});

// ---------------- routes ----------------
export async function claimRoutes(request, env, url, user, ctx) {
  const p = url.pathname, m = request.method;
  const isHR = !!user?.isHR;
  let mm;
  if (!p.startsWith('/api/claims') && !p.startsWith('/api/my-claims') && !p.startsWith('/api/dn/') && !p.startsWith('/api/entitlements') && !p.startsWith('/api/claimfile')) return null;
  await ensureClaimTables(env);
  try {
    // ----- staff (open) -----
    if (!isHR && m === 'POST') await limit(env, request, p.startsWith('/api/my-claims') ? 'lookup' : 'photo', p.startsWith('/api/my-claims') ? 60 : 80);
    if (p === '/api/my-claims' && m === 'POST') {
      const tc = normTc((await request.json().catch(() => ({}))).tc_id);
      if (!tc) bad('Enter your staff ID, e.g. TC4736.');
      const s = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=? AND active=1').bind(tc).first();
      if (!s) throw new HttpErr(404, `Staff ID ${tc} is not on the DN staff list. Please check the ID or contact HR.`);
      const months = (await env.DB.prepare(`SELECT DISTINCT claim_month FROM dn_claims WHERE (tc_id=? OR dn_person_no=?) ORDER BY claim_month DESC LIMIT ${OPEN_MONTHS}`)
        .bind(tc, s.dn_person_no || '-').all()).results.map(r => r.claim_month);
      if (months.length) { const withFiles = (await env.DB.prepare(`SELECT DISTINCT d.id FROM dn_claims d JOIN claim_files f ON f.claim_id=d.id AND f.removed=0
          WHERE (d.tc_id=? OR d.dn_person_no=?) AND d.claim_month IN (${months.map(() => '?').join(',')})`).bind(tc, s.dn_person_no || '-', ...months).all()).results;
        for (const w of withFiles) await recompute(env, w.id); }
      const claims = months.length ? (await env.DB.prepare(`SELECT * FROM dn_claims WHERE (tc_id=? OR dn_person_no=?) AND claim_month IN (${months.map(() => '?').join(',')}) ORDER BY claim_month DESC, category`)
        .bind(tc, s.dn_person_no || '-', ...months).all()).results : [];
      const files = claims.length ? (await env.DB.prepare(`SELECT * FROM claim_files WHERE removed=0 AND claim_id IN (${claims.map(() => '?').join(',')}) ORDER BY uploaded_at`)
        .bind(...claims.map(c => c.id)).all()).results : [];
      return json({ tc_id: s.tc_id, name: s.name, claims: claims.map(c => pubClaim(c, files.filter(f => f.claim_id === c.id))) });
    }

    if ((mm = p.match(/^\/api\/claims\/([\w-]+)\/photo$/)) && m === 'POST') {
      const c = await env.DB.prepare('SELECT * FROM dn_claims WHERE id=?').bind(mm[1]).first();
      if (!c) throw new HttpErr(404, 'Claim not found.');
      const form = await request.formData();
      const tc = normTc(form.get('tc_id'));
      if (!isHR && (!tc || c.tc_id !== tc)) throw new HttpErr(403, 'This claim is not under your staff ID.');
      if (c.hr_status) bad('HR has already decided on this claim. Contact HR to change it.');
      const staff = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=?').bind(c.tc_id || tc).first();
      const file = form.get('file');
      if (!file || typeof file === 'string') bad('Attach a receipt photo or PDF.');
      if (file.size > MAX_FILE_BYTES) bad(`"${file.name}" is larger than 10 MB.`);
      const type = (file.type || '').toLowerCase();
      if (!ALLOWED.includes(type)) bad(`"${file.name}": only photo or PDF files are accepted.`);
      const buf = await file.arrayBuffer();
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
      const dup = await env.DB.prepare(`SELECT f.uploaded_at, d.category, d.claim_month, d.tc_id FROM claim_files f JOIN dn_claims d ON d.id=f.claim_id
          WHERE f.file_hash=? AND f.removed=0 LIMIT 1`).bind(hash).first();
      if (dup) bad(isHR ? `This file was already uploaded on ${dup.uploaded_at.slice(0, 10)} (${dup.tc_id}, ${dup.category}, ${dup.claim_month}).`
        : `This photo was already uploaded on ${dup.uploaded_at.slice(0, 10)}${dup.tc_id === c.tc_id ? ` for ${dup.category} (${dup.claim_month})` : ''}. The same receipt cannot be used twice.`);

      // read
      const staffName = staff?.name || c.dn_name || '';
      let read = null, method = null; const flags = []; let items = [];
      const pdfText = String(form.get('pdf_text') || '');
      if (type === 'application/pdf') { const r = readPdfText(c.category, pdfText); if (r) { read = r.sen; method = r.method; } }
      const textRead = read !== null;
      {
        // The AI always checks the nature of the document (is it a receipt, does it fit the category, patient name).
        // When the PDF text already gave the amount, it looks at the first page(s) only and the text amount is kept.
        const pages = form.getAll('ai_b64').map(String).filter(x => x.length > 100).slice(0, textRead ? (PATIENT_CATS.includes(c.category) ? 2 : 1) : 8);
        if (!pages.length) flags.push('No readable image was sent.');
        const results = await Promise.all(pages.map(b => aiRead(env, b, c.category, staffName)));
        let sum = 0, unknown = false;
        for (const r of results) {
          if (r.error) { flags.push(r.error); unknown = true; continue; }
          for (const it of r.items) {
            items.push(it);
            if (it.is_receipt === false) { flags.push(`Not a receipt (${it.doc_type || 'unknown document'}).`); continue; }
            const s = toSen(it.amount_paid_rm);
            if (s === null) unknown = true; else sum += s;
            if (it.matches_category !== true) flags.push(`Looks like ${it.doc_type || 'another type'}${it.merchant ? ' from ' + it.merchant : ''}, not clearly ${c.category}.`);
          }
        }
        if (textRead) { for (let i = flags.length - 1; i >= 0; i--) if (!/^Not a receipt|^Looks like/.test(flags[i])) flags.splice(i, 1); }
        else {
          read = unknown && sum === 0 ? null : sum;
          if (unknown && sum > 0) flags.push('Part of the receipt could not be read.');
          method = 'AI';
        }
      }
      if (PATIENT_CATS.includes(c.category)) {
        const names = items.map(i => i.patient_or_payer).filter(Boolean);
        if (items.length) {
          const bad2 = names.map(n => patientCheck(n, staffName)).filter(x => !x.ok);
          if (!names.length) flags.push('Patient name not found on the receipt.');
          else if (bad2.length) flags.push(bad2[0].why);
        } else if (textRead) flags.push('Patient name could not be checked.');
      }
      const id = crypto.randomUUID();
      const key = `claims/${c.claim_month}/${c.tc_id || tc}/${id}-${(file.name || 'receipt').replace(/[^\w.\- ]/g, '_').slice(0, 100)}`;
      await env.RECEIPTS.put(key, buf, { httpMetadata: { contentType: type } });
      await env.DB.prepare(`INSERT INTO claim_files (id,claim_id,tc_id,file_key,file_name,file_type,file_size,file_hash,read_sen,read_json,method,uploaded_by,uploaded_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(id, c.id, c.tc_id || tc, key, (file.name || 'receipt').slice(0, 120), type, file.size, hash,
        read, JSON.stringify({ items, flags, text_dates: textDates(pdfText) }), method, isHR ? user.email : `${tc} (staff form)`, now()).run();
      const nc = await recompute(env, c.id);
      await audit(env, isHR ? user.email : `${tc} (staff form)`, 'photo', c.id, { file: file.name, read, method, flags, ip: request.headers.get('CF-Connecting-IP') || '' });
      const files = (await env.DB.prepare('SELECT * FROM claim_files WHERE claim_id=? AND removed=0').bind(c.id).all()).results;
      return json({ ok: true, file: { id, name: file.name, read, method, flags }, claim: pubClaim(nc, files) });
    }

    if ((mm = p.match(/^\/api\/claims\/([\w-]+)\/photo\/([\w-]+)\/remove$/)) && m === 'POST') {
      const c = await env.DB.prepare('SELECT * FROM dn_claims WHERE id=?').bind(mm[1]).first();
      if (!c) throw new HttpErr(404, 'Claim not found.');
      const tc = normTc((await request.json().catch(() => ({}))).tc_id);
      if (!isHR && (!tc || c.tc_id !== tc)) throw new HttpErr(403, 'Not your claim.');
      if (c.hr_status && !isHR) bad('HR has already decided on this claim.');
      await env.DB.prepare('UPDATE claim_files SET removed=1 WHERE id=? AND claim_id=?').bind(mm[2], c.id).run();
      const nc = await recompute(env, c.id);
      await audit(env, isHR ? user.email : `${tc} (staff form)`, 'photo_remove', c.id, { file: mm[2] });
      const files = (await env.DB.prepare('SELECT * FROM claim_files WHERE claim_id=? AND removed=0').bind(c.id).all()).results;
      return json({ ok: true, claim: pubClaim(nc, files) });
    }

    // ----- HR only below -----
    if (!isHR) throw new HttpErr(401, 'Not signed in. Open the portal link again.');

    if (p === '/api/dn/upload' && m === 'POST') {
      const b = await request.json();
      const lines = Array.isArray(b.lines) ? b.lines : bad('No lines.');
      const staff = (await env.DB.prepare('SELECT tc_id, name, dn_person_no FROM staff').all()).results;
      const byNo = new Map(staff.filter(s => s.dn_person_no).map(s => [String(s.dn_person_no), s]));
      const stmts = []; const months = new Set(); let unmatched = 0;
      // merge duplicate lines (same person/category/month)
      const agg = new Map();
      for (const l of lines) {
        if (!/^\d{4}-\d{2}$/.test(l.month) || !l.personNo || !l.category || !(l.sen > 0)) continue;
        const k = `${l.month}|${l.personNo}|${l.category}`;
        const a = agg.get(k) || { ...l, sen: 0, refs: [] }; a.sen += Math.round(l.sen); a.refs.push(l.ref); agg.set(k, a);
      }
      for (const l of agg.values()) {
        months.add(l.month);
        const s = byNo.get(String(l.personNo));
        if (!s) unmatched++;
        stmts.push(env.DB.prepare(`INSERT INTO dn_claims (id,claim_month,dn_person_no,dn_name,tc_id,category,approved_sen,source_ref,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(claim_month,dn_person_no,category) DO UPDATE SET approved_sen=excluded.approved_sen,
          dn_name=excluded.dn_name, tc_id=COALESCE(excluded.tc_id, dn_claims.tc_id), source_ref=excluded.source_ref, updated_at=excluded.updated_at`)
          .bind(crypto.randomUUID(), l.month, String(l.personNo), String(l.name || '').slice(0, 120), s ? s.tc_id : null, l.category, l.sen, l.refs.join(', ').slice(0, 300), now()));
      }
      for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
      // lines that are no longer in the workbook and have no photos: remove
      for (const mo of months) {
        const keep = [...agg.values()].filter(l => l.month === mo).map(l => `${l.personNo}|${l.category}`);
        const ex = (await env.DB.prepare('SELECT id, dn_person_no, category FROM dn_claims WHERE claim_month=?').bind(mo).all()).results;
        for (const e of ex) if (!keep.includes(`${e.dn_person_no}|${e.category}`)) {
          const has = await env.DB.prepare('SELECT 1 FROM claim_files WHERE claim_id=? AND removed=0 LIMIT 1').bind(e.id).first();
          if (!has) await env.DB.prepare('DELETE FROM dn_claims WHERE id=?').bind(e.id).run();
          else await env.DB.prepare("UPDATE dn_claims SET approved_sen=0, updated_at=? WHERE id=?").bind(now(), e.id).run();
        }
        const ids = (await env.DB.prepare('SELECT id FROM dn_claims WHERE claim_month=? AND status!=?').bind(mo, 'Not submitted').all()).results;
        for (const r of ids) await recompute(env, r.id);
      }
      await env.DB.prepare('INSERT INTO dn_uploads (file_name, months, lines, uploaded_by, at) VALUES (?,?,?,?,?)')
        .bind(String(b.file_name || '').slice(0, 200), [...months].sort().join(','), agg.size, user.email, now()).run();
      await audit(env, user.email, 'dn_upload', null, { file: b.file_name, months: [...months], lines: agg.size, unmatched });
      return json({ ok: true, months: [...months].sort(), lines: agg.size, unmatched });
    }

    if (p === '/api/dn/months' && m === 'GET') {
      const r = (await env.DB.prepare(`SELECT claim_month AS month, COUNT(*) AS lines, SUM(approved_sen) AS approved,
        SUM(CASE WHEN COALESCE(hr_status,status) IN ('Cleared','Cleared by HR') THEN 1 ELSE 0 END) AS cleared
        FROM dn_claims GROUP BY claim_month ORDER BY claim_month DESC`).all()).results;
      const up = (await env.DB.prepare('SELECT * FROM dn_uploads ORDER BY id DESC LIMIT 5').all()).results;
      return json({ months: r, uploads: up });
    }

    if (p === '/api/claims' && m === 'GET') {
      const mo = url.searchParams.get('month');
      const withFiles = (await env.DB.prepare('SELECT DISTINCT d.id FROM dn_claims d JOIN claim_files f ON f.claim_id=d.id AND f.removed=0 WHERE d.claim_month=?').bind(mo).all()).results;
      for (const w of withFiles) await recompute(env, w.id);
      const claims = (await env.DB.prepare(`SELECT d.*, s.name AS staff_name FROM dn_claims d LEFT JOIN staff s ON s.tc_id=d.tc_id WHERE d.claim_month=? ORDER BY COALESCE(s.name,d.dn_name), d.category`).bind(mo).all()).results;
      const files = (await env.DB.prepare(`SELECT f.id, f.claim_id, f.file_name, f.read_sen, f.method, f.read_json, f.uploaded_by, f.uploaded_at FROM claim_files f JOIN dn_claims d ON d.id=f.claim_id WHERE d.claim_month=? AND f.removed=0 ORDER BY f.uploaded_at`).bind(mo).all()).results;
      return json({ claims: claims.map(c => ({ ...pubClaim(c, []), tc_id: c.tc_id, name: c.staff_name || c.dn_name, dn_person_no: c.dn_person_no, source_ref: c.source_ref,
        auto_status: c.status, hr_status: c.hr_status, reviewed_by: c.reviewed_by, reviewed_at: c.reviewed_at,
        files: files.filter(f => f.claim_id === c.id).map(f => ({ id: f.id, name: f.file_name, read: f.read_sen, method: f.method, by: f.uploaded_by, at: f.uploaded_at, detail: JSON.parse(f.read_json || '{}') })) })) });
    }

    if ((mm = p.match(/^\/api\/claims\/([\w-]+)\/review$/)) && m === 'POST') {
      const b = await request.json();
      if (!['Cleared by HR', 'Rejected by HR', ''].includes(b.decision)) bad('Invalid decision.');
      if (b.decision === 'Rejected by HR' && !String(b.note || '').trim()) bad('Give the reason.');
      await env.DB.prepare('UPDATE dn_claims SET hr_status=?, hr_note=?, reviewed_by=?, reviewed_at=? WHERE id=?')
        .bind(b.decision || null, String(b.note || '').slice(0, 500) || null, user.email, now(), mm[1]).run();
      await audit(env, user.email, 'claim_review', mm[1], { decision: b.decision, note: b.note });
      return json({ ok: true });
    }

    if ((mm = p.match(/^\/api\/claimfile\/([\w-]+)$/)) && m === 'GET') {
      const f = await env.DB.prepare('SELECT * FROM claim_files WHERE id=?').bind(mm[1]).first();
      if (!f) throw new HttpErr(404, 'File not found.');
      const obj = await env.RECEIPTS.get(f.file_key);
      if (!obj) throw new HttpErr(404, 'File not found.');
      return new Response(obj.body, { headers: { 'content-type': f.file_type, 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
        'content-disposition': `inline; filename="${String(f.file_name).replace(/[^\w.\- ]/g, '_')}"` } });
    }

    if (p === '/api/entitlements' && m === 'POST') {
      const b = await request.json(); const rows = Array.isArray(b.rows) ? b.rows : bad('No rows.');
      const st = rows.filter(r => r.dn_person_no && r.category && r.annual_sen >= 0).map(r =>
        env.DB.prepare('INSERT INTO entitlements (dn_person_no, category, annual_sen, updated_at) VALUES (?,?,?,?) ON CONFLICT(dn_person_no, category) DO UPDATE SET annual_sen=excluded.annual_sen, updated_at=excluded.updated_at')
          .bind(String(r.dn_person_no), r.category, Math.round(r.annual_sen), now()));
      for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
      await audit(env, user.email, 'entitlements_upload', null, { rows: st.length });
      return json({ ok: true, saved: st.length });
    }
    if (p === '/api/entitlements' && m === 'GET') {
      return json({ rows: (await env.DB.prepare('SELECT * FROM entitlements ORDER BY dn_person_no, category').all()).results });
    }
    return null;
  } catch (e) {
    if (e instanceof HttpErr) return json({ error: e.message }, e.status);
    throw e;
  }
}

async function limit(env, request, action, max) {
  const ip = (request.headers.get('CF-Connecting-IP') || 'unknown').replace(/[%_"]/g, '');
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action=? AND at>? AND detail LIKE ?").bind(action, since, `%"ip":"${ip}"%`).first();
  if ((r?.n || 0) >= max) throw new HttpErr(429, 'Too many tries from this network in the last hour. Please try again later.');
  if (action === 'lookup') await audit(env, 'staff form', 'lookup', null, { ip });
}

async function audit(env, actor, action, ref, detail) {
  await env.DB.prepare('INSERT INTO audit_log (at, actor, action, ref, detail) VALUES (?,?,?,?,?)')
    .bind(now(), actor, action, ref || null, detail ? JSON.stringify(detail) : null).run();
}

// exported for tests
export const _test = { readPdfText, patientCheck, parseAi, textDates };
