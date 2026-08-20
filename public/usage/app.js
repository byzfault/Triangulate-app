(function () {
  const el = (id) => document.getElementById(id);

  async function refresh() {
    let u;
    try {
      const res = await fetch('/api/usage');
      if (!res.ok) throw new Error();
      u = await res.json();
    } catch {
      el('foot').textContent = 'Usage data unavailable.';
      return;
    }

    // --- free ---
    el('freeCount').textContent = u.free.thisPeriod.toLocaleString();
    el('freeAllTime').textContent = `${u.free.allTime.toLocaleString()} since the suite was first run`;

    // --- provider's own verdict outranks our count ---
    const banner = el('exhaustedBanner');
    if (u.exhausted) {
      banner.hidden = false;
      banner.textContent =
        'Solana Tracker reports no credits left on this plan, as of ' +
        new Date(u.exhausted.since).toLocaleString() +
        '. The figures below only count requests made since this meter was installed' +
        (u.countingSince ? ' on ' + new Date(u.countingSince).toLocaleDateString() : '') +
        ', so they under-report anything spent before that. Traces will fail until you top up ' +
        'or the plan resets. The free trade logger is unaffected and keeps recording.';
      el('quotaCard').classList.add('is-exhausted');
    } else {
      banner.hidden = true;
      el('quotaCard').classList.remove('is-exhausted');
    }

    // --- quota ---
    el('quotaCount').textContent = u.quota.used.toLocaleString();
    el('quotaSub').textContent = `of ${u.quota.limit.toLocaleString()} · ${u.quota.remaining.toLocaleString()} left`;
    setMeter(el('quotaBar'), u.quota.percent);
    el('quotaReset').innerHTML =
      (u.countingSince
        ? '<em>Counted from ' + new Date(u.countingSince).toLocaleDateString() + ', not from your plan start.</em><br>'
        : '') +
      `Resets ${new Date(u.period.end).toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}` +
      ` (day ${u.period.resetDay} of the month)`;

    // --- paid ---
    const paidCard = el('paidCard');
    el('paidCount').textContent = u.paid.enabled ? u.paid.used.toLocaleString() : 'Off';
    paidCard.classList.toggle('is-off', !u.paid.enabled);

    if (u.paid.enabled) {
      el('paidSub').textContent = `of ${u.paid.limit.toLocaleString()} credit · ${u.paid.remaining.toLocaleString()} left`;
      setMeter(el('paidBar'), u.paid.limit > 0 ? (u.paid.used / u.paid.limit) * 100 : 0);
      el('paidNote').textContent =
        u.quota.remaining > 0
          ? 'Enabled, but not in use — the free allowance has not run out yet, and it is always spent first.'
          : 'In use. The free allowance is spent, so requests are now drawing on paid credit.';
    } else {
      el('paidSub').textContent = 'not enabled';
      setMeter(el('paidBar'), 0);
      el('paidNote').textContent =
        'Paid credit is switched off, so when the monthly allowance runs out the tools stop rather than spending money.';
    }

    // --- daily ---
    const daily = u.daily || [];
    el('dailyBody').innerHTML = daily
      .map((d) => {
        const total = (d.free || 0) + (d.quota || 0) + (d.paid || 0);
        return (
          `<tr><td>${d.day}</td><td class="num-col">${(d.free || 0).toLocaleString()}</td>` +
          `<td class="num-col">${(d.quota || 0).toLocaleString()}</td>` +
          `<td class="num-col">${(d.paid || 0).toLocaleString()}</td>` +
          `<td class="num-col">${total.toLocaleString()}</td></tr>`
        );
      })
      .join('');
    el('dailyEmpty').hidden = daily.length > 0;

    // --- endpoints ---
    const eps = u.byEndpoint || [];
    el('endpointBody').innerHTML = eps
      .map(
        (e) =>
          `<tr><td><code>${escapeHtml(e.endpoint)}</code></td><td>${escapeHtml(e.provider)}</td>` +
          `<td>${escapeHtml(e.tier)}</td><td class="num-col">${e.calls.toLocaleString()}</td></tr>`,
      )
      .join('');
    el('endpointEmpty').hidden = eps.length > 0;

    const log = u.copyLog || {};
    el('foot').textContent =
      `${u.totals.today.toLocaleString()} requests today · ${u.totals.thisPeriod.toLocaleString()} this period · ` +
      `${u.totals.allTime.toLocaleString()} all time` +
      (log.trades
        ? ` · free trade log holds ${log.trades.toLocaleString()} trades across ${log.mints} token${log.mints === 1 ? '' : 's'}`
        : '');
  }

  function setMeter(node, percent) {
    const p = Math.max(0, Math.min(100, percent || 0));
    node.style.width = p + '%';
    node.className = p >= 90 ? 'is-hot' : p >= 70 ? 'is-warm' : '';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  refresh();
  setInterval(refresh, 20000);
})();
