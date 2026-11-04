// DN Receipt Portal - workbook reading and receipt matching (runs in the browser; also testable in Node)
(function (root) {
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

  // DN workbook column heading -> portal category
  function headingToCategory(h) {
    const k = String(h ?? '').toLowerCase().replace(/[\s.]+/g, '');
    const map = {
      'medical': 'Medical', 'optical/dental': 'Optical/Dental', 'carrtax': 'Car Road Tax', 'carroadtax': 'Car Road Tax',
      'carins': 'Car Insurance', 'carinsurance': 'Car Insurance', 'carmaint': 'Car Maintenance', 'carmaintenance': 'Car Maintenance',
      'parking': 'Parking', 'mealallownce': 'Meal Allowance', 'mealallowance': 'Meal Allowance', 'mileage': 'Mileage',
      'toll': 'Toll', 'accomodation': 'Accommodation', 'accommodation': 'Accommodation', 'transportation': 'Transportation',
      'streamyx': 'Streamyx / Internet', 'handphone': 'Handphone', 'entertainment': 'Entertainment', 'gift': 'Gift',
      'miscexpenses': 'Misc Expenses', 'swabtest': 'Swab Test', 'staffrelation': 'Staff Relation',
      'coassets': null, 'advance': null
    };
    return k in map ? map[k] : undefined; // null = known but not a receipt claim; undefined = unknown
  }

  // Same-purpose groups. DN often books one item under a neighbouring column (e.g. parking inside Toll).
  const GROUPS = {
    'Medical': 'Medical', 'Optical/Dental': 'Medical',
    'Car Road Tax': 'Car', 'Car Insurance': 'Car', 'Car Maintenance': 'Car',
    'Parking (Office)': 'Travel', 'Mileage': 'Travel', 'Parking': 'Travel', 'Toll': 'Travel',
    'Accommodation': 'Travel', 'Transportation': 'Travel', 'Meal Allowance': 'Travel',
    'Streamyx / Internet': 'Phone & Internet', 'Handphone': 'Phone & Internet'
  };
  const groupOf = (c) => GROUPS[c] || c;

  function sheetMonth(name) {
    const m = String(name).toLowerCase().match(/(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-_]*'?(\d{2}|\d{4})\b/);
    if (!m) return null;
    const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    return `${y}-${String(MON[m[1]]).padStart(2, '0')}`;
  }

  const toSen = (v) => {
    if (typeof v === 'number' && isFinite(v)) return Math.round(v * 100);
    const s = String(v ?? '').replace(/[,\s]/g, '').replace(/^RM/i, '');
    return /^-?\d+(\.\d+)?$/.test(s) ? Math.round(parseFloat(s) * 100) : null;
  };

  // Read one month sheet (array of rows from SheetJS, header:1). Returns lines + problems.
  function readSheet(rows, sheetName) {
    const problems = [];
    const hi = rows.findIndex(r => r && String(r[0] ?? '').trim().toLowerCase() === 'name' && String(r[1] ?? '').trim().toLowerCase() === 'no');
    if (hi < 0) return { ok: false, problems: [`Sheet "${sheetName}": cannot find the heading row (Name / No / Cost Center).`] };
    const head = rows[hi], gl = rows[hi - 1] || [];
    const cols = [];
    let parkingSeen = 0;
    for (let j = 3; j < head.length; j++) {
      const h = String(head[j] ?? '').trim();
      if (!h) continue;
      if (/^total$/i.test(h)) break;
      let cat = headingToCategory(h);
      if (cat === 'Parking') {
        const g = String(gl[j] ?? '');
        const office = g ? g.startsWith('6269') : parkingSeen === 0;
        cat = office ? 'Parking (Office)' : 'Parking';
        parkingSeen++;
      }
      if (cat === undefined) problems.push(`Sheet "${sheetName}": column ${colName(j)} "${h}" is not a known claim column. It is not checked.`);
      cols.push({ j, heading: h, cat, col: colName(j) });
    }
    const lines = [];
    for (let i = hi + 1; i < rows.length; i++) {
      const r = rows[i] || [];
      const name = String(r[0] ?? '').trim();
      const no = r[1];
      if (!name || name === '0' || /^staff$/i.test(name)) continue;
      if (!(typeof no === 'number' || /^\d{5,}$/.test(String(no ?? '').trim()))) continue;
      for (const c of cols) {
        const v = r[c.j];
        if (v === null || v === undefined || v === '') continue;
        if (typeof v === 'string' && /^#(REF!|VALUE!|N\/A|DIV\/0!|NAME\?)/.test(v)) {
          problems.push(`Sheet "${sheetName}" row ${i + 1} ${c.col}: Excel error ${v} for ${name}.`); continue;
        }
        const sen = toSen(v);
        if (sen === null) { problems.push(`Sheet "${sheetName}" row ${i + 1} ${c.col}: "${v}" is not an amount.`); continue; }
        if (sen === 0 || !c.cat) continue;
        lines.push({ name, personNo: String(no).trim(), costCenter: String(r[2] ?? '').trim(), category: c.cat, heading: c.heading, col: c.col, row: i + 1, sen, sheet: sheetName });
      }
    }
    return { ok: true, lines, problems };
  }

  function colName(j) { let s = ''; j++; while (j) { const m = (j - 1) % 26; s = String.fromCharCode(65 + m) + s; j = Math.floor((j - 1) / 26); } return s; }

  const tok = (n) => new Set(String(n).toUpperCase().replace(/\(.*?\)/g, ' ')
    .replace(/\b(BIN|BINTI|BT|BN|A\/L|A\/P|AL|AP|ANAK|AK)\b/g, ' ').split(/[^A-Z]+/).filter(x => x.length > 1));
  function nameScore(a, b) { const A = tok(a), B = tok(b); let i = 0; A.forEach(x => B.has(x) && i++); return i / Math.max(1, new Set([...A, ...B]).size); }

  // Main matching. dnLines: from readSheet for the chosen month. receipts: from API. staff: from API.
  // otherMonths: [{month, lines}] from the other sheets, used to explain receipts with no approval this month.
  function match({ month, dnLines, receipts, staff, otherMonths = [], oldMonths = 6 }) {
    const byNo = new Map(staff.filter(s => s.dn_person_no).map(s => [String(s.dn_person_no).trim(), s]));
    const byTc = new Map(staff.map(s => [s.tc_id, s]));
    const identity = new Map(); // personNo -> {staff, how}
    for (const l of dnLines) {
      if (identity.has(l.personNo)) continue;
      let s = byNo.get(l.personNo), how = 'DN person no.';
      if (!s) {
        let best = null, sc = 0;
        for (const x of staff) { const v = nameScore(l.name, x.name); if (v > sc) { sc = v; best = x; } }
        if (best && sc >= 0.75 && !best.dn_person_no) { s = best; how = 'Name only - add DN person no. to staff list'; }
      }
      identity.set(l.personNo, { staff: s || null, how: s ? how : null });
    }

    const active = receipts.filter(r => r.status === 'Submitted' || r.status === 'Accepted');
    const monthRcpts = active.filter(r => r.claim_month === month);
    const [y, mo] = month.split('-').map(Number);
    const monthEnd = new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
    const oldLimit = new Date(Date.UTC(y, mo - 1 - oldMonths, 1)).toISOString().slice(0, 10);

    // receipt-level flags
    const flags = new Map();
    const addFlag = (r, f) => { if (!flags.has(r.id)) flags.set(r.id, []); flags.get(r.id).push(f); };
    for (const r of monthRcpts) {
      if (r.expense_date > monthEnd) addFlag(r, `Receipt date ${r.expense_date} is after the claim month.`);
      if (r.expense_date < oldLimit) addFlag(r, `Receipt date ${r.expense_date} is more than ${oldMonths} months before the claim month.`);
      const twins = active.filter(o => o.id !== r.id && o.tc_id === r.tc_id && o.amount_sen === r.amount_sen && o.expense_date === r.expense_date);
      if (twins.length) addFlag(r, `Possible duplicate: same date and amount also in ${twins.map(t => `${t.category} (${t.claim_month})`).join(', ')}.`);
      if (r.receipt_no) {
        const same = active.filter(o => o.id !== r.id && o.receipt_no && o.receipt_no.trim().toLowerCase() === r.receipt_no.trim().toLowerCase());
        if (same.length) addFlag(r, `Same receipt no. "${r.receipt_no}" also used by ${same.map(t => `${t.tc_id} ${t.category} (${t.claim_month})`).join(', ')}.`);
      }
    }

    // build lines keyed by tc|category
    const key = (tc, c) => `${tc}|${c}`;
    const L = new Map();
    const get = (tc, cat, base) => { const k = key(tc, cat); if (!L.has(k)) L.set(k, { tc, category: cat, group: groupOf(cat), dn: 0, rc: 0, receipts: [], dnRefs: [], ...base }); return L.get(k); };
    const unknownStaff = [];
    for (const l of dnLines) {
      const id = identity.get(l.personNo);
      const tc = id.staff ? id.staff.tc_id : `DN#${l.personNo}`;
      const line = get(tc, l.category, { name: id.staff ? id.staff.name : l.name, personNo: l.personNo, how: id.how });
      line.dn += l.sen; line.dnRefs.push(`${l.sheet}!${l.col}${l.row}`);
      if (!id.staff && !unknownStaff.includes(l.personNo)) unknownStaff.push(l.personNo);
    }
    for (const r of monthRcpts) {
      const s = byTc.get(r.tc_id);
      const line = get(r.tc_id, r.category, { name: s ? s.name : r.tc_id, personNo: s?.dn_person_no || '', how: null });
      line.rc += r.amount_sen; line.receipts.push(r);
    }

    // line status
    const lines = [...L.values()];
    for (const x of lines) {
      x.issues = []; x.pending = x.receipts.filter(r => r.status === 'Submitted').length;
      x.receipts.forEach(r => (flags.get(r.id) || []).forEach(f => x.issues.push(f)));
      if (x.tc.startsWith('DN#')) { x.status = 'Staff not on list'; x.issues.unshift('This DN staff is not on the portal staff list, so no receipts can be linked. Add the staff with DN person no.'); }
      else if (x.dn > 0 && x.rc === 0) x.status = 'No receipt';
      else if (x.dn > 0 && x.rc < x.dn) x.status = 'Receipts short';
      else if (x.dn > 0) x.status = 'Supported';
      else {
        x.status = 'No DN approval';
        const found = [];
        for (const om of otherMonths) for (const l of om.lines) {
          const id = identity.get(l.personNo) || {};
          const tcx = id.staff ? id.staff.tc_id : (byNo.get(l.personNo)?.tc_id);
          if (tcx === x.tc && l.category === x.category) found.push({ month: om.month, sen: l.sen, exact: l.sen === x.rc });
        }
        const exact = found.filter(f => f.exact);
        const show = (exact.length ? exact : found.sort((a, b) => b.month.localeCompare(a.month)).slice(0, 3))
          .map(f => `${f.month} RM ${(f.sen / 100).toFixed(2)}`).join('; ');
        x.issues.unshift(exact.length
          ? `Not approved by DN in ${month}. Same amount approved under ${x.category} in ${show}. Check it was not already paid.`
          : found.length ? `Not approved by DN in ${month}. Other ${x.category} approvals (latest): ${show}.`
          : `Not approved by DN in ${month} and not found in the other month sheets.`);
      }
      x.supported = Math.min(x.dn, x.rc);
      if (x.status === 'Supported' && x.rc > x.dn) x.note = `Receipts are RM ${((x.rc - x.dn) / 100).toFixed(2)} above DN approval. Pay up to the DN approved amount only.`;
      if (x.how && x.how.startsWith('Name')) x.issues.push('Staff matched by name only. Please confirm and add the DN person no. to the staff list.');
    }

    // group-level check: DN often books an item under a neighbouring column
    const byGroup = new Map();
    for (const x of lines) { if (x.tc.startsWith('DN#')) continue; const k = `${x.tc}|${x.group}`; if (!byGroup.has(k)) byGroup.set(k, []); byGroup.get(k).push(x); }
    for (const grp of byGroup.values()) {
      if (grp.length < 2 || !grp.some(x => x.status !== 'Supported')) continue;
      const dn = grp.reduce((a, x) => a + x.dn, 0), rc = grp.reduce((a, x) => a + x.rc, 0);
      if (dn > 0 && rc >= dn) {
        for (const x of grp) if (x.status !== 'Supported') {
          x.status = 'Supported in group';
          x.issues = x.issues.filter(t => !t.startsWith('Not approved by DN') && !t.startsWith('This DN staff'));
          x.issues.unshift(`Category differs from DN, but ${x.group} total is supported (DN RM ${(dn / 100).toFixed(2)}, receipts RM ${(rc / 100).toFixed(2)}).`);
        }
        let left = dn; for (const x of grp) { x.supported = 0; }
        // spread supported amount over the DN lines of the group
        for (const x of grp) { const s = Math.min(x.dn, left); x.supported = s; left -= s; }
      }
    }

    for (const x of lines) x.issues = [...new Set(x.issues)];
    const BLOCK = ['No receipt', 'Receipts short', 'No DN approval', 'Staff not on list'];
    for (const x of lines) {
      x.exception = BLOCK.includes(x.status) || x.issues.length > 0;
      x.severity = BLOCK.includes(x.status) ? 'Action' : (x.issues.length ? 'Check' : 'OK');
    }
    lines.sort((a, b) => (a.name || '').localeCompare(b.name || '') || a.category.localeCompare(b.category));

    const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
    const summary = {
      dnStaff: new Set(dnLines.map(l => l.personNo)).size,
      dnLines: lines.filter(x => x.dn > 0).length,
      dnTotal: sum(lines, x => x.dn),
      receiptCount: monthRcpts.length,
      receiptTotal: sum(lines, x => x.rc),
      supportedTotal: sum(lines, x => x.supported),
      pending: monthRcpts.filter(r => r.status === 'Submitted').length,
      actions: lines.filter(x => x.severity === 'Action').length,
      checks: lines.filter(x => x.severity === 'Check').length,
      ok: lines.filter(x => x.severity === 'OK').length,
      unknownStaff: unknownStaff.length
    };
    return { lines, summary };
  }

  const api = { readSheet, match, sheetMonth, headingToCategory, groupOf, nameScore, toSen };
  if (typeof module !== 'undefined') module.exports = api; else root.DNMatch = api;
})(this);
