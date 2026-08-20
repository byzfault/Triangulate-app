(function () {
  const MAX_ROWS = 5;
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  const rowsEl = document.getElementById('rows');
  const addBtn = document.getElementById('add');
  const submitBtn = document.getElementById('submit');
  const form = document.getElementById('form');
  const hint = document.getElementById('hint');
  const noticesEl = document.getElementById('notices');
  const progressEl = document.getElementById('progress');
  const progressList = document.getElementById('progressList');
  const counterEl = document.getElementById('counter');
  const resultsEl = document.getElementById('results');
  const resultsTitle = document.getElementById('resultsTitle');
  const resultsSub = document.getElementById('resultsSub');
  const theadEl = document.getElementById('thead');
  const tbodyEl = document.getElementById('tbody');
  const emptyEl = document.getElementById('empty');
  const csvBtn = document.getElementById('csv');
  const requireAll = document.getElementById('requireProfitOnAll');
  const nOfMRow = document.getElementById('nOfMRow');

  let rows = [''];
  let lastResult = null;
  let trending = [];
  let lastTrending = { h24: [], d7: [] };
  let sortKey = 'bestRoi';
  let sortAsc = false;

  // ---- form ---------------------------------------------------------------------------

  function render() {
    const focusIdx = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.idx
      : null;

    rowsEl.innerHTML = '';
    rows.forEach((val, i) => {
      const row = document.createElement('div');
      row.className = 'row';

      const label = document.createElement('label');
      label.textContent = 'Token address ' + (i + 1);
      label.htmlFor = 'token-' + i;

      const wrap = document.createElement('div');
      wrap.className = 'input-wrap';

      const input = document.createElement('input');
      input.type = 'text';
      input.id = 'token-' + i;
      input.dataset.idx = i;
      input.value = val;
      input.placeholder = 'Solana token mint address';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.addEventListener('input', (e) => {
        rows[i] = e.target.value.trim();
        validateField(input, row, i);
        updateSubmit();
      });
      input.addEventListener('blur', () => validateField(input, row, i));

      wrap.appendChild(input);

      const pick = document.createElement('button');
      pick.type = 'button';
      pick.className = 'btn-pick';
      pick.textContent = '▾';
      pick.title = 'Pick from trending';
      pick.setAttribute('aria-label', 'Pick a trending token for field ' + (i + 1));
      pick.addEventListener('click', (ev) => { ev.stopPropagation(); openPicker(row, i); });
      wrap.appendChild(pick);

      if (rows.length >= 2) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn-remove';
        rm.setAttribute('aria-label', 'Remove token address ' + (i + 1));
        rm.textContent = '×';
        rm.addEventListener('click', () => {
          rows.splice(i, 1);
          render();
          updateSubmit();
        });
        wrap.appendChild(rm);
      }

      const err = document.createElement('p');
      err.className = 'field-error';
      err.textContent = "This doesn't look like a valid Solana address";

      row.appendChild(label);
      row.appendChild(wrap);
      row.appendChild(err);
      rowsEl.appendChild(row);

      validateField(input, row, i, true);
    });

    addBtn.disabled = rows.length >= MAX_ROWS;
    addBtn.textContent = rows.length >= MAX_ROWS ? 'Maximum of ' + MAX_ROWS + ' tokens' : '+ Add token address';

    if (focusIdx !== null) {
      const el = document.querySelector('input[data-idx="' + focusIdx + '"]');
      if (el) el.focus();
    }
  }

  function validateField(input, row, i, quiet) {
    const v = rows[i];
    const bad = v.length > 0 && !BASE58.test(v);
    input.classList.toggle('invalid', bad && !quiet);
    row.classList.toggle('has-error', bad && !quiet);
    return !bad;
  }

  function validMints() {
    return rows.filter((v) => BASE58.test(v));
  }

  function updateSubmit() {
    const anyBad = rows.some((v) => v.length > 0 && !BASE58.test(v));
    const n = new Set(validMints()).size;
    submitBtn.disabled = n < 2 || anyBad;
    hint.textContent =
      n < 2 ? 'Paste at least 2 token mint addresses to search' : `Ready to search ${n} tokens`;
  }

  addBtn.addEventListener('click', () => {
    if (rows.length < MAX_ROWS) {
      rows.push('');
      render();
      updateSubmit();
      const last = document.querySelector('input[data-idx="' + (rows.length - 1) + '"]');
      if (last) last.focus();
    }
  });

  requireAll.addEventListener('change', () => {
    nOfMRow.style.display = requireAll.checked ? 'none' : '';
  });
  nOfMRow.style.display = 'none';

  const numOf = (id, fallback) => Number(document.getElementById(id).value) || fallback;
  const onOf = (id) => document.getElementById(id).checked;

  function readFilters() {
    return {
      minRoiPercent: Number(document.getElementById('minRoiPercent').value) || 0,
      minInvestedUsd: Number(document.getElementById('minInvestedUsd').value) || 0,
      maxBuysPerToken: numOf('maxBuysPerToken', 10),
      requireRealisedProfit: onOf('requireRealisedProfit'),
      requireProfitOnAll: requireAll.checked,
      minProfitableTokens: numOf('minProfitableTokens', 2),
      checkWalletProfitability: onOf('checkWalletProfitability'),
      minWalletRoi: Number(document.getElementById('minWalletRoi').value) || 0,
      minWinRate: Number(document.getElementById('minWinRate').value) || 0,
      checkRecentActivity: onOf('checkRecentActivity'),
      activityWindowDays: numOf('activityWindowDays', 3),
      maxTradesInWindow: numOf('maxTradesInWindow', 10),
      maxWalletChecks: numOf('maxWalletChecks', 40),
    };
  }

  // ---- notices and progress -----------------------------------------------------------

  function notice(kind, message) {
    const el = document.createElement('div');
    el.className = 'notice ' + kind;
    el.textContent = message;
    noticesEl.appendChild(el);
  }

  function setupProgress(mints) {
    progressList.innerHTML = '';
    for (const mint of mints) {
      const li = document.createElement('li');
      li.dataset.mint = mint;
      li.innerHTML =
        '<span class="sym">' + mint.slice(0, 4) + '…' + mint.slice(-4) + '</span><span class="state">waiting</span>';
      progressList.appendChild(li);
    }
    const li = document.createElement('li');
    li.dataset.mint = '__final';
    li.innerHTML = '<span class="sym">All tokens</span><span class="state">waiting</span>';
    progressList.appendChild(li);
    progressEl.hidden = false;
  }

  const PHASE_LABEL = {
    metadata: 'fetching token info',
    anchor: 'fetching trades',
    intersect: 'intersecting',
    launch: 'establishing launch time',
    ranking: 'computing PnL',
    activity: 'checking recent activity',
    record: 'checking track record',
  };

  function updateProgress(mint, phase, detail) {
    const key = mint === null ? '__final' : mint;
    const li = progressList.querySelector('[data-mint="' + key + '"]');
    if (!li) return;
    for (const other of progressList.children) other.classList.remove('active');
    li.classList.add('active');
    li.querySelector('.state').textContent = detail || PHASE_LABEL[phase] || phase;
    // Anything above this one in the list has necessarily finished.
    let seen = false;
    for (const other of progressList.children) {
      if (other === li) { seen = true; continue; }
      if (!seen) other.classList.add('done');
    }
  }

  // ---- submit -------------------------------------------------------------------------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (submitBtn.disabled) return;

    const mints = [...new Set(validMints())];
    noticesEl.innerHTML = '';
    resultsEl.hidden = true;
    lastResult = null;
    deepRequests = 0;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Searching…';
    counterEl.textContent = '0 API requests';
    setupProgress(mints);

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mints,
          filters: readFilters(),
          refresh: document.getElementById('refresh').checked,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'The search could not be started.');
      listen(body.id);
    } catch (err) {
      finishSearch();
      notice('error', err.message);
    }
  });

  function finishSearch() {
    submitBtn.disabled = false;
    submitBtn.innerHTML =
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.5" y2="16.5"></line></svg>Find Wallets';
    updateSubmit();
  }

  function listen(id) {
    const src = new EventSource('/api/search/' + id + '/events');

    src.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === 'phase') {
        updateProgress(e.mint, e.phase, e.detail);
      } else if (e.type === 'requests') {
        counterEl.textContent = e.count.toLocaleString() + ' API requests';
      } else if (e.type === 'warning') {
        notice(e.warning.kind === 'notice' ? 'info' : 'warn', e.warning.message);
      } else if (e.type === 'done') {
        src.close();
        for (const li of progressList.children) { li.classList.add('done'); li.classList.remove('active'); }
        finishSearch();
        lastResult = e.result;
        renderResults(e.result);
      } else if (e.type === 'error') {
        src.close();
        finishSearch();
        notice('error', e.message);
      }
    };

    src.onerror = () => {
      src.close();
      finishSearch();
      notice('error', 'Lost connection to the server while searching.');
    };
  }

  // ---- results ------------------------------------------------------------------------

  const TROJAN_REF = 'Byzfault';
  const TROJAN_PERIOD = '3d';
  const trojanUrl = (wallet) =>
    'https://trojan.com/wallet?address=' + encodeURIComponent(wallet) +
    '&ref=' + TROJAN_REF + '&period=' + TROJAN_PERIOD;

  const usd = (n) =>
    (n < 0 ? '-$' : '$') +
    Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: Math.abs(n) < 100 ? 2 : 0 });

  /** ROI reads better as a multiple once it's large: 15,000% is really a 151x. */
  const roiTxt = (r) => {
    if (r === null || r === undefined || !isFinite(r)) return '—';
    if (Math.abs(r) >= 900) return (1 + r / 100).toFixed(0) + 'x';
    return r.toFixed(0) + '%';
  };

  const compact = (n) => n.toLocaleString(undefined, { maximumFractionDigits: n < 1 ? 4 : 2 });

  function dur(secs) {
    if (secs === null || secs === undefined) return '—';
    const abs = Math.abs(secs);
    const sign = secs < 0 ? '-' : '';
    if (abs < 60) return sign + Math.round(abs) + 's';
    if (abs < 3600) return sign + Math.round(abs / 60) + 'm';
    if (abs < 86400) return sign + (abs / 3600).toFixed(1) + 'h';
    return sign + (abs / 86400).toFixed(1) + 'd';
  }

  const afterLaunch = (hours) => (hours === null || hours === undefined ? '—' : dur(hours * 3600));

  function renderResults(result) {
    resultsEl.hidden = false;
    const s = result.stats;
    resultsTitle.textContent = result.rows.length.toLocaleString() + ' wallets match across ' + result.tokens.length + ' tokens';
    resultsSub.textContent =
      s.anchorWallets.toLocaleString() + ' scanned → ' + s.intersectionSize.toLocaleString() + ' bought all → ' +
      s.afterFilters.toLocaleString() + ' after filters (' + s.activityChecked + ' activity-checked) · ' +
      s.requests.toLocaleString() + ' requests, ' +
      s.cacheHits.toLocaleString() + ' cached · ' + (s.elapsedMs / 1000).toFixed(1) + 's';

    if (result.rows.length === 0) {
      theadEl.innerHTML = '';
      tbodyEl.innerHTML = '';
      emptyEl.hidden = false;
      emptyEl.textContent =
        s.intersectionSize === 0
          ? 'No wallet bought every one of these tokens. Try fewer tokens, or tokens from a similar time period.'
          : s.intersectionSize + ' wallets bought all of them, but none survived the filters. Try relaxing the profit requirement, or the sniper and bot thresholds.';
      return;
    }
    emptyEl.hidden = true;
    buildTable(result);
    renderUsage();
  }

  function buildTable(result) {
    const tokens = result.tokens;

    const groupRow = document.createElement('tr');
    groupRow.innerHTML = '<th class="wallet" rowspan="2">Wallet</th><th rowspan="2" class="score-cell">Score</th>';
    for (const t of tokens) {
      const th = document.createElement('th');
      th.className = 'group';
      th.colSpan = 6;
      th.textContent = t.symbol;
      th.title = t.mint;
      groupRow.appendChild(th);
    }
    groupRow.insertAdjacentHTML(
      'beforeend',
      '<th class="group" colspan="7">Combined</th><th class="group" rowspan="2">Activity</th>',
    );

    const headRow = document.createElement('tr');
    const cols = [];
    for (const t of tokens) {
      cols.push(
        { key: 'tok:' + t.mint + ':roi', label: 'ROI', groupStart: true, title: 'Return on this position — the multiple' },
        { key: 'tok:' + t.mint + ':realized', label: 'Realized' },
        { key: 'tok:' + t.mint + ':invested', label: 'Staked' },
        { key: 'tok:' + t.mint + ':buys', label: 'B/S' },
        { key: 'tok:' + t.mint + ':firstBuy', label: 'After launch', title: 'Time from the token’s derived launch to this wallet’s first buy' },
        { key: 'tok:' + t.mint + ':hold', label: 'Held for' },
        { key: 'tok:' + t.mint + ':balance', label: 'Balance' },
      );
    }
    cols.push(
      { key: 'bestRoi', label: 'Best ROI', groupStart: true, title: 'Best multiple across the queried tokens' },
      { key: 'totalInvested', label: 'Total staked' },
      { key: 'walletRoi', label: 'Wallet ROI', title: 'ROI across every token this wallet has traded' },
      { key: 'combinedRealized', label: 'Realized' },
      { key: 'combinedUnrealized', label: 'Unrealized' },
      { key: 'totalBuys', label: 'Buys' },
      { key: 'totalSells', label: 'Sells' },
      { key: 'tradesInWindow', label: 'Recent', groupStart: true, title: 'Wallet-wide trades across all tokens in the recent window' },
    );

    for (const col of cols) {
      const th = document.createElement('th');
      th.textContent = col.label;
      if (col.title) th.title = col.title;
      th.dataset.key = col.key;
      if (col.groupStart) th.classList.add('group');
      if (col.key === sortKey) th.classList.add(sortAsc ? 'asc' : 'sorted');
      th.addEventListener('click', () => {
        if (sortKey === col.key) sortAsc = !sortAsc;
        else { sortKey = col.key; sortAsc = false; }
        buildTable(result);
      });
      headRow.appendChild(th);
    }

    theadEl.innerHTML = '';
    theadEl.appendChild(groupRow);
    theadEl.appendChild(headRow);

    const sorted = [...result.rows].sort((a, b) => {
      const va = valueFor(a, sortKey);
      const vb = valueFor(b, sortKey);
      return sortAsc ? va - vb : vb - va;
    });

    tbodyEl.innerHTML = '';
    for (const row of sorted) {
      const tr = document.createElement('tr');

      const wallet = document.createElement('td');
      wallet.className = 'wallet addr';
      wallet.innerHTML =
        '<a href="https://solscan.io/account/' + row.wallet + '" target="_blank" rel="noopener">' +
        row.wallet.slice(0, 4) + '…' + row.wallet.slice(-4) + '</a>' +
        '<span class="links"><a href="' + trojanUrl(row.wallet) +
        '" target="_blank" rel="noopener">Trojan</a></span>';
      tr.appendChild(wallet);
      tr.appendChild(scoreCell(row, tokens));

      for (const t of tokens) {
        const p = row.perToken[t.mint] || {};
        tr.appendChild(cell(roiTxt(p.roi), p.roi, true));
        tr.appendChild(cell(usd(p.realized || 0), p.realized));
        tr.appendChild(cell(usd(p.invested || 0)));
        tr.appendChild(cell((p.buys || 0) + '/' + (p.sells || 0)));
        tr.appendChild(cell(afterLaunch(p.hoursAfterLaunch)));
        tr.appendChild(cell(dur(p.holdTimeSecs)));
        tr.appendChild(cell(p.balance > 0 ? compact(p.balance) : '—'));
      }

      tr.appendChild(cell(roiTxt(row.bestRoi), row.bestRoi, true));
      tr.appendChild(cell(usd(row.totalInvested)));
      tr.appendChild(cell(row.walletRoi === null ? '—' : row.walletRoi.toFixed(0) + '%', row.walletRoi));
      tr.appendChild(cell(usd(row.combinedRealized), row.combinedRealized));
      tr.appendChild(cell(usd(row.combinedUnrealized), row.combinedUnrealized));
      tr.appendChild(cell(String(row.totalBuys)));
      tr.appendChild(cell(String(row.totalSells)));
      tr.appendChild(cell(row.tradesInWindow === null ? '—' : String(row.tradesInWindow), null, true));

      tbodyEl.appendChild(tr);
    }
  }

  function cell(text, value, groupStart) {
    const td = document.createElement('td');
    td.textContent = text;
    if (typeof value === 'number' && value !== 0) td.classList.add(value > 0 ? 'pos' : 'neg');
    if (groupStart) td.classList.add('group-start');
    return td;
  }

  function valueFor(row, key) {
    if (key === 'score') return row.score && row.score.score !== null ? row.score.score : -Infinity;
    if (!key.startsWith('tok:')) return row[key] ?? 0;
    const [, mint, field] = key.split(':');
    const p = row.perToken[mint];
    if (!p) return -Infinity;
    // Nulls sort last in both directions rather than reading as zero.
    if (field === 'firstBuy') return p.hoursAfterLaunch === null ? Infinity : p.hoursAfterLaunch;
    if (field === 'hold') return p.holdTimeSecs === null ? -Infinity : p.holdTimeSecs;
    if (field === 'buys') return p.buys;
    if (field === 'roi') return p.roi === null ? -Infinity : p.roi;
    return p[field] ?? 0;
  }

  // ---- score badge and breakdown --------------------------------------------------------

  function scoreCell(row, tokens) {
    const td = document.createElement('td');
    td.className = 'score-cell';

    const s = row.score;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'badge ' + (s ? s.band : 'none');
    btn.textContent = s && s.score !== null ? s.score.toFixed(1) : '—';
    btn.title = s && s.score !== null
      ? 'Tier ' + s.tier + ' · click for the breakdown'
      : 'Not enough measurable data to score this wallet';

    btn.addEventListener('click', () => toggleBreakdown(td, row, tokens));
    td.appendChild(btn);
    return td;
  }

  function toggleBreakdown(td, row, tokens) {
    const tr = td.parentElement;
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('breakdown')) { next.remove(); return; }

    const bdRow = document.createElement('tr');
    bdRow.className = 'breakdown';
    const cell = document.createElement('td');
    cell.colSpan = tr.children.length;
    cell.appendChild(renderBreakdown(row, tokens, bdRow));
    bdRow.appendChild(cell);
    tr.after(bdRow);
  }

  function renderBreakdown(row, tokens, bdRow) {
    const s = row.score;
    const box = document.createElement('div');
    box.className = 'bd';

    const head = document.createElement('div');
    head.className = 'bd-head';
    const tier = document.createElement('span');
    tier.className = 'bd-tier';
    tier.textContent = s
      ? 'Tier ' + s.tier + (s.tier === 1 ? ' — no extra API calls' : ' — deep check') +
        ' · ' + Math.round(s.coverage * 100) + '% of weight measurable'
      : 'not scored';
    head.appendChild(tier);

    const deep = document.createElement('button');
    deep.type = 'button';
    deep.className = 'btn-deep';
    deep.textContent = s && s.tier === 2 ? 'Deep check done' : 'Deep check (uses API credits)';
    deep.disabled = !!(s && s.tier === 2);
    deep.addEventListener('click', () => runDeepCheck(row, tokens, deep, bdRow));
    head.appendChild(deep);
    box.appendChild(head);

    for (const c of (s ? s.components : [])) {
      const line = document.createElement('div');
      line.className = 'bd-row' + (c.measured ? '' : ' unmeasured');

      const label = document.createElement('div');
      label.className = 'bd-label';
      label.textContent = c.label;

      const weight = document.createElement('div');
      weight.className = 'bd-weight';
      weight.textContent = c.measured
        ? Math.round(c.effectiveWeight * 100) + '%'
        : 'skipped';

      const bar = document.createElement('div');
      bar.className = 'bd-bar';
      const fill = document.createElement('span');
      fill.style.width = ((c.score ?? 0) * 100).toFixed(0) + '%';
      bar.appendChild(fill);

      const raw = document.createElement('div');
      raw.className = 'bd-raw';
      raw.textContent = c.raw + (c.score !== null ? '  (' + (c.score * 10).toFixed(1) + '/10)' : '');

      line.appendChild(label);
      line.appendChild(weight);
      line.appendChild(bar);
      line.appendChild(raw);

      if (c.note) {
        const note = document.createElement('div');
        note.className = 'bd-note';
        note.textContent = c.note;
        line.appendChild(note);
      }
      box.appendChild(line);
    }

    return box;
  }

  async function runDeepCheck(row, tokens, btn, bdRow) {
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
      const res = await fetch('/api/deep-check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          wallet: row.wallet,
          row,
          tokens,
          requireProfitOnAll: requireAll.checked,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Deep check failed.');

      row.score = body.score;
      deepRequests += body.requests;
      renderUsage();

      // Re-render this wallet's badge and its open breakdown in place.
      const tr = bdRow.previousElementSibling;
      if (tr) {
        const oldCell = tr.children[1];
        if (oldCell) tr.replaceChild(scoreCell(row, tokens), oldCell);
      }
      bdRow.firstChild.innerHTML = '';
      bdRow.firstChild.appendChild(renderBreakdown(row, tokens, bdRow));
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Deep check failed — retry';
      notice('error', err.message);
    }
  }

  // ---- usage footer ---------------------------------------------------------------------

  let deepRequests = 0;
  const usageEl = document.getElementById('usage');

  function renderUsage() {
    if (!lastResult) { usageEl.textContent = ''; return; }
    const s = lastResult.stats;
    const total = s.requests + s.cacheHits;
    const pct = total > 0 ? Math.round((s.cacheHits / total) * 100) : 0;
    usageEl.innerHTML =
      '<span><strong>' + s.requests.toLocaleString() + '</strong> API requests this search</span>' +
      '<span><strong>' + s.cacheHits.toLocaleString() + '</strong> served from cache (' + pct + '%)</span>' +
      (deepRequests > 0 ? '<span><strong>' + deepRequests + '</strong> from deep checks</span>' : '') +
      '<span>' + (s.elapsedMs / 1000).toFixed(1) + 's</span>';
  }

  // ---- CSV ----------------------------------------------------------------------------

  csvBtn.addEventListener('click', () => {
    if (!lastResult) return;
    const tokens = lastResult.tokens;

    const header = ['wallet', 'score', 'score band'];
    for (const t of tokens) {
      const s = t.symbol;
      header.push(
        s + ' realized USD', s + ' unrealized USD', s + ' buys', s + ' sells',
        s + ' hours after launch', s + ' hold secs', s + ' balance',
      );
    }
    header.push('combined realized USD', 'combined unrealized USD', 'total buys', 'total sells',
      'profitable tokens', 'lifetime trades', 'max hold secs',
      'sniper', 'bot', 'deployer');

    const lines = [header.map(csvCell).join(',')];
    for (const row of lastResult.rows) {
      const out = [row.wallet, row.score && row.score.score !== null ? row.score.score : '', row.score ? row.score.band : ''];
      for (const t of tokens) {
        const p = row.perToken[t.mint] || {};
        out.push(p.realized ?? '', p.unrealized ?? '', p.buys ?? '', p.sells ?? '',
          p.hoursAfterLaunch ?? '', p.holdTimeSecs ?? '', p.balance ?? '');
      }
      out.push(row.combinedRealized, row.combinedUnrealized, row.totalBuys, row.totalSells,
        row.profitableTokens, row.walletLifetimeTrades ?? '', row.maxHoldSecs ?? '',
        row.flags.sniper, row.flags.bot, row.flags.deployer);
      lines.push(out.map(csvCell).join(','));
    }

    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'triangular-' + tokens.map((t) => t.symbol).join('-') + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  // ---- trending panels ------------------------------------------------------------------

  const PANELS = {
    h24: { list: 'list24h', status: 'status24h', foot: 'foot24h' },
    d7: { list: 'list7d', status: 'status7d', foot: 'foot7d' },
  };

  const fmtVol = (n) => {
    if (n === null || n === undefined) return '—';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + n.toFixed(0);
  };

  async function loadTrending() {
    try {
      const res = await fetch('/api/trending');
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Trending unavailable.');

      renderPanel('h24', body.h24.tokens, {
        foot: 'Ranked by 24h volume · GeckoTerminal · ' +
          (body.h24.cached ? 'cached ' : 'fetched ') + ago(body.h24.fetchedAt),
      });

      renderPanel('d7', body.d7.tokens, {
        computing: body.d7.computing,
        foot: body.d7.fetchedAt
          ? 'Ranked by true 7-day volume, summed from daily candles · updated ' + ago(body.d7.fetchedAt)
          : '',
        status: body.d7.computing
          ? 'Summing 7 days of daily volume across ~100 pools. This takes a few minutes on the free API and then caches for an hour.'
          : 'No 7-day data yet.',
      });

      lastTrending = { h24: body.h24.tokens || [], d7: body.d7.tokens || [] };

      // The picker offers both lists, deduped.
      const seen = new Set();
      trending = [...(body.h24.tokens || []), ...(body.d7.tokens || [])].filter((t) => {
        if (seen.has(t.mint)) return false;
        seen.add(t.mint);
        return true;
      });
    } catch (err) {
      for (const key of Object.keys(PANELS)) {
        const st = document.getElementById(PANELS[key].status);
        st.hidden = false;
        st.textContent = err.message;
      }
    }
  }

  const ago = (t) => {
    if (!t) return '';
    const s = Math.round((Date.now() - t) / 1000);
    return (s < 60 ? s + 's' : s < 3600 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h') + ' ago';
  };

  function renderPanel(key, tokens, opts) {
    const cfg = PANELS[key];
    const listEl = document.getElementById(cfg.list);
    const statusEl = document.getElementById(cfg.status);
    const footEl = document.getElementById(cfg.foot);

    tokens = tokens || [];
    statusEl.hidden = tokens.length > 0;
    statusEl.classList.toggle('working', !!(opts && opts.computing));
    if (tokens.length === 0 && opts && opts.status) statusEl.textContent = opts.status;

    listEl.innerHTML = '';
    for (const t of tokens) {
      const li = document.createElement('li');

      const main = document.createElement('div');
      main.className = 'trend-main';
      const sym = document.createElement('div');
      sym.className = 'trend-sym';
      sym.textContent = t.symbol;
      sym.title = t.name;
      const meta = document.createElement('div');
      meta.className = 'trend-meta';
      meta.textContent = t.mint.slice(0, 4) + '…' + t.mint.slice(-4) + ' · ' + fmtVol(t.volume24h);
      meta.title = key === 'd7' ? 'Total volume over the last 7 days' : 'Volume over the last 24 hours';
      main.appendChild(sym);
      main.appendChild(meta);

      const chg = document.createElement('div');
      chg.className = 'trend-chg ' + (t.priceChange24h >= 0 ? 'up' : 'down');
      chg.textContent = t.priceChange24h === null ? '—' : (t.priceChange24h > 0 ? '+' : '') + t.priceChange24h.toFixed(0) + '%';
      chg.title = '24h price change';

      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'btn-trend-add';
      add.textContent = 'Add';
      add.addEventListener('click', () => addMint(t.mint));

      li.appendChild(main);
      li.appendChild(chg);
      li.appendChild(add);
      listEl.appendChild(li);
    }

    if (opts && opts.foot) footEl.textContent = opts.foot;
  }

  /** Fills the first empty field, else appends one, respecting the 5-field maximum. */
  function addMint(mint) {
    if (rows.includes(mint)) { flashHint('That token is already in the list.'); return; }

    let idx = rows.findIndex((v) => v.trim() === '');
    if (idx === -1) {
      if (rows.length >= MAX_ROWS) { flashHint('Maximum of ' + MAX_ROWS + ' tokens — remove one first.'); return; }
      rows.push('');
      idx = rows.length - 1;
    }
    rows[idx] = mint;
    render();
    updateSubmit();
  }

  let hintTimer = null;
  function flashHint(msg) {
    hint.textContent = msg;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(updateSubmit, 2500);
  }

  // ---- per-input trending picker ----------------------------------------------------------

  let openPickerEl = null;
  function closePicker() {
    if (openPickerEl) { openPickerEl.remove(); openPickerEl = null; }
  }
  document.addEventListener('click', closePicker);

  function openPicker(rowEl, idx) {
    closePicker();
    if (trending.length === 0) { flashHint('Trending list not loaded yet.'); return; }

    const el = document.createElement('div');
    el.className = 'picker';
    el.addEventListener('click', (e) => e.stopPropagation());

    for (const t of trending) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.symbol + '  ·  ' + fmtVol(t.volume24h) + '  ·  ' + t.mint.slice(0, 4) + '…' + t.mint.slice(-4);
      b.addEventListener('click', () => {
        closePicker();
        if (rows.includes(t.mint) && rows[idx] !== t.mint) { flashHint('That token is already in the list.'); return; }
        rows[idx] = t.mint;
        render();
        updateSubmit();
      });
      el.appendChild(b);
    }

    rowEl.appendChild(el);
    openPickerEl = el;
  }

  document.getElementById('fill7d').addEventListener('click', () => {
    const list = (lastTrending.d7 || []).slice(0, MAX_ROWS);
    if (list.length === 0) { flashHint('The 7-day list is still computing.'); return; }
    rows = list.map((t) => t.mint);
    render();
    updateSubmit();
  });

  loadTrending();
  setInterval(loadTrending, 60_000);

  render();
  updateSubmit();
})();
