/**
 * admin.js — MercaTico admin panel
 *
 * Security model:
 *   - Frontend: only renders the panel when Firebase Auth user email === OWNER_EMAIL.
 *   - Backend: every /api/admin/* request independently re-checks isOwner(email).
 *   - Frontend hiding is UX only. The backend is the authoritative gate.
 *
 * Requires: config.js (escapeHtml, API_BASE_URL), ui.js (Toast), auth-redirect.js (authFetch)
 */

(function () {
  'use strict';

  var OWNER_EMAIL = 'leomoyawr300@gmail.com';

  var guard   = document.getElementById('admin-guard');
  var content = document.getElementById('admin-content');

  // Attach a listener to a PERSISTENT element only once. The table wrappers
  // survive re-renders (only their innerHTML changes), so calling
  // addEventListener on every render stacked duplicate handlers — a single
  // click then fired N delete requests; the extra ones hit an already-deleted
  // item (404), producing a success toast AND an error toast at the same time.
  function wireOnce(el, evt, fn) {
    var k = '_wired_' + evt;
    if (el[k]) return;
    el[k] = true;
    el.addEventListener(evt, fn);
  }

  // ─── Auth gate ────────────────────────────────────────────────────────────
  auth.onAuthStateChanged(function (user) {
    if (!user) { window.location.href = '/login'; return; }
    if (user.email !== OWNER_EMAIL) {
      if (guard)   guard.classList.remove('hidden');
      if (content) content.classList.add('hidden');
      return;
    }
    if (content) content.classList.remove('hidden');
    loadStats();
    loadListings(1);
  });

  // ─── Tab switching ────────────────────────────────────────────────────────
  function switchToTab(tabName) {
    document.querySelectorAll('.admin-tab').forEach(function (b) { b.classList.remove('active'); });
    document.querySelectorAll('.admin-panel').forEach(function (p) { p.classList.remove('active'); });

    var btn   = document.querySelector('.admin-tab[data-tab="' + tabName + '"]');
    var panel = document.getElementById('tab-' + tabName);
    if (btn)   btn.classList.add('active');
    if (panel) panel.classList.add('active');

    // Mark as loaded so lazy-init knows it already ran
    if (btn) btn.dataset.loaded = '1';
  }

  document.querySelectorAll('.admin-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchToTab(btn.dataset.tab);
      if (btn.dataset.tab === 'users'   && !btn.dataset.loaded) { loadUsers(1); }
      if (btn.dataset.tab === 'reports' && !btn.dataset.loaded) { loadReports(1); }
      if (btn.dataset.tab === 'boosts') { loadBoosts(); } // light list — refresh each open
      btn.dataset.loaded = '1';
    });
  });

  // ─── Stat card click → jump to tab with pre-applied filter ───────────────
  document.querySelectorAll('.stat-card[data-goto]').forEach(function (card) {
    function activate() {
      var tab    = card.dataset.goto;
      var status = card.dataset.gotoStatus || '';
      var hidden = card.dataset.gotoHidden || '';
      var plan   = card.dataset.gotoPlan   || '';

      switchToTab(tab);

      if (tab === 'listings') {
        var sq = document.getElementById('admin-listing-q');
        var ss = document.getElementById('admin-listing-status');
        var sh = document.getElementById('admin-listing-hidden');
        var sa = document.getElementById('admin-listing-author');
        if (sq) sq.value = '';
        if (ss) ss.value = status;
        if (sh) sh.value = hidden;
        if (sa) { sa.value = ''; clearAuthorLabel(); }
        loadListings(1);
      }

      if (tab === 'users') {
        var uq = document.getElementById('admin-user-q');
        var up = document.getElementById('admin-user-plan');
        if (uq) uq.value = '';
        if (up) up.value = plan;
        loadUsers(1);
      }

      if (tab === 'reports') {
        var rs = document.getElementById('admin-report-status');
        if (rs) rs.value = status;
        loadReports(1);
      }
    }

    card.addEventListener('click', activate);
    card.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────────
  function loadStats() {
    authFetch(API_BASE_URL + '/api/admin/stats', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        setText('stat-listings-active',  d.listings && d.listings.active);
        setText('stat-listings-hidden',  d.listings && d.listings.hidden);
        setText('stat-users-total',      d.users    && d.users.total);
        setText('stat-users-pro',        d.users    && d.users.pro);
        setText('stat-reports-pending',  d.reports  && d.reports.pending);
      })
      .catch(function (err) { console.error('[admin stats]', err); });
  }

  function setText(id, val) {
    var el = document.getElementById(id);
    if (el) el.textContent = (val != null ? val : '—');
  }

  // ─── Listings ─────────────────────────────────────────────────────────────
  var listingsPage = 1;

  function loadListings(page) {
    listingsPage = page;
    var q      = (document.getElementById('admin-listing-q')      || {}).value || '';
    var status = (document.getElementById('admin-listing-status') || {}).value || '';
    var hidden = (document.getElementById('admin-listing-hidden') || {}).value || '';
    var author = (document.getElementById('admin-listing-author') || {}).value || '';

    var qs = 'page=' + page + '&limit=20';
    if (q)      qs += '&q='      + encodeURIComponent(q);
    if (status) qs += '&status=' + encodeURIComponent(status);
    if (hidden) qs += '&hidden=' + encodeURIComponent(hidden);
    if (author) qs += '&author=' + encodeURIComponent(author);

    var wrap = document.getElementById('admin-listings-table');
    if (wrap) wrap.innerHTML = '<p class="admin-loading">Cargando...</p>';

    authFetch(API_BASE_URL + '/api/admin/listings?' + qs, { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        renderListingsTable(d.listings || []);
        renderPagination('admin-listings-pages', d.pagination, loadListings);
      })
      .catch(function (err) {
        console.error('[admin listings]', err);
        if (wrap) wrap.innerHTML = '<p class="admin-loading">Error al cargar.</p>';
      });
  }

  function clearAuthorLabel() {
    var lbl = document.getElementById('admin-listing-author-label');
    if (lbl) { lbl.textContent = ''; lbl.classList.add('hidden'); }
  }

  function setAuthorLabel(name) {
    var lbl = document.getElementById('admin-listing-author-label');
    if (!lbl) return;
    lbl.textContent = 'Filtrando por usuario: ' + name + ' ';
    lbl.classList.remove('hidden');
    // Add a clear button
    var x = document.createElement('button');
    x.textContent = '✕ Limpiar filtro';
    x.className = 'btn-sm';
    x.style.marginLeft = '0.5rem';
    x.addEventListener('click', function () {
      var sa = document.getElementById('admin-listing-author');
      if (sa) sa.value = '';
      clearAuthorLabel();
      loadListings(1);
    });
    lbl.appendChild(x);
  }

  document.getElementById('admin-listing-search') &&
    document.getElementById('admin-listing-search').addEventListener('click', function () { loadListings(1); });

  document.getElementById('admin-listing-reset') &&
    document.getElementById('admin-listing-reset').addEventListener('click', function () {
      var q = document.getElementById('admin-listing-q');       if (q) q.value = '';
      var s = document.getElementById('admin-listing-status');  if (s) s.value = '';
      var h = document.getElementById('admin-listing-hidden');  if (h) h.value = '';
      var a = document.getElementById('admin-listing-author');  if (a) a.value = '';
      clearAuthorLabel();
      loadListings(1);
    });

  // Enter key on listing search input
  var lq = document.getElementById('admin-listing-q');
  if (lq) lq.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadListings(1); });

  function renderListingsTable(listings) {
    var wrap = document.getElementById('admin-listings-table');
    if (!wrap) return;
    if (!listings.length) {
      wrap.innerHTML = '<p class="admin-loading">Sin resultados.</p>';
      return;
    }

    var html = '<table class="admin-table"><thead><tr>' +
      '<th>Nombre</th><th>Precio</th><th>Categoría</th><th>Estado</th><th>Oculto</th><th>Destacado</th><th>Vistas</th><th>Acciones</th>' +
      '</tr></thead><tbody>';

    listings.forEach(function (l) {
      var hiddenBadge   = l.hidden   ? '<span class="badge-hidden">Oculto</span>'      : '—';
      var featuredBadge = l.featured ? '<span class="badge-featured">Destacado</span>' : '—';
      html +=
        '<tr>' +
        '<td><a href="/product?id=' + escapeHtml(l._id) + '" target="_blank" rel="noopener noreferrer" class="admin-link">' +
          escapeHtml(l.name) + '</a></td>' +
        '<td>₡' + Number(l.price).toLocaleString('es-CR') + '</td>' +
        '<td>' + escapeHtml(l.category) + '</td>' +
        '<td>' + escapeHtml(l.status) + '</td>' +
        '<td>' + hiddenBadge   + '</td>' +
        '<td>' + featuredBadge + '</td>' +
        '<td>' + (l.views || 0) + '</td>' +
        '<td class="admin-actions">' +
          '<button class="btn-sm" data-action="' + (l.hidden ? 'unhide' : 'hide') + '" data-id="' + escapeHtml(l._id) + '">' +
            (l.hidden ? 'Mostrar' : 'Ocultar') +
          '</button>' +
          '<button class="btn-sm" data-action="' + (l.featured ? 'unfeature' : 'feature') + '" data-id="' + escapeHtml(l._id) + '">' +
            (l.featured ? 'Quitar dest.' : 'Destacar') +
          '</button>' +
          '<button class="btn-sm btn-danger" data-action="delete-listing" data-id="' + escapeHtml(l._id) + '">Eliminar</button>' +
        '</td></tr>';
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;

    wireOnce(wrap,'click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var id     = btn.dataset.id;

      if (action === 'hide' || action === 'unhide') {
        adminPost('/api/admin/listings/' + id + '/' + action, {}, function () {
          Toast.success(action === 'hide' ? 'Anuncio ocultado.' : 'Anuncio visible.');
          loadStats();
          loadListings(listingsPage);
        });
      }
      if (action === 'feature' || action === 'unfeature') {
        adminPost('/api/admin/listings/' + id + '/feature',
          { featured: action === 'feature' },
          function () {
            Toast.success(action === 'feature' ? 'Anuncio destacado.' : 'Destacado eliminado.');
            loadListings(listingsPage);
          }
        );
      }
      if (action === 'delete-listing') {
        Modal.confirm({
          title: 'Eliminar anuncio',
          message: 'Se eliminará este anuncio definitivamente. Esta acción no se puede deshacer.',
          confirmText: 'Eliminar',
          cancelText: 'Cancelar',
          danger: true,
        }).then(function (ok) {
          if (!ok) return;
          adminDelete('/api/admin/listings/' + id, function () {
            Toast.success('Anuncio eliminado.');
            loadStats();
            loadListings(listingsPage);
          });
        });
      }
    });
  }

  // ─── Boosts (active featured listings) ──────────────────────────────────────
  function loadBoosts() {
    var wrap = document.getElementById('admin-boosts-table');
    if (wrap) wrap.innerHTML = '<p class="admin-loading">Cargando...</p>';
    authFetch(API_BASE_URL + '/api/admin/boosts', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) { renderBoostsTable(d.boosts || [], d.now); })
      .catch(function (err) {
        console.error('[admin boosts]', err);
        if (wrap) wrap.innerHTML = '<p class="admin-loading">Error al cargar.</p>';
      });
  }

  function fmtBoostRemaining(until, now) {
    if (!until) return 'Editorial (sin vencimiento)';
    var ms = new Date(until).getTime() - new Date(now || Date.now()).getTime();
    if (ms <= 0) return 'Expirado';
    var hours = Math.floor(ms / 3600000);
    if (hours >= 24) return Math.floor(hours / 24) + ' día(s)';
    if (hours >= 1)  return hours + ' h';
    return Math.max(1, Math.floor(ms / 60000)) + ' min';
  }

  function renderBoostsTable(boosts, now) {
    var wrap = document.getElementById('admin-boosts-table');
    if (!wrap) return;
    if (!boosts.length) {
      wrap.innerHTML = '<p class="admin-loading">No hay destacados activos.</p>';
      return;
    }
    var rows = boosts.map(function (b) {
      var type = b.boostType ? b.boostType : (b.featuredUntil ? '—' : 'editorial');
      return '<tr>' +
        '<td>' + escapeHtml(b.name || '') + '</td>' +
        '<td>' + escapeHtml(b.category || '') + '</td>' +
        '<td>' + escapeHtml(type) + '</td>' +
        '<td>' + escapeHtml(fmtBoostRemaining(b.featuredUntil, now)) + '</td>' +
        '<td><button class="btn-sm" data-boost-remove="' + escapeHtml(String(b._id)) + '">Quitar</button></td>' +
        '</tr>';
    }).join('');
    wrap.innerHTML = '<table class="admin-table"><thead><tr>' +
      '<th>Anuncio</th><th>Categoría</th><th>Tipo</th><th>Restante</th><th></th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    wireOnce(wrap, 'click', function (e) {
      var btn = e.target.closest('[data-boost-remove]');
      if (!btn) return;
      adminPost('/api/admin/listings/' + btn.dataset.boostRemove + '/feature',
        { featured: false },
        function () { Toast.success('Destacado eliminado.'); loadBoosts(); });
    });
  }

  var boostsRefreshBtn = document.getElementById('admin-boosts-refresh');
  if (boostsRefreshBtn) boostsRefreshBtn.addEventListener('click', loadBoosts);

  // ─── Users ────────────────────────────────────────────────────────────────
  var usersPage = 1;

  function loadUsers(page) {
    usersPage = page;
    var q    = (document.getElementById('admin-user-q')    || {}).value || '';
    var plan = (document.getElementById('admin-user-plan') || {}).value || '';

    var qs = 'page=' + page + '&limit=20';
    if (q)    qs += '&q='    + encodeURIComponent(q);
    if (plan) qs += '&plan=' + encodeURIComponent(plan);

    var wrap = document.getElementById('admin-users-table');
    if (wrap) wrap.innerHTML = '<p class="admin-loading">Cargando...</p>';

    authFetch(API_BASE_URL + '/api/admin/users?' + qs)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        renderUsersTable(d.users || []);
        renderPagination('admin-users-pages', d.pagination, loadUsers);
      })
      .catch(function (err) {
        console.error('[admin users]', err);
        if (wrap) wrap.innerHTML = '<p class="admin-loading">Error al cargar.</p>';
      });
  }

  document.getElementById('admin-user-search') &&
    document.getElementById('admin-user-search').addEventListener('click', function () { loadUsers(1); });

  document.getElementById('admin-user-reset') &&
    document.getElementById('admin-user-reset').addEventListener('click', function () {
      var q = document.getElementById('admin-user-q');    if (q) q.value = '';
      var p = document.getElementById('admin-user-plan'); if (p) p.value = '';
      loadUsers(1);
    });

  var uq = document.getElementById('admin-user-q');
  if (uq) uq.addEventListener('keydown', function (e) { if (e.key === 'Enter') loadUsers(1); });

  function renderUsersTable(users) {
    var wrap = document.getElementById('admin-users-table');
    if (!wrap) return;
    if (!users.length) { wrap.innerHTML = '<p class="admin-loading">Sin usuarios.</p>'; return; }

    var html = '<table class="admin-table"><thead><tr>' +
      '<th>Nombre</th><th>Email</th><th>Plan</th><th>Créditos</th><th>Referidos</th><th>Referido por</th><th>Provincia</th><th>Registrado</th><th>Acciones</th>' +
      '</tr></thead><tbody>';

    users.forEach(function (u) {
      var name = ((u.nombre || '') + ' ' + (u.apellido || '')).trim() || '—';
      var uid  = escapeHtml(u.firebaseUid || '');

      // "Referido por": resolved by the server into { username, name }.
      var refBy = '—';
      if (u.referredByInfo) {
        var refName = (u.referredByInfo.name || u.referredByInfo.username || '').trim();
        refBy = u.referredByInfo.username
          ? '<a href="/perfil?u=' + escapeHtml(u.referredByInfo.username) + '" target="_blank" rel="noopener noreferrer" class="admin-link">' +
              escapeHtml(refName || u.referredByInfo.username) + '</a>'
          : escapeHtml(refName || '—');
      }

      html +=
        '<tr>' +
        '<td>' + escapeHtml(name) + '</td>' +
        '<td style="font-size:0.8rem;color:#aaa;">' + escapeHtml(u.email || '—') + '</td>' +
        '<td>' +
          '<select class="plan-select-inline" data-action="change-plan" data-uid="' + uid + '" data-current="' + escapeHtml(u.plan || 'free') + '">' +
            '<option value="free"'  + (u.plan === 'free'  ? ' selected' : '') + '>Gratis</option>' +
            '<option value="basic"' + (u.plan === 'basic' ? ' selected' : '') + '>Basic</option>' +
            '<option value="pro"'   + (u.plan === 'pro'   ? ' selected' : '') + '>Pro</option>' +
          '</select>' +
          (u.compedPlan && u.plan !== 'free'
            ? ' <span class="plan-comp-badge" title="Plan de cortesía otorgado por admin — no expira">Cortesía</span>'
            : '') +
        '</td>' +
        '<td>' +
          '<span class="credits-val">' + (u.singlePostCredits || 0) + '</span>' +
          ' <button class="btn-sm" data-action="add-credit" data-uid="' + uid + '" title="Agregar 1 crédito">+</button>' +
          ' <button class="btn-sm" data-action="remove-credit" data-uid="' + uid + '" title="Quitar 1 crédito">−</button>' +
        '</td>' +
        '<td style="text-align:center;font-weight:700;">' + (u.referralCount || 0) + '</td>' +
        '<td style="font-size:0.8rem;">' + refBy + '</td>' +
        '<td>' + escapeHtml(u.provincia || '—') + '</td>' +
        '<td style="font-size:0.8rem;">' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('es-CR') : '—') + '</td>' +
        '<td class="admin-actions">' +
          '<button class="btn-sm" data-action="view-listings" data-uid="' + uid + '" data-name="' + escapeHtml(name) + '">Ver anuncios</button>' +
        '</td></tr>';
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;

    // Delegated: plan change (select → change event)
    wireOnce(wrap,'change', function (e) {
      var sel = e.target.closest('.plan-select-inline');
      if (!sel) return;
      var newPlan  = sel.value;
      var uid      = sel.dataset.uid;
      var previous = sel.dataset.current;

      Modal.confirm({
        title: 'Cambiar plan',
        message: '¿Cambiar el plan de este usuario a "' + newPlan + '"?',
        confirmText: 'Cambiar',
        cancelText: 'Cancelar',
      }).then(function (ok) {
        if (!ok) { sel.value = previous; return; } // revert on cancel
        adminPost('/api/admin/users/' + uid + '/plan', { plan: newPlan }, function () {
          sel.dataset.current = newPlan;
          Toast.success('Plan actualizado a ' + newPlan + '.');
          loadStats();
        });
      });
    });

    // Delegated: button actions
    wireOnce(wrap,'click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var uid    = btn.dataset.uid;

      if (action === 'add-credit' || action === 'remove-credit') {
        var delta = action === 'add-credit' ? 1 : -1;
        adminPost('/api/admin/users/' + uid + '/credits', { delta: delta }, function (d) {
          // Update the displayed credits value in the same row
          var row = btn.closest('tr');
          var cv  = row && row.querySelector('.credits-val');
          if (cv && d.credits != null) cv.textContent = d.credits;
          Toast.success(delta > 0 ? 'Crédito agregado.' : 'Crédito eliminado.');
        });
      }

      if (action === 'view-listings') {
        var name = btn.dataset.name || uid;
        switchToTab('listings');
        var authorInput = document.getElementById('admin-listing-author');
        if (authorInput) authorInput.value = uid;
        setAuthorLabel(name);
        // Clear other filters so only this user's listings show
        var q = document.getElementById('admin-listing-q');       if (q) q.value = '';
        var s = document.getElementById('admin-listing-status');  if (s) s.value = '';
        var h = document.getElementById('admin-listing-hidden');  if (h) h.value = '';
        loadListings(1);
      }
    });
  }

  // ─── Reports ──────────────────────────────────────────────────────────────
  var reportsPage = 1;

  function loadReports(page) {
    reportsPage = page;
    var status = (document.getElementById('admin-report-status') || {}).value || '';
    var wrap   = document.getElementById('admin-reports-table');
    if (wrap) wrap.innerHTML = '<p class="admin-loading">Cargando...</p>';

    var qs = 'page=' + page + '&limit=20';
    if (status) qs += '&status=' + encodeURIComponent(status);

    authFetch(API_BASE_URL + '/api/admin/reports?' + qs)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        renderReportsTable(d.reports || []);
        renderPagination('admin-reports-pages', d.pagination, loadReports);
      })
      .catch(function (err) {
        console.error('[admin reports]', err);
        if (wrap) wrap.innerHTML = '<p class="admin-loading">Error al cargar.</p>';
      });
  }

  document.getElementById('admin-report-search') &&
    document.getElementById('admin-report-search').addEventListener('click', function () { loadReports(1); });

  var REASON_LABELS = {
    spam: 'Spam', scam: 'Estafa', inappropriate: 'Inapropiado',
    wrong_category: 'Cat. incorrecta', duplicate: 'Duplicado', other: 'Otro',
  };

  function renderReportsTable(reports) {
    var wrap = document.getElementById('admin-reports-table');
    if (!wrap) return;
    if (!reports.length) { wrap.innerHTML = '<p class="admin-loading">Sin reportes.</p>'; return; }

    var html = '<table class="admin-table"><thead><tr>' +
      '<th>Anuncio</th><th>Motivo</th><th>Estado</th><th>Fecha</th><th>Acciones</th>' +
      '</tr></thead><tbody>';

    reports.forEach(function (r) {
      var listingName = r.listingId ? (r.listingId.name || '—') : '(eliminado)';
      var listingId   = r.listingId ? r.listingId._id : null;
      html +=
        '<tr>' +
        '<td>' +
          (listingId
            ? '<a href="/product?id=' + escapeHtml(listingId) + '" target="_blank" rel="noopener noreferrer" class="admin-link">' + escapeHtml(listingName) + '</a>'
            : escapeHtml(listingName)) +
        '</td>' +
        '<td>' + escapeHtml(REASON_LABELS[r.reason] || r.reason) + '</td>' +
        '<td><span class="badge-report-status badge-report-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</span></td>' +
        '<td style="font-size:0.8rem;">' + new Date(r.createdAt).toLocaleDateString('es-CR') + '</td>' +
        '<td class="admin-actions">' +
          (r.status === 'pending'
            ? '<button class="btn-sm" data-action="reviewed" data-id="' + escapeHtml(r._id) + '">Revisar</button>' +
              '<button class="btn-sm" data-action="dismissed" data-id="' + escapeHtml(r._id) + '">Descartar</button>' +
              '<button class="btn-sm btn-danger" data-action="actioned" data-id="' + escapeHtml(r._id) + '">Actuar</button>'
            : '—') +
        '</td></tr>';
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;

    wireOnce(wrap,'click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      adminPost('/api/admin/reports/' + btn.dataset.id + '/' + btn.dataset.action, {}, function () {
        Toast.success('Reporte actualizado.');
        loadStats();
        loadReports(reportsPage);
      });
    });
  }

  // ─── Pagination ───────────────────────────────────────────────────────────
  function renderPagination(containerId, pagination, loadFn) {
    var el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '';
    if (!pagination || pagination.pages <= 1) return;

    var p = pagination.page;
    var t = pagination.pages;

    function makeBtn(label, page, disabled, active) {
      var btn = document.createElement('button');
      btn.textContent = label;
      btn.className   = 'page-btn' + (active ? ' page-btn-active' : '');
      btn.disabled    = disabled;
      btn.addEventListener('click', function () { loadFn(page); });
      return btn;
    }

    el.appendChild(makeBtn('‹', p - 1, p <= 1, false));
    var start = Math.max(1, p - 2);
    var end   = Math.min(t, p + 2);
    for (var i = start; i <= end; i++) {
      el.appendChild(makeBtn(String(i), i, false, i === p));
    }
    el.appendChild(makeBtn('›', p + 1, p >= t, false));
  }

  // ─── API helpers ──────────────────────────────────────────────────────────
  function adminPost(path, body, onSuccess) {
    authFetch(API_BASE_URL + path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(onSuccess)
    .catch(function (err) {
      console.error('[adminPost]', err);
      Toast.error('Error al ejecutar la acción.');
    });
  }

  function adminDelete(path, onSuccess) {
    authFetch(API_BASE_URL + path, { method: 'DELETE' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(onSuccess)
    .catch(function (err) {
      console.error('[adminDelete]', err);
      Toast.error('Error al eliminar.');
    });
  }

  // Logout
  var logoutBtn = document.getElementById('nav-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      auth.signOut().then(function () { window.location.href = '/login'; });
    });
  }
}());
