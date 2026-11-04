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

function openFile(id, title) {
  let dlg = $('#fileDlg');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'fileDlg';
    dlg.innerHTML = '<div class="head"><strong class="t"></strong><a class="btn small ghost right" target="_blank" rel="noopener">Open in new tab</a><button class="small ghost" type="button">Close</button></div><div class="body"></div>';
    document.body.appendChild(dlg);
    dlg.querySelector('button').onclick = () => dlg.close();
    dlg.addEventListener('close', () => { dlg.querySelector('.body').innerHTML = ''; });
  }
  dlg.querySelector('.t').textContent = title || 'Receipt';
  const src = window.DEMO ? window.demoFileUrl(id) : `/api/file/${encodeURIComponent(id)}`;
  dlg.querySelector('a').href = src;
  dlg.querySelector('.body').innerHTML = `<iframe src="${src}" title="Receipt"></iframe>`;
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
