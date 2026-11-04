import { claimRoutes } from './claims.js';
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Staff worker sends HR pages to the HR worker; HR worker opens on the HR page.
    if (env.ROLE === 'staff' && /^\/hr(\.html)?$/.test(url.pathname) && env.HR_URL) return Response.redirect(env.HR_URL, 302);
    if (env.ROLE === 'hr' && url.pathname === '/') return Response.redirect(new URL('/hr.html', url).toString(), 302);
    // Demo pages (fake data in the browser, no server data). Staff worker only.
    if (env.ROLE !== 'hr' && /^\/demo\/?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/', url), request));
    if (env.ROLE !== 'hr' && /^\/demo\/hr(\.html)?$/.test(url.pathname)) return env.ASSETS.fetch(new Request(new URL('/hr', url), request));
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/login' && request.method === 'POST') return await login(request, env);
      if (url.pathname === '/api/logout' && request.method === 'POST') return new Response('{"ok":true}', { headers: {
        'content-type': 'application/json', 'set-cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` } });
      const user = await identify(request, env);
      const cr = await claimRoutes(request, env, url, user, ctx);
      if (cr) return cr;
      // Open submission (staff worker only): TC ID check and receipt upload need no login.
      if (env.ROLE !== 'hr' && !user?.isHR) {
        if (url.pathname === '/api/lookup' && request.method === 'POST') return await openLookup(request, env);
        if (url.pathname === '/api/receipts' && request.method === 'POST') return await createReceipt(request, env, null);
        if (url.pathname === '/api/me' && request.method === 'GET' && !user) return json({ open: true, categories: CATEGORIES });
      }
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
  if (env.ROLE !== 'staff' && token && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) email = await verifyAccessJwt(token, env).catch(() => null);
  if (!email && env.DEV_MODE === '1') email = request.headers.get('x-dev-user') || env.DEV_USER_EMAIL || null; // local testing only
  if (email) {
    email = email.trim().toLowerCase();
    if (hrList.includes(email)) return { email, isHR: true, staff: null };
  }
  if (env.ROLE === 'hr') return null; // HR worker: Access login only
  // staff session
  const tc = await readSession(cookie(request, SESSION_COOKIE), env);
  if (tc) {
    const staff = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=? AND active=1').bind(tc).first();
    if (staff) return { email: `${staff.tc_id} (staff login)`, isHR: false, staff };
  }
  return null;
}

// Session signing key. Uses the SESSION_SECRET setting if present; otherwise the worker
// creates a random key once and keeps it in the database (table app_settings).
let secretCache = null;
async function sessionSecret(env) {
  if (env.SESSION_SECRET && env.SESSION_SECRET.length >= 32) return env.SESSION_SECRET;
  if (secretCache) return secretCache;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS app_settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)').run();
  const fresh = b64url(crypto.getRandomValues(new Uint8Array(48)));
  await env.DB.prepare("INSERT OR IGNORE INTO app_settings (k, v) VALUES ('session_secret', ?)").bind(fresh).run();
  const row = await env.DB.prepare("SELECT v FROM app_settings WHERE k='session_secret'").first();
  secretCache = row.v;
  return secretCache;
}
async function hmac(env, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(await sessionSecret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
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
      const rows = (await q.all()).results;
      await ensureFilesTable(env);
      const counts = (await env.DB.prepare('SELECT receipt_id, COUNT(*) AS n FROM receipt_files GROUP BY receipt_id').all()).results;
      const cm = new Map(counts.map(c => [c.receipt_id, c.n]));
      rows.forEach(r => { r.photos = cm.get(r.id) || 1; });
      return json({ receipts: rows });
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

  if ((mm = path.match(/^\/api\/file\/([\w-]+)(?:\/(\d+))?$/)) && m === 'GET') {
    const r = await getReceipt(env, mm[1]);
    if (!user.isHR && (!user.staff || r.tc_id !== user.staff.tc_id)) throw new HttpError(403, 'Not allowed.');
    if (mm[2] && mm[2] !== '1') {
      await ensureFilesTable(env);
      const fr = await env.DB.prepare('SELECT * FROM receipt_files WHERE receipt_id=? AND n=?').bind(r.id, +mm[2]).first();
      if (!fr) throw new HttpError(404, 'File not found.');
      r.file_key = fr.file_key; r.file_type = fr.file_type; r.file_name = fr.file_name;
    }
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

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  let tc, channel, actor;
  if (!user) {                                   // open staff form
    tc = normTc(f('tc_id')); channel = 'Staff portal'; actor = `${tc || '?'} (staff form)`;
    if (!tc) bad('Enter your staff ID, e.g. TC4736.');
    await rateLimit(env, ip);
  } else if (user.isHR) {
    tc = normTc(f('tc_id')) || user.staff?.tc_id; channel = 'HR on behalf'; actor = user.email;
  } else {
    tc = user.staff?.tc_id; channel = 'Staff portal'; actor = user.email;
  }
  if (!tc) bad('Enter the staff ID.');
  const staff = await env.DB.prepare('SELECT * FROM staff WHERE tc_id=? AND active=1').bind(tc).first();
  if (!staff) bad(`Staff ID ${tc} is not on the DN staff list. Please check the ID or contact HR.`);

  const month = f('claim_month');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) bad('Choose the claim month.');
  const category = f('category');
  if (!CATEGORIES.includes(category)) bad('Choose a claim category.');
  const date = f('expense_date'); // optional
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date)))) bad('Receipt date is not valid.');
  if (date && date > new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10)) bad('Receipt date cannot be in the future.');
  const amt = f('amount').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(amt)) bad('Enter the total amount, e.g. 60.00');
  const [ri, rd = ''] = amt.split('.');
  const sen = parseInt(ri, 10) * 100 + parseInt((rd + '00').slice(0, 2), 10);
  if (sen <= 0 || sen > 10_000_000) bad('Receipt amount is not valid.');

  const list = form.getAll('file').filter(x => x && typeof x !== 'string' && x.size > 0);
  if (!list.length) bad('Attach at least one receipt photo or PDF.');
  if (list.length > 10) bad('Up to 10 photos per claim. Please send the rest as another claim.');
  const items = [];
  for (const file of list) {
    if (file.size > MAX_FILE_BYTES) bad(`"${file.name}" is larger than 10 MB. Please take a smaller photo.`);
    const type = (file.type || '').toLowerCase();
    if (!ALLOWED_TYPES.includes(type)) bad(`"${file.name}": only photo (JPG, PNG, HEIC) or PDF files are accepted.`);
    const buf = await file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join('');
    if (items.some(i => i.hash === hash)) bad(`The same photo is attached twice ("${file.name}").`);
    items.push({ file, type, buf, hash, name: (file.name || 'receipt').replace(/[^\w.\- ]/g, '_').slice(0, 120) });
  }
  await ensureFilesTable(env);
  // Hard stop: a photo already on record (claim not rejected/withdrawn).
  for (const it of items) {
    const dup = await env.DB.prepare(`SELECT r.id, r.tc_id, r.claim_month, r.category, r.submitted_at FROM receipts r
        WHERE r.status IN ('Submitted','Accepted') AND (r.file_hash=? OR r.id IN (SELECT receipt_id FROM receipt_files WHERE file_hash=?)) LIMIT 1`)
      .bind(it.hash, it.hash).first();
    if (dup) bad(user?.isHR
      ? `"${it.name}" was already submitted on ${dup.submitted_at.slice(0, 10)} (${dup.tc_id}, ${dup.category}, claim month ${dup.claim_month}). It is not accepted again.`
      : `"${it.name}" was already submitted on ${dup.submitted_at.slice(0, 10)}. It is not accepted again. If you think this is wrong, contact HR.`);
  }

  const id = crypto.randomUUID();
  const stmts = [];
  for (let n = 0; n < items.length; n++) {
    const it = items[n];
    it.key = `${month}/${tc}/${id}-${n + 1}-${it.name}`;
    await env.RECEIPTS.put(it.key, it.buf, { httpMetadata: { contentType: it.type } });
    stmts.push(env.DB.prepare('INSERT INTO receipt_files (receipt_id, n, file_key, file_name, file_type, file_size, file_hash) VALUES (?,?,?,?,?,?,?)')
      .bind(id, n + 1, it.key, it.name, it.type, it.file.size, it.hash));
  }
  const first = items[0];
  stmts.unshift(env.DB.prepare(`INSERT INTO receipts (id,tc_id,claim_month,category,expense_date,amount_sen,merchant,receipt_no,remark,
      file_key,file_name,file_type,file_size,file_hash,channel,submitted_by,submitted_at,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Submitted')`)
    .bind(id, tc, month, category, date || '', sen, f('merchant').slice(0, 120) || null, f('receipt_no').slice(0, 60) || null,
      f('remark').slice(0, 300) || null, first.key, items.length > 1 ? `${first.name} (+${items.length - 1} more)` : first.name,
      first.type, items.reduce((a, i) => a + i.file.size, 0), first.hash, channel, actor, now()));
  await env.DB.batch(stmts);
  await audit(env, actor, 'submit', id, { tc, month, category, sen, channel, photos: items.length, ip });
  return json({ ok: true, id, ref: refOf(id), name: staff.name });
}

