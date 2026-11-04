// DN Receipt Portal - Cloudflare Worker API
// Telecontinent Sdn Bhd - Human Resources & Administration
//
// Sign-in is done by Cloudflare Access (email PIN). This worker checks the
// Access token on every API call, so the page cannot be used without Access.

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'];
const STATUSES = ['Submitted', 'Accepted', 'Rejected', 'Withdrawn'];

export const CATEGORIES = [
  'Medical', 'Optical/Dental', 'Car Road Tax', 'Car Insurance', 'Car Maintenance',
  'Parking (Office)', 'Meal Allowance', 'Mileage', 'Parking', 'Toll',
  'Accommodation', 'Transportation', 'Streamyx / Internet', 'Handphone',
  'Entertainment', 'Gift', 'Misc Expenses', 'Swab Test', 'Staff Relation'
];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/login' && request.method === 'POST') return await login(request, env);
      if (url.pathname === '/api/logout' && request.method === 'POST') return new Response('{"ok":true}', { headers: {
        'content-type': 'application/json', 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
      const user = await identify(request, env);
      if (!user) return json({ error: 'Not signed in. Open the portal link again.' }, 401);
      return await route(request, env, url, user);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status);
      console.error(e);
      return json({ error: 'System error. Please try again or contact HR.' }, 500);
    }
  }
};

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});
const now = () => new Date().toISOString();
const bad = (msg) => { throw new HttpError(400, msg); };

// ---------- identity ----------
// HR: Cloudflare Access (email PIN) on /hr.html. Access token is read from the header or the CF_Authorization cookie.
// Staff: TC ID + 6-digit PIN issued by HR, kept in a signed session cookie (12 hours).
const SESSION_COOKIE = 'dnrp_s';
const SESSION_HOURS = 12;
const cookie = (req, name) => (req.headers.get('cookie') || '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === name)?.slice(1).join('=');
const publicStaff = (s) => s && ({ tc_id: s.tc_id, name: s.name, dn_person_no: s.dn_person_no });

async function identify(request, env) {
  const hrList = (env.HR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  let email = null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (token && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) email = await verifyAccessJwt(token, env).catch(() => null);
  if (!email && env.DEV_MODE === '1') email = request.headers.get('x-dev-user') || env.DEV_USER_EMAIL || null; // local testing only
  if (email) {
    email = email.trim().toLowerCase();
    if (hrList.includes(email)) return { email, isHR: true, staff: null };
  }
  // staff session
  const tc = await readSession(cookie(request, SESSION_COOKIE), env);
  if (tc) {
    const staff = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=? AND active=1').bind(tc).first();
    if (staff) return { email: `${staff.tc_id} (staff login)`, isHR: false, staff };
  }
  return null;
}

async function hmac(env, text) {
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) throw new HttpError(500, 'SESSION_SECRET is not set. See README step 5.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text))));
}
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function makeSession(env, tc, pinSetAt) {
  const body = `${tc}.${Date.now() + SESSION_HOURS * 3600_000}.${b64url(new TextEncoder().encode(pinSetAt || ''))}`;
  return `${body}.${await hmac(env, body)}`;
}
async function readSession(val, env) {
  if (!val) return null;
  const parts = val.split('.'); if (parts.length !== 4) return null;
  const body = parts.slice(0, 3).join('.');
  if ((await hmac(env, body)) !== parts[3]) return null;
  if (+parts[1] < Date.now()) return null;
  // a PIN reset by HR ends old sessions
  const s = await env.DB.prepare('SELECT pin_set_at FROM staff WHERE tc_id=?').bind(parts[0]).first();
  if (!s || b64url(new TextEncoder().encode(s.pin_set_at || '')) !== parts[2]) return null;
  return parts[0];
}
async function hashPin(pin, saltB64) {
  const salt = saltB64 ? b64urlBytes(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { hash: b64url(new Uint8Array(bits)), salt: b64url(salt) };
}

async function login(request, env) {
  const body = await request.json().catch(() => ({}));
  const tc = String(body.tc_id || '').replace(/\s+/g, '').toUpperCase();
  const pin = String(body.pin || '').trim();
  const fail = () => json({ error: 'Staff ID or PIN is not correct.' }, 401);
  if (!/^TC\d+$/.test(tc) || !/^\d{6}$/.test(pin)) return fail();
  const s = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=? AND active=1').bind(tc).first();
  if (!s || !s.pin_hash) return fail();
  if (s.locked_until && s.locked_until > now()) return json({ error: 'Too many wrong tries. Try again after 15 minutes or ask HR to reset your PIN.' }, 429);
  const { hash } = await hashPin(pin, s.pin_salt);
  if (hash !== s.pin_hash) {
    const n = (s.failed_logins || 0) + 1;
    const lock = n >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    await env.DB.prepare('UPDATE staff SET failed_logins=?, locked_until=? WHERE tc_id=?').bind(lock ? 0 : n, lock, tc).run();
    await audit(env, tc, 'login_failed', tc, { attempt: n, locked: !!lock });
    return fail();
  }
  await env.DB.prepare('UPDATE staff SET failed_logins=0, locked_until=NULL WHERE tc_id=?').bind(tc).run();
  await audit(env, tc, 'login', tc);
  const secure = new URL(request.url).protocol === 'https:' ? ' Secure;' : '';
  return new Response(JSON.stringify({ ok: true }), { headers: {
    'content-type': 'application/json', 'cache-control': 'no-store',
    'set-cookie': `${SESSION_COOKIE}=${await makeSession(env, tc, s.pin_set_at)}; Path=/; HttpOnly;${secure} SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}`
  }});
}

let certCache = { at: 0, keys: [] };
async function verifyAccessJwt(token, env) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return null;
  const header = JSON.parse(b64urlText(h));
  const payload = JSON.parse(b64urlText(p));
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD)) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  const team = env.ACCESS_TEAM_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (payload.iss && payload.iss !== `https://${team}`) return null;
  if (Date.now() - certCache.at > 3600_000 || !certCache.keys.length) {
    const r = await fetch(`https://${team}/cdn-cgi/access/certs`);
    certCache = { at: Date.now(), keys: (await r.json()).keys || [] };
  }
  const jwk = certCache.keys.find(k => k.kid === header.kid);
  if (!jwk) return null;
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(s), new TextEncoder().encode(`${h}.${p}`));
  return ok ? payload.email : null;
}
function b64urlBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}
const b64urlText = (s) => new TextDecoder().decode(b64urlBytes(s));

