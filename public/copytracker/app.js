(function () {
  const MAX_ROWS = 8;
  const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

  const followerEl = document.getElementById('follower');
  const labelEl = document.getElementById('followerLabel');
  const savedPick = document.getElementById('savedPick');
  const followerNote = document.getElementById('followerNote');
  const rowsEl = document.getElementById('rows');
  const addBtn = document.getElementById('add');
  const submitBtn = document.getElementById('submit');
  const form = document.getElementById('form');
  const hint = document.getElementById('hint');
  const noticesEl = document.getElementById('notices');
  const progressEl = document.getElementById('progress');
  const progressList = document.getElementById('progressList');
  const counterEl = document.getElementById('counter');

  const candTitle = document.getElementById('candTitle');
  const candStatus = document.getElementById('candStatus');
  const candScroll = document.getElementById('candScroll');
  const candBody = document.getElementById('candBody');
  const candFoot = document.getElementById('candFoot');

  const resultsEl = document.getElementById('results');
  const resultsTitleEl = document.getElementById('resultsTitle');
  const resultsSub = document.getElementById('resultsSub');
  const theadEl = document.getElementById('thead');
  const tbodyEl = document.getElementById('tbody');
  const emptyEl = document.getElementById('empty');
  const csvBtn = document.getElementById('csv');
  const usageEl = document.getElementById('usage');

  const trackMint = document.getElementById('trackMint');
  const trackBtn = document.getElementById('trackBtn');
  const trackedBody = document.getElementById('trackedBody');
  const loggerToggle = document.getElementById('loggerToggle');
  const loggerEmpty = document.getElementById('loggerEmpty');
  const loggerFoot = document.getElementById('loggerFoot');

  let rows = ['', ''];
  let lastResult = null;
  let expanded = null;
  let followers = [];

  // ---- form -----------------------------------------------------------------------------

  function render() {
    const focusIdx =
      document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.idx : null;

    rowsEl.innerHTML = '';
    rows.forEach((val, i) => {
      const row = document.createElement('div');
      row.className = 'row';

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'addr';
      input.placeholder = 'Token mint address';
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.value = val;
      input.dataset.idx = String(i);
      input.addEventListener('input', () => {
        rows[i] = input.value.trim();
        updateSubmit();
        markValidity(input, rows[i]);
      });
      row.appendChild(input);

      if (rows.length > 2) {
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn-remove';
        rm.textContent = '×';
        rm.title = 'Remove';
        rm.addEventListener('click', () => {
          rows.splice(i, 1);
          render();
          updateSubmit();
        });
        row.appendChild(rm);
      }

      rowsEl.appendChild(row);
      markValidity(input, val);
    });

    if (focusIdx !== null) {
      const back = rowsEl.querySelector('[data-idx="' + focusIdx + '"]');
      if (back) back.focus();
    }
    addBtn.disabled = rows.length >= MAX_ROWS;
  }

  function markValidity(input, value) {
    input.classList.toggle('invalid', value.length > 0 && !BASE58.test(value));
  }

  function validMints() {
    return [...new Set(rows.map((r) => r.trim()).filter((r) => BASE58.test(r)))];
  }

  function updateSubmit() {
    const follower = followerEl.value.trim();
    const mints = validMints();
    const okFollower = BASE58.test(follower);
    const ready = okFollower && mints.length >= 2;
    submitBtn.disabled = !ready;

    if (!okFollower) hint.textContent = 'Enter the wallet address you want to trace';
    else if (mints.length < 2) hint.textContent = 'Add at least 2 tokens that wallet bought';
    else hint.textContent = `Ready — tracing ${mints.length} token${mints.length === 1 ? '' : 's'}`;
  }

  followerEl.addEventListener('input', () => {
    markValidity(followerEl, followerEl.value.trim());
    // Typing an address by hand should still recognise a wallet already on file.
    const known = followers.find((f) => f.follower === followerEl.value.trim());
    savedPick.value = known ? known.follower : '';
    if (known && !labelEl.value) labelEl.value = known.label || '';
    describeFollower(known);
    updateSubmit();
  });

  savedPick.addEventListener('change', () => {
    const f = followers.find((x) => x.follower === savedPick.value);
    followerEl.value = f ? f.follower : '';
    labelEl.value = f ? f.label || '' : '';
    markValidity(followerEl, followerEl.value);
    describeFollower(f);
    updateSubmit();
    if (f) loadStoredCandidates(f.follower);
    else {
      candScroll.hidden = true;
      candStatus.hidden = false;
      candStatus.className = 'panel-status';
      candStatus.textContent = 'Run a trace to see who this wallet buys behind.';
      candTitle.textContent = 'Suspected sources';
      candFoot.textContent = '';
    }
  });

  /** The wallet's given name where it has one, so the UI talks about "Whale #1", not an address. */
  function nameFor(addr) {
    const f = followers.find((x) => x.follower === addr);
    return (f && f.label) || (labelEl.value.trim() || shortAddr(addr));
  }

  /**
   * Pulls the sources already established for a wallet straight from the stored log. No API
   * calls, so selecting a saved wallet shows what is known immediately instead of making you
   * re-run a trace to see it.
   */
  async function loadStoredCandidates(addr) {
    if (!BASE58.test(addr)) return;
    candStatus.hidden = false;
    candStatus.className = 'panel-status working';
    candStatus.textContent = 'Loading what is already on record…';
    try {
      const qs = new URLSearchParams({
        minHits: String(numOf('minHits', 2)),
        minTokens: String(numOf('minTokens', 2)),
        excludeBots: String(document.getElementById('excludeBots').checked),
      });
      const res = await fetch('/api/copy/candidates/' + addr + '?' + qs);
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'could not load');

      if (d.events === 0) {
        candScroll.hidden = true;
        candStatus.className = 'panel-status';
        candStatus.textContent = 'Nothing on record for this wallet yet. Run a trace to start the case file.';
        candFoot.textContent = '';
        candTitle.textContent = 'Suspected sources';
        return;
      }

      candTitle.textContent = 'Suspected sources · ' + (d.label || shortAddr(addr));
      renderCandidateRows(d.candidates);
      candFoot.textContent =
        `From ${d.events} buy${d.events === 1 ? '' : 's'} across ${d.tokens} token` +
        `${d.tokens === 1 ? '' : 's'} on record · ${d.considered} wallets seen` +
        (d.botsExcluded ? ` · ${d.botsExcluded} bots filtered out` : '');
    } catch {
      candStatus.className = 'panel-status';
      candStatus.textContent = 'Could not load stored sources.';
    }
  }

  /** Says what is already on record, so it is obvious a trace is adding to a case file. */
  function describeFollower(f) {
    if (!f) {
      followerNote.textContent =
        'The public wallet you suspect is copying someone else. Name it and every trace you run adds to the same case file.';
      return;
    }
    followerNote.textContent =
      `Already on record: ${f.events} buy${f.events === 1 ? '' : 's'} across ${f.tokens} token` +
      `${f.tokens === 1 ? '' : 's'}, ${f.repeat_candidates} wallet${f.repeat_candidates === 1 ? '' : 's'} ` +
      `seen leading on 2+ of them. New tokens build on this rather than replacing it.`;
  }

  async function refreshFollowers(selectAddr) {
    try {
      const res = await fetch('/api/copy/followers');
      followers = (await res.json()).followers || [];
    } catch {
      followers = [];
    }
    const chosen = selectAddr || savedPick.value;
    savedPick.innerHTML =
      '<option value="">New wallet…</option>' +
      followers
        .map(
          (f) =>
            '<option value="' +
            f.follower +
            '">' +
            escapeHtml(f.label || shortAddr(f.follower)) +
            ' · ' +
            f.events +
            ' buy' +
            (f.events === 1 ? '' : 's') +
            (f.repeat_candidates ? ' · ' + f.repeat_candidates + ' repeat' : '') +
            '</option>',
        )
        .join('');
    if (chosen) savedPick.value = chosen;
  }

  // Changing the bar re-filters what is already on record, without a new trace or a request.
  for (const id of ['minHits', 'minTokens', 'excludeBots']) {
    document.getElementById(id).addEventListener('change', () => {
      const addr = followerEl.value.trim();
      if (BASE58.test(addr)) loadStoredCandidates(addr);
    });
  }

  addBtn.addEventListener('click', () => {
    if (rows.length < MAX_ROWS) {
      rows.push('');
      render();
      updateSubmit();
    }
  });

  // ---- notices and progress ---------------------------------------------------------------

  function notice(kind, message) {
    const el = document.createElement('div');
    el.className = 'notice ' + kind;
    el.textContent = message;
    noticesEl.appendChild(el);
  }

  const PHASE_LABEL = {
    history: 'reading wallet history',
    window: 'scanning buy windows',
    scoring: 'scoring candidates',
  };

  function setProgress(phase, detail) {
    progressEl.hidden = false;
    progressList.innerHTML =
      '<li class="active"><span class="sym">' +
      escapeHtml(PHASE_LABEL[phase] || phase) +
      '</span><span class="state">' +
      escapeHtml(detail || '') +
      '</span></li>';
  }

  // ---- submit -----------------------------------------------------------------------------

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const follower = followerEl.value.trim();
    const mints = validMints();
    if (!BASE58.test(follower) || mints.length < 2) return;

    noticesEl.innerHTML = '';
    resultsEl.hidden = true;
    candBody.innerHTML = '';
    candScroll.hidden = true;
    candFoot.textContent = '';
    candStatus.hidden = false;
    candStatus.className = 'panel-status working';
    candStatus.textContent = 'Tracing…';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Tracing…';
    counterEl.textContent = '0 API requests';
    setProgress('history', 'starting');

    try {
      const res = await fetch('/api/copy/trace', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          follower,
          label: labelEl.value.trim() || null,
          mints,
          options: {
            windowSecs: numOf('windowSecs', 60),
            firstBuyOnly: document.getElementById('firstBuyOnly').checked,
            minHits: numOf('minHits', 2),
            minTokens: numOf('minTokens', 2),
            excludeBots: document.getElementById('excludeBots').checked,
          },
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'The trace could not be started.');
      listen(body.id);
    } catch (err) {
      finish();
      notice('error', err.message);
      candStatus.className = 'panel-status';
      candStatus.textContent = 'Trace failed.';
    }
  });

  function numOf(id, fallback) {
    const n = Number(document.getElementById(id).value);
    return Number.isFinite(n) ? n : fallback;
  }

  function finish() {
    submitBtn.textContent = 'Trace Sources';
    updateSubmit();
  }

  function listen(id) {
    const src = new EventSource('/api/copy/trace/' + id + '/events');

    src.onmessage = (ev) => {
      const e = JSON.parse(ev.data);
      if (e.type === 'phase') {
        setProgress(e.phase, e.detail);
      } else if (e.type === 'requests') {
        counterEl.textContent = e.count.toLocaleString() + ' API requests';
      } else if (e.type === 'warning') {
        notice(e.warning.kind === 'notice' ? 'info' : 'warn', e.warning.message);
      } else if (e.type === 'done') {
        src.close();
        for (const li of progressList.children) {
          li.classList.add('done');
          li.classList.remove('active');
        }
        finish();
        lastResult = e.result;
        renderCandidates(e.result);
        renderEvents(e.result);
        refreshFollowers(e.result.follower);
      } else if (e.type === 'error') {
        src.close();
        finish();
        notice('error', e.message);
        candStatus.className = 'panel-status';
        candStatus.textContent = 'Trace failed.';
      }
    };

    src.onerror = () => {
      src.close();
      finish();
      notice('error', 'Lost connection to the server while tracing.');
    };
  }

  // ---- candidates -------------------------------------------------------------------------

  function renderCandidates(result) {
    candTitle.textContent = 'Suspected sources · ' + nameFor(result.follower);
    renderCandidateRows(result.candidates);

    const qualifying = result.candidates.filter((c) => c.meetsBar);
    const strong = qualifying.filter((c) => c.band === 'strong').length;
    candFoot.textContent =
      `${result.stats.candidatesConsidered} wallet` +
      `${result.stats.candidatesConsidered === 1 ? '' : 's'} bought just before, over ` +
      `${result.stats.eventsAllTime} buy${result.stats.eventsAllTime === 1 ? '' : 's'} on record · ` +
      `${qualifying.length} met the bar` +
      (strong > 0 ? `, ${strong} scoring 7+` : '') +
      (result.stats.botsExcluded ? ` · ${result.stats.botsExcluded} bots filtered out` : '');
  }

  function renderCandidateRows(list) {
    candBody.innerHTML = '';
    expanded = null;

    if (list.length === 0) {
      candScroll.hidden = true;
      candStatus.hidden = false;
      candStatus.className = 'panel-status';
      candStatus.textContent =
        'Nobody bought in the window before any of these buys. Try a wider lookback window.';
      return;
    }

    candStatus.hidden = true;
    candScroll.hidden = false;

    let dividerDrawn = false;
    for (const c of list) {
      // Everything below the bar goes under a labelled divider, so a near-miss is never
      // mistaken for a conclusion.
      if (!c.meetsBar && !dividerDrawn) {
        dividerDrawn = true;
        const sep = document.createElement('tr');
        sep.className = 'cand-divider';
        sep.innerHTML =
          '<td colspan="4">Below the evidence bar — led only once, or on a single token. ' +
          'Shown for reference, not as findings.</td>';
        candBody.appendChild(sep);
      }
      const tr = document.createElement('tr');
      if (!c.meetsBar) tr.className = 'is-belowbar';
      tr.innerHTML =
        '<td>' +
        '<a class="cand-wallet" href="https://solscan.io/account/' +
        c.wallet +
        '" target="_blank" rel="noopener">' +
        shortAddr(c.wallet) +
        '</a>' +
        '<span class="cand-tokens">' +
        c.perToken.map((t) => escapeHtml(t.symbol)).join(', ') +
        '</span></td>' +
        '<td class="num-col"><button type="button" class="badge ' +
        c.band +
        '" title="Show the breakdown">' +
        c.score.toFixed(1) +
        '</button></td>' +
        '<td class="num-col">' +
        c.hits +
        '<span class="cand-tokens">of ' +
        c.events +
        '</span></td>' +
        '<td class="num-col cand-lead">' +
        formatLead(c.medianLeadMs) +
        '<em>' +
        (c.leadCv === null ? 'spread n/a' : 'CV ' + c.leadCv.toFixed(2)) +
        '</em></td>';

      tr.querySelector('.badge').addEventListener('click', () => toggleBreakdown(tr, c));
      candBody.appendChild(tr);
    }

  }

  function toggleBreakdown(tr, c) {
    if (expanded && expanded.row === tr) {
      expanded.detail.remove();
      expanded = null;
      return;
    }
    if (expanded) expanded.detail.remove();

    const detail = document.createElement('tr');
    detail.className = 'cand-breakdown';

    const comps = c.components
      .map(
        (comp) =>
          '<div class="cb-row' +
          (comp.measured ? '' : ' is-skipped') +
          '"><span class="cb-label">' +
          escapeHtml(comp.label) +
          '<span class="cb-weight"> ' +
          Math.round(comp.weight * 100) +
          '%</span></span>' +
          '<span class="cb-raw">' +
          (comp.score === null ? '—' : (comp.score * 10).toFixed(1)) +
          '</span>' +
          '<span class="cb-bar"><span style="width:' +
          (comp.score === null ? 0 : Math.round(comp.score * 100)) +
          '%"></span></span>' +
          '<span class="cb-raw">' +
          escapeHtml(comp.raw) +
          '</span></div>' +
          (comp.note ? '<p class="cb-note">' + escapeHtml(comp.note) + '</p>' : ''),
      )
      .join('');

    const activity = (c.activityShare * 100).toFixed(1);
    detail.innerHTML =
      '<td colspan="4"><div class="cb">' +
      '<div class="cb-head"><span class="cb-addr">' +
      c.wallet +
      '</span><span class="cb-cov">' +
      c.coverage +
      '% measured</span></div>' +
      comps +
      '<p class="cb-note">Made ' +
      activity +
      '% of all buys in the scanned windows' +
      (c.lift === null ? '' : ', so leading ' + c.hits + ' times is ' + c.lift.toFixed(1) + '× what chance predicts') +
      '. Closest lead ' +
      formatLead(c.minLeadMs) +
      '.</p>' +
      '</div></td>';

    tr.after(detail);
    expanded = { row: tr, detail };
  }

  // ---- analysed buys ------------------------------------------------------------------------

  function renderEvents(result) {
    resultsEl.hidden = false;
    const ev = result.events;

    resultsTitleEl.textContent = 'Buys analysed · ' + nameFor(result.follower);
    resultsSub.textContent =
      `${result.stats.eventsThisRun} buy${result.stats.eventsThisRun === 1 ? '' : 's'} analysed this run · ` +
      `${result.stats.freeWindows} free · ${result.stats.cachedWindows} already on record · ` +
      `${result.stats.paidWindows} fetched from Solana Tracker`;

    theadEl.innerHTML =
      '<tr><th>Token</th><th>Bought at</th><th class="num-col">Buys in window</th><th>Window source</th></tr>';

    tbodyEl.innerHTML = ev
      .map(
        (e) =>
          '<tr><td>' +
          escapeHtml(e.symbol) +
          '</td><td>' +
          new Date(e.time).toLocaleString() +
          '</td><td class="num-col">' +
          e.scannedBuys +
          (e.windowIncomplete ? ' <em title="Window could not be filled completely">partial</em>' : '') +
          '</td><td><span class="src-tag ' +
          e.source +
          '">' +
          (e.source === 'free' ? 'free log' : e.source === 'cached' ? 'on record' : 'solana tracker') +
          '</span></td></tr>',
      )
      .join('');

    emptyEl.hidden = ev.length > 0;
    if (ev.length === 0) emptyEl.textContent = 'No buys of those tokens were found for this wallet.';

    usageEl.textContent =
      `${result.stats.requests} API request${result.stats.requests === 1 ? '' : 's'} · ` +
      `${result.stats.cacheHits} served from cache · ${(result.stats.elapsedMs / 1000).toFixed(1)}s`;
  }

  csvBtn.addEventListener('click', () => {
    if (!lastResult) return;
    const head = ['wallet', 'confidence', 'band', 'leads', 'events', 'tokens', 'median_lead_ms', 'lift', 'activity_share'];
    const lines = [head.join(',')].concat(
      lastResult.candidates.map((c) =>
        [
          c.wallet,
          c.score,
          c.band,
          c.hits,
          c.events,
          c.tokens,
          c.medianLeadMs,
          c.lift === null ? '' : c.lift.toFixed(2),
          c.activityShare.toFixed(4),
        ].join(','),
      ),
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download =
      'copy-sources-' + nameFor(lastResult.follower).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.csv';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  // ---- free logger ----------------------------------------------------------------------------

  async function refreshLogger() {
    try {
      const res = await fetch('/api/copy/logger');
      const s = await res.json();

      loggerToggle.textContent = s.running ? 'Pause' : 'Start';
      trackedBody.innerHTML = s.tracked
        .map(
          (t) =>
            '<tr><td>' +
            escapeHtml(t.symbol || shortAddr(t.mint)) +
            '<span class="cand-tokens">' +
            shortAddr(t.mint) +
            '</span></td>' +
            '<td class="num-col">' +
            (t.pool ? (t.trades || 0).toLocaleString() : '<em>no pool</em>') +
            (t.covered_from && t.covered_to
              ? '<span class="cand-tokens">' + coveredSpan(t.covered_from, t.covered_to) + ' watched</span>'
              : '') +
            '</td><td>' +
            (t.last_poll ? new Date(t.last_poll).toLocaleTimeString() : 'never') +
            '</td>' +
            '<td class="num-col"><button type="button" class="btn-remove" data-untrack="' +
            t.mint +
            '">×</button></td></tr>',
        )
        .join('');

      loggerEmpty.hidden = s.tracked.length > 0;
      loggerFoot.textContent =
        `${s.log.trades.toLocaleString()} trades logged across ${s.log.mints} token${s.log.mints === 1 ? '' : 's'} · ` +
        `${s.log.events.toLocaleString()} buys on record for ${s.log.followers} wallet${s.log.followers === 1 ? '' : 's'}` +
        (s.lastError ? ` · last error: ${s.lastError}` : '');

      trackedBody.querySelectorAll('[data-untrack]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await fetch('/api/copy/logger/untrack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mint: btn.dataset.untrack }),
          });
          refreshLogger();
        });
      });
    } catch {
      loggerFoot.textContent = 'Logger status unavailable.';
    }
  }

  trackBtn.addEventListener('click', async () => {
    const mint = trackMint.value.trim();
    if (!BASE58.test(mint)) {
      notice('error', 'That is not a valid token mint address.');
      return;
    }
    trackBtn.disabled = true;
    trackBtn.textContent = 'Adding…';
    try {
      const res = await fetch('/api/copy/logger/track', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Could not watch that token.');
      trackMint.value = '';
      notice('info', 'Now watching that token for free. Windows it records cost nothing to analyse.');
      refreshLogger();
    } catch (err) {
      notice('error', err.message);
    } finally {
      trackBtn.disabled = false;
      trackBtn.textContent = 'Watch token';
    }
  });

  loggerToggle.addEventListener('click', async () => {
    const on = loggerToggle.textContent === 'Start';
    await fetch('/api/copy/logger/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ on }),
    });
    refreshLogger();
  });

  // ---- helpers ---------------------------------------------------------------------------------

  function shortAddr(a) {
    return a.slice(0, 4) + '…' + a.slice(-4);
  }

  function coveredSpan(from, to) {
    const mins = Math.max(0, (to - from) / 60000);
    if (mins < 90) return mins.toFixed(0) + 'min';
    const hrs = mins / 60;
    return hrs < 48 ? hrs.toFixed(1) + 'h' : (hrs / 24).toFixed(1) + 'd';
  }

  function formatLead(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 90000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'min';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  render();
  updateSubmit();
  refreshFollowers();
  refreshLogger();
  setInterval(refreshLogger, 30000);
})();
