/**
 * admin.js — MercadoCR admin panel
 *
 * Security model:
 *   - Frontend: only renders the panel when Firebase Auth user email === OWNER_EMAIL.
 *   - Backend: every /api/admin/* request independently re-checks isOwner(email).
 *   - Frontend hiding is a UX courtesy only. The backend is the authoritative gate.
 *
 * Requires: config.js (escapeHtml, API_BASE_URL), ui.js (Toast), auth-redirect.js (authFetch)
 */

(function () {
  'use strict';

  var OWNER_EMAIL = 'leomoyawr300@gmail.com';

  var guard   = document.getElementById('admin-guard');
  var content = document.getElementById('admin-content');

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
  document.querySelectorAll('.admin-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.admin-tab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.admin-panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      var panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.classList.add('active');

      // Lazy-load tab content on first activation
      if (btn.dataset.tab === 'users'   && !btn.dataset.loaded) { btn.dataset.loaded = '1'; loadUsers(1); }
      if (btn.dataset.tab === 'reports' && !btn.dataset.loaded) { btn.dataset.loaded = '1'; loadReports(1); }
    });
  });

  // ─── Stats ────────────────────────────────────────────────────────────────
  function loadStats() {
    authFetch(API_BASE_URL + '/api/admin/stats')
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

    var qs = 'page=' + page + '&limit=20';
    if (q)      qs += '&q='      + encodeURIComponent(q);
    if (status) qs += '&status=' + encodeURIComponent(status);
    if (hidden) qs += '&hidden=' + encodeURIComponent(hidden);

    var wrap = document.getElementById('admin-listings-table');
    if (wrap) wrap.innerHTML = '<p class="admin-loading">Cargando...</p>';

    authFetch(API_BASE_URL + '/api/admin/listings?' + qs)
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

  document.getElementById('admin-listing-search') &&
    document.getElementById('admin-listing-search').addEventListener('click', function () { loadListings(1); });

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
      var hiddenBadge   = l.hidden   ? '<span class="badge-hidden">Oculto</span>'     : '';
      var featuredBadge = l.featured ? '<span class="badge-featured">Destacado</span>' : '';
      html +=
        '<tr data-id="' + escapeHtml(l._id) + '">' +
        '<td><a href="/product?id=' + escapeHtml(l._id) + '" target="_blank" rel="noopener noreferrer" style="color:#e8c97a">' +
          escapeHtml(l.name) + '</a></td>' +
        '<td>₡' + Number(l.price).toLocaleString('es-CR') + '</td>' +
        '<td>' + escapeHtml(l.category) + '</td>' +
        '<td>' + escapeHtml(l.status) + '</td>' +
        '<td>' + hiddenBadge   + (l.hidden   ? '' : '—') + '</td>' +
        '<td>' + featuredBadge + (l.featured ? '' : '—') + '</td>' +
        '<td>' + (l.views || 0) + '</td>' +
        '<td class="admin-actions">' +
          '<button class="btn-sm" data-action="' + (l.hidden ? 'unhide' : 'hide') + '" data-id="' + escapeHtml(l._id) + '">' +
            (l.hidden ? 'Mostrar' : 'Ocultar') +
          '</button>' +
          '<button class="btn-sm" data-action="' + (l.featured ? 'unfeature' : 'feature') + '" data-id="' + escapeHtml(l._id) + '">' +
            (l.featured ? 'Quitar dest.' : 'Destacar') +
          '</button>' +
          '<button class="btn-sm btn-danger" data-action="delete" data-id="' + escapeHtml(l._id) + '">Eliminar</button>' +
        '</td></tr>';
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;

    // Delegated action handlers
    wrap.addEventListener('click', function (e) {
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
      if (action === 'delete') {
        if (!confirm('¿Eliminar este anuncio definitivamente?')) return;
        adminDelete('/api/admin/listings/' + id, function () {
          Toast.success('Anuncio eliminado.');
          loadStats();
          loadListings(listingsPage);
        });
      }
    }, { once: false });
  }

  // ─── Users ────────────────────────────────────────────────────────────────
  var usersPage = 1;

  function loadUsers(page) {
    usersPage = page;
    var wrap = document.getElementById('admin-users-table');
    if (wrap) wrap.innerHTML = '<p class="admin-loading">Cargando...</p>';

    authFetch(API_BASE_URL + '/api/admin/users?page=' + page + '&limit=20')
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

  function renderUsersTable(users) {
    var wrap = document.getElementById('admin-users-table');
    if (!wrap) return;
    if (!users.length) { wrap.innerHTML = '<p class="admin-loading">Sin usuarios.</p>'; return; }

    var html = '<table class="admin-table"><thead><tr>' +
      '<th>Nombre</th><th>Email</th><th>Plan</th><th>Provincia</th><th>Créditos</th><th>Registrado</th>' +
      '</tr></thead><tbody>';

    users.forEach(function (u) {
      var name = (u.nombre || '') + ' ' + (u.apellido || '');
      html +=
        '<tr>' +
        '<td>' + escapeHtml(name.trim() || '—') + '</td>' +
        '<td>' + escapeHtml(u.email || '—') + '</td>' +
        '<td><span class="badge-plan badge-plan-' + escapeHtml(u.plan || 'free') + '">' + escapeHtml(u.plan || 'free') + '</span></td>' +
        '<td>' + escapeHtml(u.provincia || '—') + '</td>' +
        '<td>' + (u.singlePostCredits || 0) + '</td>' +
        '<td>' + (u.createdAt ? new Date(u.createdAt).toLocaleDateString('es-CR') : '—') + '</td>' +
        '</tr>';
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;
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
        '<tr data-report-id="' + escapeHtml(r._id) + '">' +
        '<td>' +
          (listingId
            ? '<a href="/product?id=' + escapeHtml(listingId) + '" target="_blank" rel="noopener noreferrer" style="color:#e8c97a">' + escapeHtml(listingName) + '</a>'
            : escapeHtml(listingName)) +
        '</td>' +
        '<td>' + escapeHtml(REASON_LABELS[r.reason] || r.reason) + '</td>' +
        '<td><span class="badge-report-status badge-report-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + '</span></td>' +
        '<td>' + new Date(r.createdAt).toLocaleDateString('es-CR') + '</td>' +
        '<td class="admin-actions">' +
          (r.status === 'pending'
            ? '<button class="btn-sm" data-action="reviewed" data-id="' + escapeHtml(r._id) + '">Revisar</button>' +
              '<button class="btn-sm" data-action="dismissed" data-id="' + escapeHtml(r._id) + '">Descartar</button>' +
              '<button class="btn-sm btn-danger" data-action="actioned" data-id="' + escapeHtml(r._id) + '">Con acción</button>'
            : '—') +
        '</td></tr>';
    });

    html += '</tbody></table>';
    wrap.innerHTML = html;

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var action = btn.dataset.action;
      var id     = btn.dataset.id;
      adminPost('/api/admin/reports/' + id + '/' + action, {}, function () {
        Toast.success('Reporte actualizado.');
        loadStats();
        loadReports(reportsPage);
      });
    }, { once: false });
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

  // Logout link
  var logoutBtn = document.getElementById('nav-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', function () {
      auth.signOut().then(function () { window.location.href = '/login'; });
    });
  }
}());