const normTc = (v) => { const t = String(v || '').replace(/\s+/g, '').toUpperCase(); return /^TC\d{3,6}$/.test(t) ? t : ''; };
const refOf = (id) => 'DNR-' + id.replace(/-/g, '').slice(0, 8).toUpperCase();

// At most 30 uploads per hour from one network address (open form only)
async function rateLimit(env, ip) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='submit' AND at>? AND detail LIKE ?")
    .bind(since, `%"ip":"${ip.replace(/[%_"]/g, '')}"%`).first();
  if ((r?.n || 0) >= 30) throw new HttpError(429, 'Too many uploads from this network in the last hour. Please try again later.');
}

async function openLookup(request, env) {
  const body = await request.json().catch(() => ({}));
  const tc = normTc(body.tc_id);
  if (!tc) return json({ error: 'Enter your staff ID, e.g. TC4736.' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const since = new Date(Date.now() - 3600_000).toISOString();
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='lookup' AND at>? AND detail LIKE ?")
    .bind(since, `%"ip":"${ip.replace(/[%_"]/g, '')}"%`).first();
  if ((r?.n || 0) >= 60) return json({ error: 'Too many tries. Please wait and try again.' }, 429);
  await audit(env, tc, 'lookup', tc, { ip });
  const s = await env.DB.prepare('SELECT tc_id, name FROM staff WHERE tc_id=? AND active=1').bind(tc).first();
  if (!s) return json({ error: `Staff ID ${tc} is not on the DN staff list. Please check the ID or contact HR.` }, 404);
  return json({ tc_id: s.tc_id, name: s.name });
}

let filesTableReady = false;
async function ensureFilesTable(env) {
  if (filesTableReady) return;
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS receipt_files (receipt_id TEXT NOT NULL, n INTEGER NOT NULL, file_key TEXT NOT NULL,
    file_name TEXT NOT NULL, file_type TEXT NOT NULL, file_size INTEGER NOT NULL, file_hash TEXT NOT NULL, PRIMARY KEY (receipt_id, n))`).run();
  await env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_receipt_files_hash ON receipt_files(file_hash)').run();
  filesTableReady = true;
}