async function audit(env, actor, action, ref, detail) {
  await env.DB.prepare('INSERT INTO audit_log (at, actor, action, ref, detail) VALUES (?,?,?,?,?)')
    .bind(now(), actor, action, ref || null, detail ? JSON.stringify(detail) : null).run();
}

// ---------- routes ----------
async function route(request, env, url, user) {
  const m = request.method;
  const path = url.pathname;
  const requireHR = () => { if (!user.isHR) throw new HttpError(403, 'HR access only.'); };

  if (path === '/api/me' && m === 'GET') {
    return json({ email: user.email, isHR: user.isHR, staff: publicStaff(user.staff), categories: CATEGORIES });
  }

  if (path === '/api/receipts' && m === 'POST') return createReceipt(request, env, user);

  if (path === '/api/receipts' && m === 'GET') {
    const month = url.searchParams.get('month');
    if (user.isHR && url.searchParams.get('scope') !== 'mine') {
      const sql = month
        ? 'SELECT r.*, s.name AS staff_name, s.dn_person_no FROM receipts r LEFT JOIN staff s ON s.tc_id=r.tc_id WHERE r.claim_month=? ORDER BY r.tc_id, r.category, r.expense_date'
        : 'SELECT r.*, s.name AS staff_name, s.dn_person_no FROM receipts r LEFT JOIN staff s ON s.tc_id=r.tc_id ORDER BY r.claim_month DESC, r.tc_id';
      const q = month ? env.DB.prepare(sql).bind(month) : env.DB.prepare(sql);
      return json({ receipts: (await q.all()).results });
    }
    if (!user.staff) return json({ receipts: [] });
    const rs = await env.DB.prepare('SELECT * FROM receipts WHERE tc_id=? ORDER BY submitted_at DESC').bind(user.staff.tc_id).all();
    return json({ receipts: rs.results });
  }

  let mm;
  if ((mm = path.match(/^\/api\/receipts\/([\w-]+)\/withdraw$/)) && m === 'POST') {
    const r = await getReceipt(env, mm[1]);
    if (!user.staff || r.tc_id !== user.staff.tc_id) throw new HttpError(403, 'You can only withdraw your own receipt.');
    if (r.status !== 'Submitted') bad('Only receipts not yet checked by HR can be withdrawn.');
    await env.DB.prepare("UPDATE receipts SET status='Withdrawn' WHERE id=?").bind(r.id).run();
    await audit(env, user.email, 'withdraw', r.id);
    return json({ ok: true });
  }

  if ((mm = path.match(/^\/api\/receipts\/([\w-]+)\/review$/)) && m === 'POST') {
    requireHR();
    const r = await getReceipt(env, mm[1]);
    const body = await request.json();
    if (!['Accepted', 'Rejected', 'Submitted'].includes(body.status)) bad('Invalid status.');
    if (body.status === 'Rejected' && !String(body.note || '').trim()) bad('Give the reason for rejecting.');
    await env.DB.prepare('UPDATE receipts SET status=?, hr_note=?, reviewed_by=?, reviewed_at=? WHERE id=?')
      .bind(body.status, String(body.note || '').slice(0, 500) || null, user.email, now(), r.id).run();
    await audit(env, user.email, 'review', r.id, { from: r.status, to: body.status, note: body.note || '' });
    return json({ ok: true });
  }

  if ((mm = path.match(/^\/api\/file\/([\w-]+)$/)) && m === 'GET') {
    const r = await getReceipt(env, mm[1]);
    if (!user.isHR && (!user.staff || r.tc_id !== user.staff.tc_id)) throw new HttpError(403, 'Not allowed.');
    const obj = await env.RECEIPTS.get(r.file_key);
    if (!obj) throw new HttpError(404, 'File not found.');
    return new Response(obj.body, { headers: {
      'content-type': r.file_type,
      'content-disposition': `inline; filename="${r.file_name.replace(/[^\w.\- ]/g, '_')}"`,
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff'
    }});
  }

  if (path === '/api/staff' && m === 'GET') {
    requireHR();
    return json({ staff: (await env.DB.prepare('SELECT tc_id,name,dn_person_no,email,active,pin_set_at,(pin_hash IS NOT NULL) AS has_pin,locked_until FROM staff ORDER BY name').all()).results });
  }

  if (path === '/api/staff' && m === 'POST') {
    requireHR();
    const body = await request.json();
    const list = Array.isArray(body.staff) ? body.staff : bad('No staff rows.');
    const stmts = []; const seenEmail = new Set(); const errors = [];
    list.forEach((s, i) => {
      const tc = String(s.tc_id || '').replace(/\s+/g, '').toUpperCase();
      const email = String(s.email || '').trim().toLowerCase();
      if (!/^TC\d+$/.test(tc)) { errors.push(`Row ${i + 2}: staff ID "${s.tc_id}" is not valid.`); return; }
      if (!s.name) { errors.push(`Row ${i + 2}: name is empty.`); return; }
      if (seenEmail.has(tc)) { errors.push(`Row ${i + 2}: staff ID ${tc} appears twice.`); return; }
      seenEmail.add(tc);
      stmts.push(env.DB.prepare(`INSERT INTO staff (tc_id,name,dn_person_no,email,active,updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(tc_id) DO UPDATE SET name=excluded.name, dn_person_no=excluded.dn_person_no, email=excluded.email, active=excluded.active, updated_at=excluded.updated_at`)
        .bind(tc, String(s.name).trim(), s.dn_person_no ? String(s.dn_person_no).trim() : null, email || null, s.active === 0 ? 0 : 1, now()));
    });
    if (errors.length) return json({ error: 'Staff list not saved. Fix these rows first.', details: errors }, 400);
    if (stmts.length) await env.DB.batch(stmts);
    await audit(env, user.email, 'staff_upload', null, { rows: stmts.length });
    return json({ ok: true, saved: stmts.length });
  }

  if ((mm = path.match(/^\/api\/staff\/(TC\d+)\/pin$/)) && m === 'POST') {
    requireHR();
    const s = await env.DB.prepare('SELECT tc_id FROM staff WHERE tc_id=?').bind(mm[1]).first();
    if (!s) throw new HttpError(404, 'Staff not found.');
    const n = crypto.getRandomValues(new Uint32Array(1))[0] % 1000000;
    const pin = String(n).padStart(6, '0');
    const { hash, salt } = await hashPin(pin);
    await env.DB.prepare('UPDATE staff SET pin_hash=?, pin_salt=?, pin_set_at=?, failed_logins=0, locked_until=NULL WHERE tc_id=?').bind(hash, salt, now(), s.tc_id).run();
    await audit(env, user.email, 'pin_reset', s.tc_id);
    return json({ ok: true, tc_id: s.tc_id, pin });
  }

  if (path === '/api/audit' && m === 'GET') {
    requireHR();
    return json({ log: (await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all()).results });
  }

  throw new HttpError(404, 'Not found.');
}

