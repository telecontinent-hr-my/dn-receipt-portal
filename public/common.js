// Shared helpers for the DN Receipt Portal pages
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rm = (sen) => (sen < 0 ? '-' : '') + (Math.abs(sen) / 100).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = ym.split('-'); return `${MONTHS[+m - 1]} ${y}`; };
const fmtDate = (d) => { if (!d) return ''; const [y, m, dd] = d.slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };

async function api(path, opts = {}) {
  const r = await fetch(path, { credentials: 'same-origin', ...opts });
  let data = {};
  try { data = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) {
    const e = new Error(data.error || `Request failed (${r.status})`);
    e.details = data.details; e.status = r.status; throw e;
  }
  return data;
}

function showMsg(el, type, text, details) {
  el.className = `msg ${type}`;
  el.innerHTML = esc(text) + (details && details.length ? '<ul>' + details.map(d => `<li>${esc(d)}</li>`).join('') + '</ul>' : '');
  el.classList.remove('hidden');
}

// Last 12 months, newest first, as YYYY-MM (Malaysia time)
function recentMonths(n = 12) {
  const d = new Date(Date.now() + 8 * 3600_000);
  const out = [];
  for (let i = 0; i < n; i++) {
    const y = d.getUTCFullYear(), m = d.getUTCMonth() - i;
    const dt = new Date(Date.UTC(y, m, 1));
    out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}
const todayMY = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

function openFile(id, title, count = 1) {
  let dlg = $('#fileDlg');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'fileDlg';
    dlg.innerHTML = '<div class="head"><strong class="t"></strong><span class="pn row"></span><a class="btn small ghost right" target="_blank" rel="noopener">Open in new tab</a><button class="small ghost cl" type="button">Close</button></div><div class="body"></div>';
    document.body.appendChild(dlg);
    dlg.querySelector('.cl').onclick = () => dlg.close();
    dlg.addEventListener('close', () => { dlg.querySelector('.body').innerHTML = ''; });
  }
  const show = (n) => {
    const src = window.DEMO ? window.demoFileUrl(id, n) : `/api/file/${encodeURIComponent(id)}/${n}`;
    dlg.querySelector('a').href = src;
    dlg.querySelector('.body').innerHTML = `<iframe src="${src}" title="Receipt"></iframe>`;
    dlg.querySelectorAll('.pn button').forEach(b => b.classList.toggle('ghost', +b.dataset.n !== n));
  };
  dlg.querySelector('.t').textContent = title || 'Receipt';
  dlg.querySelector('.pn').innerHTML = count > 1 ? Array.from({ length: count }, (_, i) => `<button class="small" type="button" data-n="${i + 1}">${i + 1}</button>`).join('') : '';
  dlg.querySelectorAll('.pn button').forEach(b => b.onclick = () => show(+b.dataset.n));
  show(1);
  dlg.showModal();
}

// Shrink large phone photos before upload (keeps PDFs and HEIC as they are)
async function shrinkImage(file) {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1.5 * 1024 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(res => c.toBlob(res, 'image/jpeg', 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch { return file; }
}

// ---------- receipt upload (shared by staff and HR pages) ----------
const MAX_AI_PAGES = 8;
async function imageToJpegB64(source, maxSide = 1400) {
  const w0 = source.width, h0 = source.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas'); c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(source, 0, 0, c.width, c.height);
  return { b64: c.toDataURL('image/jpeg', 0.85).split(',')[1], canvas: c };
}
let pdfjsReady = null;
function loadPdfJs() {
  if (!pdfjsReady) pdfjsReady = new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = '/vendor/pdf.min.js';
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js'; res(window.pdfjsLib); };
    s.onerror = rej; document.head.appendChild(s);
  });
  return pdfjsReady;
}
// Returns { upload: File, aiPages: [base64 jpeg], pdfText: string }
async function preparePhoto(file) {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) {
    const lib = await loadPdfJs();
    const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
    let text = ''; const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      // group words into lines in screen position (handles landscape / rotated pages)
      const vpT = page.getViewport({ scale: 1 }).transform, rows = new Map();
      for (const it of tc.items) {
        if (!it.str.trim()) continue;
        const t = lib.Util.transform(vpT, it.transform), y = Math.round(t[5]);
        const k = [...rows.keys()].find(v => Math.abs(v - y) <= 3) ?? y; if (!rows.has(k)) rows.set(k, []); rows.get(k).push({ x: t[4], s: it.str });
      }
      text += [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([, its]) => its.sort((a, b) => a.x - b.x).map(i => i.s).join('   ')).join('\n') + '\n';
      if (n <= MAX_AI_PAGES) {
        const vp0 = page.getViewport({ scale: 1 }); const vp = page.getViewport({ scale: Math.min(2.5, 1400 / Math.max(vp0.width, vp0.height)) });
        const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
        const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        await page.render({ canvasContext: g, viewport: vp }).promise;
        pages.push(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
      }
    }
    return { upload: new File([file], file.name, { type: 'application/pdf' }), aiPages: pages, pdfText: text.slice(0, 200000) };
  }
  try {
    const bmp = await createImageBitmap(file);
    const { b64, canvas } = await imageToJpegB64(bmp, 1400);
    const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
    const upload = blob && blob.size < file.size ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    return { upload, aiPages: [b64], pdfText: '' };
  } catch {
    return { upload: file, aiPages: [], pdfText: '' }; // e.g. HEIC on some browsers: HR will check it
  }
}
async function uploadReceipt(claimId, tcId, file) {
  const p = await preparePhoto(file);
  const fd = new FormData();
  fd.set('tc_id', tcId || ''); fd.set('file', p.upload); fd.set('pdf_text', p.pdfText);
  p.aiPages.forEach(b => fd.append('ai_b64', b));
  return api(`/api/claims/${claimId}/photo`, { method: 'POST', body: fd });
}
function openUrls(urls, title) {
  let dlg = $('#fileDlg2');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'fileDlg2';
    dlg.innerHTML = '<div class="head"><strong class="t"></strong><span class="pn row"></span><a class="btn small ghost right" target="_blank" rel="noopener">Open in new tab</a><button class="small ghost cl" type="button">Close</button></div><div class="body"></div>';
    document.body.appendChild(dlg); dlg.querySelector('.cl').onclick = () => dlg.close();
    dlg.addEventListener('close', () => { dlg.querySelector('.body').innerHTML = ''; });
  }
  const show = (i) => { dlg.querySelector('a').href = urls[i]; dlg.querySelector('.body').innerHTML = `<iframe src="${urls[i]}" title="Receipt"></iframe>`;
    dlg.querySelectorAll('.pn button').forEach(b => b.classList.toggle('ghost', +b.dataset.i !== i)); };
  dlg.querySelector('.t').textContent = title || 'Receipt';
  dlg.querySelector('.pn').innerHTML = urls.length > 1 ? urls.map((_, i) => `<button class="small" type="button" data-i="${i}">${i + 1}</button>`).join('') : '';
  dlg.querySelectorAll('.pn button').forEach(b => b.onclick = () => show(+b.dataset.i));
  show(0); dlg.showModal();
}
const STATUS_CHIP = { 'Cleared': 'ok', 'Cleared by HR': 'ok', 'Short': 'warn', 'HR check': 'err', 'Rejected by HR': 'err', 'Not submitted': 'Withdrawn' };
