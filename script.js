'use strict';

/* ---------- date helpers (all dates handled as UTC midnight to avoid DST issues) ---------- */

const MS_PER_DAY = 86400000;

function parseISODate(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  // reject rolled-over invalid dates like 2023-02-30
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return dt;
}

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function epochDay(date) {
  return Math.floor(date.getTime() / MS_PER_DAY);
}

function dateFromEpochDay(ed) {
  return new Date(ed * MS_PER_DAY);
}

function addYears(date, n) {
  return new Date(Date.UTC(date.getUTCFullYear() + n, date.getUTCMonth(), date.getUTCDate()));
}

function todayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
}

function formatDateLong(date) {
  return date.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/* ---------- presence simulation ---------- */

/**
 * Builds a lookup that answers "how many days in NZ within [startEpoch, endEpoch)"
 * in O(1) per query, via a prefix-sum array.
 *
 * Rules encoded here:
 *  - any day before residencyEpoch is NOT in NZ (can't count residence before it existed)
 *  - the day you leave and the day you arrive back both count as IN NZ
 *  - any day strictly between a travel's from/to counts as NOT in NZ
 *  - every other day counts as IN NZ
 */
function buildPresenceIndex(residencyEpoch, travels, rangeStartEpoch, rangeEndEpoch) {
  const base = rangeStartEpoch;
  const len = Math.max(0, rangeEndEpoch - rangeStartEpoch);
  const status = new Uint8Array(len); // 1 = in NZ, 0 = not

  for (let i = 0; i < len; i++) {
    status[i] = (base + i) >= residencyEpoch ? 1 : 0;
  }

  for (const t of travels) {
    let from = t.fromEpoch, to = t.toEpoch;
    // interior days only: (from, to) exclusive
    let s = Math.max(from + 1, base);
    let e = Math.min(to, rangeEndEpoch);
    for (let d = s; d < e; d++) {
      status[d - base] = 0;
    }
  }

  const prefix = new Int32Array(len + 1);
  for (let i = 0; i < len; i++) prefix[i + 1] = prefix[i] + status[i];

  return {
    base,
    end: rangeEndEpoch,
    daysInNZ(startEpoch, endEpoch) {
      const s = Math.min(Math.max(startEpoch, base), rangeEndEpoch);
      const e = Math.min(Math.max(endEpoch, base), rangeEndEpoch);
      if (e <= s) return 0;
      return prefix[e - base] - prefix[s - base];
    }
  };
}

/* ---------- year-chunk breakdown for a window ending at `endDate` (exclusive) ---------- */

function buildYearChunks(endDate, windowYears) {
  const chunks = [];
  for (let i = 0; i < windowYears; i++) {
    const start = addYears(endDate, -(windowYears - i));
    const end = addYears(endDate, -(windowYears - i - 1));
    chunks.push({ index: i + 1, start, end, startEpoch: epochDay(start), endEpoch: epochDay(end) });
  }
  return chunks;
}

function computeWindowReport(residencyEpoch, travels, endDate, req, presenceIndex) {
  const windowYears = req.windowYears;
  const startDate = addYears(endDate, -windowYears);
  const startEpoch = epochDay(startDate);
  const endEpoch = epochDay(endDate);

  const chunks = buildYearChunks(endDate, windowYears);

  const totalDaysWindow = endEpoch - startEpoch;
  const totalInNZ = presenceIndex.daysInNZ(startEpoch, endEpoch);
  const totalOut = totalDaysWindow - totalInNZ;
  const windowCapOut = totalDaysWindow - req.totalDaysRequired;
  const windowRemainingOut = windowCapOut - totalOut;

  const years = chunks.map(c => {
    const daysInChunk = c.endEpoch - c.startEpoch;
    const daysInNZ = presenceIndex.daysInNZ(c.startEpoch, c.endEpoch);
    const daysOut = daysInChunk - daysInNZ;
    const yearCapOut = daysInChunk - req.yearlyDaysRequired;
    const yearRemainingOut = yearCapOut - daysOut;
    const allowedFutureOut = Math.min(yearRemainingOut, windowRemainingOut);
    return {
      ...c,
      daysInChunk,
      daysInNZ,
      daysOut,
      yearCapOut,
      yearRemainingOut,
      allowedFutureOut,
      meetsYearRequirement: daysInNZ >= req.yearlyDaysRequired
    };
  });

  return {
    startDate, endDate, startEpoch, endEpoch,
    totalDaysWindow, totalInNZ, totalOut,
    windowCapOut, windowRemainingOut,
    meetsTotalRequirement: totalInNZ >= req.totalDaysRequired,
    years
  };
}

function windowSatisfiesRequirement(residencyEpoch, presenceIndex, endDate, req) {
  const report = computeWindowReport(residencyEpoch, null, endDate, req, presenceIndex);
  if (!report.meetsTotalRequirement) return false;
  return report.years.every(y => y.meetsYearRequirement);
}

/**
 * Scans forward day-by-day from residencyDate looking for the earliest application
 * date whose trailing 5-year window satisfies both the total and per-year requirements.
 * Returns null if nothing within the search cap qualifies (e.g. not enough data yet).
 */
function findEarliestEligibleDate(residencyEpoch, presenceIndex, req, searchStartEpoch, searchEndEpoch) {
  for (let d = searchStartEpoch; d < searchEndEpoch; d++) {
    const candidate = dateFromEpochDay(d);
    if (windowSatisfiesRequirement(residencyEpoch, presenceIndex, candidate, req)) {
      return candidate;
    }
  }
  return null;
}

/* ---------- app state & wiring ---------- */

const state = {
  residencyDate: null,
  citizenshipDate: null,
  travels: [], // { id, from: Date, to: Date, note }
  requirements: { windowYears: 5, totalDaysRequired: 1350, yearlyDaysRequired: 240 }
};

let travelIdCounter = 0;

function addTravelRow(from = '', to = '', note = '') {
  state.travels.push({ id: ++travelIdCounter, from, to, note });
  renderTravelRows();
  recalculate();
}

function removeTravelRow(id) {
  state.travels = state.travels.filter(t => t.id !== id);
  renderTravelRows();
  recalculate();
}

function renderTravelRows() {
  const container = document.getElementById('travel-rows');
  container.innerHTML = '';
  if (state.travels.length === 0) {
    addTravelRow();
    return;
  }
  for (const t of state.travels) {
    const row = document.createElement('div');
    row.className = 'travel-row';
    row.innerHTML = `
      <span class="field-label field-label-from">Left NZ</span>
      <input type="date" class="travel-from" value="${t.from || ''}" aria-label="Left NZ on">
      <span class="travel-arrow">&rarr;</span>
      <span class="field-label field-label-to">Back in NZ</span>
      <input type="date" class="travel-to" value="${t.to || ''}" aria-label="Back in NZ on">
      <input type="text" class="travel-note" placeholder="Note (optional)" value="${escapeHtml(t.note || '')}" aria-label="Note">
      <button type="button" class="btn-icon remove-travel" title="Remove">&times;</button>
      <p class="travel-caption"></p>
    `;
    row.querySelector('.travel-from').addEventListener('change', e => { t.from = e.target.value; recalculate(); });
    row.querySelector('.travel-to').addEventListener('change', e => { t.to = e.target.value; recalculate(); });
    row.querySelector('.travel-note').addEventListener('change', e => { t.note = e.target.value; });
    row.querySelector('.remove-travel').addEventListener('click', () => removeTravelRow(t.id));
    container.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function getValidTravels() {
  const out = [];
  for (const t of state.travels) {
    const from = parseISODate(t.from);
    const to = parseISODate(t.to);
    if (!from || !to) continue;
    if (to < from) continue;
    out.push({ fromEpoch: epochDay(from), toEpoch: epochDay(to), fromDate: from, toDate: to });
  }
  return out;
}

function fmtSigned(n) {
  return (n > 0 ? '+' : '') + n;
}

function refreshTravelCaptions() {
  document.querySelectorAll('.travel-row').forEach(row => {
    const from = parseISODate(row.querySelector('.travel-from').value);
    const to = parseISODate(row.querySelector('.travel-to').value);
    const caption = row.querySelector('.travel-caption');
    if (from && to && to >= from) {
      const daysOut = Math.max(0, epochDay(to) - epochDay(from) - 1);
      caption.textContent = `${formatDateLong(from)} → ${formatDateLong(to)} · ${daysOut} day${daysOut === 1 ? '' : 's'} outside NZ`;
    } else if (from || to) {
      caption.textContent = 'Enter both dates to see the trip length.';
    } else {
      caption.textContent = '';
    }
  });
}

function recalculate() {
  refreshTravelCaptions();

  const errorsEl = document.getElementById('errors');
  errorsEl.innerHTML = '';
  const errors = [];

  const residencyDate = parseISODate(document.getElementById('residency-date').value);
  let citizenshipDate = parseISODate(document.getElementById('citizenship-date').value);
  document.getElementById('residency-date-confirm').textContent = residencyDate ? formatDateLong(residencyDate) : '';

  const req = {
    windowYears: state.requirements.windowYears,
    totalDaysRequired: state.requirements.totalDaysRequired,
    yearlyDaysRequired: state.requirements.yearlyDaysRequired
  };

  document.getElementById('recommended-date').textContent = '–';
  document.getElementById('earliest-date').textContent = '–';
  document.getElementById('results').hidden = true;

  if (!residencyDate) {
    if (document.getElementById('residency-date').value) errors.push('Residency date is not a valid date.');
    renderErrors(errors);
    return;
  }
  if (!document.getElementById('citizenship-date').value) {
    citizenshipDate = addYears(residencyDate, req.windowYears);
    document.getElementById('citizenship-date').value = toISODate(citizenshipDate);
  }
  document.getElementById('citizenship-date-confirm').textContent = citizenshipDate ? formatDateLong(citizenshipDate) : '';
  if (!citizenshipDate) {
    errors.push('Citizenship application date is not a valid date.');
    renderErrors(errors);
    return;
  }
  if (citizenshipDate <= residencyDate) {
    errors.push('Citizenship application date must be after your residency date.');
    renderErrors(errors);
    return;
  }

  const travels = getValidTravels();
  for (const t of state.travels) {
    if ((t.from && !t.to) || (!t.from && t.to)) {
      errors.push('A travel entry is missing its return date or departure date.');
      break;
    }
  }
  for (const t of state.travels) {
    const from = parseISODate(t.from), to = parseISODate(t.to);
    if (from && to && to < from) { errors.push('A travel entry has a "back in NZ" date before its "left NZ" date.'); break; }
  }
  renderErrors(errors);

  const residencyEpoch = epochDay(residencyDate);

  // Build a presence index covering everything we might need: from residency date
  // out to a generous search cap beyond the citizenship date, so both the displayed
  // window and the earliest-eligible-date search can query it in O(1).
  const searchCapDate = addYears(residencyDate, req.windowYears + 5);
  const latestNeeded = new Date(Math.max(citizenshipDate.getTime(), searchCapDate.getTime()));
  const rangeStartEpoch = residencyEpoch;
  const rangeEndEpoch = epochDay(latestNeeded) + 1;
  const presenceIndex = buildPresenceIndex(residencyEpoch, travels, rangeStartEpoch, rangeEndEpoch);

  const recommendedDate = addYears(residencyDate, req.windowYears);
  document.getElementById('recommended-date').textContent = formatDateLong(recommendedDate);

  const earliestDate = findEarliestEligibleDate(
    residencyEpoch, presenceIndex, req,
    residencyEpoch, epochDay(searchCapDate)
  );
  const earliestEl = document.getElementById('earliest-date');
  delete earliestEl.dataset.iso;
  if (earliestDate) {
    earliestEl.textContent = formatDateLong(earliestDate);
    earliestEl.dataset.iso = toISODate(earliestDate);
    const diffDays = epochDay(earliestDate) - epochDay(recommendedDate);
    const note = document.getElementById('earliest-date-note');
    if (diffDays < 0) note.textContent = `${Math.abs(diffDays)} day(s) earlier than the standard 5-year mark.`;
    else if (diffDays > 0) note.textContent = `${diffDays} day(s) later than the standard 5-year mark - your travel has pushed this back.`;
    else note.textContent = 'Same as the standard 5-year mark.';
  } else {
    earliestEl.textContent = 'Not yet reachable';
    document.getElementById('earliest-date-note').textContent =
      `No date within ${req.windowYears + 5} years of your residency date meets the requirement with the travel entered - add less travel or check your dates.`;
  }

  const report = computeWindowReport(residencyEpoch, travels, citizenshipDate, req, presenceIndex);
  renderResults(report, req, citizenshipDate);
}

function renderErrors(errors) {
  const el = document.getElementById('errors');
  el.innerHTML = '';
  if (errors.length === 0) { el.hidden = true; return; }
  el.hidden = false;
  for (const e of errors) {
    const p = document.createElement('p');
    p.textContent = e;
    el.appendChild(p);
  }
}

function statusBadge(ok, textOk, textBad) {
  return `<span class="badge ${ok ? 'badge-ok' : 'badge-bad'}">${ok ? textOk : textBad}</span>`;
}

function renderResults(report, req, citizenshipDate) {
  const resultsEl = document.getElementById('results');
  resultsEl.hidden = false;

  document.getElementById('window-range').textContent =
    `${formatDateLong(report.startDate)} → ${formatDateLong(report.endDate)} (day before application)`;

  document.getElementById('stat-total-in-nz').textContent = report.totalInNZ;
  document.getElementById('stat-total-required').textContent = req.totalDaysRequired;
  document.getElementById('stat-total-out').textContent = report.totalOut;
  document.getElementById('stat-remaining-out').textContent = report.windowRemainingOut;

  document.getElementById('stat-remaining-out').parentElement.classList.toggle('stat-bad', report.windowRemainingOut < 0);
  document.getElementById('overall-status').innerHTML = statusBadge(
    report.meetsTotalRequirement && report.years.every(y => y.meetsYearRequirement),
    'Requirement met',
    'Requirement not yet met'
  );

  const today = todayUTC();
  const todayEpoch = epochDay(today);

  const tbody = document.getElementById('year-table-body');
  tbody.innerHTML = '';
  for (const y of report.years) {
    const isCurrent = todayEpoch >= y.startEpoch && todayEpoch < y.endEpoch;
    const tr = document.createElement('tr');
    if (isCurrent) tr.classList.add('current-year');

    let statusHtml;
    if (!y.meetsYearRequirement) {
      statusHtml = statusBadge(false, '', 'Year limit exceeded');
    } else if (y.allowedFutureOut < 0) {
      statusHtml = statusBadge(false, '', '5-year limit exceeded');
    } else {
      statusHtml = statusBadge(true, 'On track', '');
    }

    tr.innerHTML = `
      <td>${isCurrent ? '<span class="current-dot" title="Current year"></span>' : ''}Year ${y.index}</td>
      <td>${formatDateLong(y.start)} – ${formatDateLong(new Date(y.end.getTime() - MS_PER_DAY))}</td>
      <td>${y.daysInChunk}</td>
      <td>${y.daysInNZ}</td>
      <td>${y.daysOut}</td>
      <td>${req.yearlyDaysRequired}</td>
      <td class="${y.allowedFutureOut < 0 ? 'cell-bad' : ''}">${fmtSigned(y.allowedFutureOut)}</td>
      <td>${statusHtml}</td>
    `;
    tbody.appendChild(tr);
  }
}

/* ---------- requirements panel ---------- */

function renderRequirementsInputs() {
  document.getElementById('req-window-years').value = state.requirements.windowYears;
  document.getElementById('req-total-days').value = state.requirements.totalDaysRequired;
  document.getElementById('req-yearly-days').value = state.requirements.yearlyDaysRequired;
}

function wireRequirementsInputs() {
  const wy = document.getElementById('req-window-years');
  const td = document.getElementById('req-total-days');
  const yd = document.getElementById('req-yearly-days');
  const onChange = () => {
    const winY = Math.max(1, parseInt(wy.value, 10) || state.requirements.windowYears);
    const total = Math.max(0, parseInt(td.value, 10) || 0);
    const yearly = Math.max(0, parseInt(yd.value, 10) || 0);
    state.requirements = { windowYears: winY, totalDaysRequired: total, yearlyDaysRequired: yearly };
    recalculate();
  };
  wy.addEventListener('change', onChange);
  td.addEventListener('change', onChange);
  yd.addEventListener('change', onChange);
}

/* ---------- init ---------- */

async function loadData() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('no data.json');
    return await res.json();
  } catch (e) {
    console.warn('Could not load data.json, starting blank.', e);
    return null;
  }
}

async function init() {
  const data = await loadData();

  if (data && data.requirements) {
    state.requirements = {
      windowYears: data.requirements.windowYears || 5,
      totalDaysRequired: data.requirements.totalDaysRequired ?? 1350,
      yearlyDaysRequired: data.requirements.yearlyDaysRequired ?? 240
    };
  }
  renderRequirementsInputs();
  wireRequirementsInputs();

  if (data && data.residencyDate) document.getElementById('residency-date').value = data.residencyDate;
  if (data && data.citizenshipDate) document.getElementById('citizenship-date').value = data.citizenshipDate;

  if (data && Array.isArray(data.travels) && data.travels.length) {
    for (const t of data.travels) {
      if (t && (t.from || t.to)) addTravelRow(t.from || '', t.to || '', t.note || '');
    }
  }
  if (state.travels.length === 0) addTravelRow();

  document.getElementById('residency-date').addEventListener('change', recalculate);
  document.getElementById('citizenship-date').addEventListener('change', recalculate);

  document.getElementById('add-travel').addEventListener('click', () => addTravelRow());

  document.getElementById('use-recommended').addEventListener('click', () => {
    const residencyDate = parseISODate(document.getElementById('residency-date').value);
    if (!residencyDate) return;
    document.getElementById('citizenship-date').value = toISODate(addYears(residencyDate, state.requirements.windowYears));
    recalculate();
  });

  document.getElementById('use-earliest').addEventListener('click', () => {
    const iso = document.getElementById('earliest-date').dataset.iso;
    if (iso) {
      document.getElementById('citizenship-date').value = iso;
      recalculate();
    }
  });

  recalculate();
}

document.addEventListener('DOMContentLoaded', init);