async function getReceipt(env, id) {
  const r = await env.DB.prepare('SELECT * FROM receipts WHERE id=?').bind(id).first();
  if (!r) throw new HttpError(404, 'Receipt not found.');
  return r;
}

async function createReceipt(request, env, user) {
  const form = await request.formData();
  const f = (k) => String(form.get(k) ?? '').trim();

  let tc = user.staff?.tc_id;
  let channel = 'Staff portal';
  if (user.isHR && f('tc_id')) { tc = f('tc_id').toUpperCase(); channel = 'HR on behalf'; }
  if (!tc) throw new HttpError(403, 'Your email is not on the DN staff list. Please contact HR.');
  const staff = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=?').bind(tc).first();
  if (!staff) bad(`Staff ID ${tc} is not on the staff list.`);

  const month = f('claim_month');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) bad('Choose the claim month.');
  const category = f('category');
  if (!CATEGORIES.includes(category)) bad('Choose a claim category.');
  const date = f('expense_date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date))) bad('Enter the date on the receipt.');
  if (date > new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)) bad('Receipt date cannot be in the future.');
  const amt = f('amount').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(amt)) bad('Enter the receipt amount, e.g. 45.60');
  const [ri, rd = ''] = amt.split('.');
  const sen = parseInt(ri, 10) * 100 + parseInt((rd + '00').slice(0, 2), 10);
  if (sen <= 0 || sen > 10_000_000) bad('Receipt amount is not valid.');

  const file = form.get('file');
  if (!file || typeof file === 'string') bad('Attach the receipt photo or PDF.');
  if (file.size > MAX_FILE_BYTES) bad('File is larger than 10 MB. Please take a smaller photo.');
  const type = (file.type || '').toLowerCase();
  if (!ALLOWED_TYPES.includes(type)) bad('Only photo (JPG, PNG, HEIC) or PDF files are accepted.');

  const buf = await file.arrayBuffer();
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');

  // Hard stop: the same file is already on record and not rejected/withdrawn.
  const dup = await env.DB.prepare("SELECT id, tc_id, claim_month, category, submitted_at FROM receipts WHERE file_hash=? AND status IN ('Submitted','Accepted')").bind(hash).first();
  if (dup) bad(`This same file was already submitted on ${dup.submitted_at.slice(0, 10)} (${dup.tc_id}, ${dup.category}, claim month ${dup.claim_month}). It is not accepted again.`);

  const id = crypto.randomUUID();
  const safeName = (file.name || 'receipt').replace(/[^\w.\- ]/g, '_').slice(0, 120);
  const key = `${month}/${tc}/${id}-${safeName}`;
  await env.RECEIPTS.put(key, buf, { httpMetadata: { contentType: type } });
  await env.DB.prepare(`INSERT INTO receipts (id,tc_id,claim_month,category,expense_date,amount_sen,merchant,receipt_no,remark,
      file_key,file_name,file_type,file_size,file_hash,channel,submitted_by,submitted_at,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Submitted')`)
    .bind(id, tc, month, category, date, sen, f('merchant').slice(0, 120) || null, f('receipt_no').slice(0, 60) || null,
      f('remark').slice(0, 300) || null, key, safeName, type, file.size, hash, channel, user.email, now()).run();
  await audit(env, user.email, 'submit', id, { tc, month, category, sen, channel });
  return json({ ok: true, id });
}
