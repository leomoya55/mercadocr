/**
 * perfil.js — public seller profiles + seller search.
 *
 * One page, two modes (driven by the query string):
 *   /perfil?u=<username>  → that seller's public profile + their active listings.
 *   /perfil?q=<term>      → search results (sellers matching the term).
 *   /perfil               → just the search box.
 *
 * Requires: config.js (escapeHtml, cldAuto, API_BASE_URL), ui.js (buildWaLink).
 */

var CONDITION_LABELS = {
  'new':      'Nuevo',
  'like_new': 'Como nuevo',
  'good':     'Buen estado',
  'fair':     'Estado regular',
  'regular':  'Para reparar',
};

document.addEventListener('DOMContentLoaded', function () {
  var sellerInput   = document.getElementById('seller-q');
  var sellerBtn     = document.getElementById('seller-search-btn');
  var resultsEl     = document.getElementById('perfil-results');
  var profileEl     = document.getElementById('perfil-profile');
  var headerEl      = document.getElementById('perfil-header');
  var listingsEl    = document.getElementById('perfil-listings');
  var listingsTitle = document.getElementById('perfil-listings-title');
  var statusEl      = document.getElementById('perfil-status');

  // ─── Listing card (matches the listings grid look) ──────────────────────────
  function buildCard(listing) {
    var isJob = listing.category === 'Empleos';
    var card = document.createElement('div');
    card.className = 'listing-item';
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', listing.name);
    card.dataset.id = listing._id;

    var featuredBadge = listing.featured ? '<span class="badge-featured">Destacado</span>' : '';
    var conditionBadge = listing.condition && CONDITION_LABELS[listing.condition]
      ? '<span class="badge-condition">' + CONDITION_LABELS[listing.condition] + '</span>'
      : '';

    var photo0 = (listing.photos && listing.photos[0]) ? cldAuto(listing.photos[0]) : '';
    var imgHtml = photo0
      ? '<img src="' + escapeHtml(photo0) + '" alt="' + escapeHtml(listing.name) +
        '" loading="lazy" width="400" height="200">'
      : '<div class="listing-noimg" aria-hidden="true">' + (isJob ? '💼' : '🛍️') + '</div>';

    var priceHtml = isJob
      ? '<div class="listing-item-price">' +
          escapeHtml(listing.job && listing.job.salary ? listing.job.salary : 'Empleo') + '</div>'
      : '<div class="listing-item-price">₡' + Number(listing.price).toLocaleString('es-CR') + '</div>';

    card.innerHTML =
      imgHtml +
      '<div class="listing-item-content">' +
        '<div class="listing-item-title">' + escapeHtml(listing.name) + '</div>' +
        (listing.subcategory
          ? '<div class="listing-item-subcat">' + escapeHtml(listing.subcategory) + '</div>'
          : '') +
        '<div class="listing-item-meta">' +
          priceHtml +
          '<div class="listing-item-badges">' + conditionBadge + featuredBadge + '</div>' +
        '</div>' +
        (listing.provincia
          ? '<div class="listing-item-location">📍 ' + escapeHtml(listing.provincia) + '</div>'
          : '') +
      '</div>';
    return card;
  }

  // Delegated navigation for listing cards.
  if (listingsEl) {
    listingsEl.addEventListener('click', function (e) {
      var card = e.target.closest('.listing-item[data-id]');
      if (card) window.location.href = '/product?id=' + card.dataset.id;
    });
    listingsEl.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var card = e.target.closest('.listing-item[data-id]');
      if (card) window.location.href = '/product?id=' + card.dataset.id;
    });
  }

  function displayName(p) {
    var full = ((p.nombre || '') + ' ' + (p.apellido || '')).trim();
    return full || ('@' + p.username);
  }

  function avatarLetter(p) {
    var n = (p.nombre || p.username || '?').trim();
    return n ? n.charAt(0).toUpperCase() : '?';
  }

  // Avatar markup: photo when available, else an initial-letter circle.
  function avatarHtml(p, sizeClass, px) {
    var cls = 'perfil-avatar' + (sizeClass ? ' ' + sizeClass : '');
    if (p.photoURL) {
      return '<div class="' + cls + ' has-photo" aria-hidden="true">' +
        '<img src="' + escapeHtml(cldAvatar(p.photoURL, px || 200)) + '" alt="" loading="lazy"></div>';
    }
    return '<div class="' + cls + '" aria-hidden="true">' + escapeHtml(avatarLetter(p)) + '</div>';
  }

  // ─── Render: single profile ─────────────────────────────────────────────────
  function renderProfile(data) {
    var p = data.profile;
    document.title = displayName(p) + ' - MercaTico';

    var proBadge = p.sellerPro
      ? ' <span class="badge-seller-pro" title="Vendedor Pro verificado">★ Vendedor Pro</span>'
      : '';
    var since = p.memberSince
      ? new Date(p.memberSince).toLocaleDateString('es-CR', { year: 'numeric', month: 'long' })
      : '';

    headerEl.innerHTML =
      avatarHtml(p, '', 200) +
      '<div class="perfil-meta">' +
        '<h2>' + escapeHtml(displayName(p)) + proBadge + '</h2>' +
        '<p class="perfil-username">@' + escapeHtml(p.username) + '</p>' +
        (p.provincia ? '<p class="perfil-prov">📍 ' + escapeHtml(p.provincia) + '</p>' : '') +
        (since ? '<p class="perfil-since">Miembro desde ' + escapeHtml(since) + '</p>' : '') +
      '</div>';

    var listings = data.listings || [];
    listingsTitle.textContent = listings.length
      ? 'Anuncios publicados (' + listings.length + ')'
      : 'Este vendedor no tiene anuncios activos.';

    listingsEl.innerHTML = '';
    var frag = document.createDocumentFragment();
    listings.forEach(function (l) { frag.appendChild(buildCard(l)); });
    listingsEl.appendChild(frag);

    profileEl.classList.remove('hidden');
    resultsEl.classList.add('hidden');
  }

  // ─── Render: search results ─────────────────────────────────────────────────
  function renderResults(term, users) {
    resultsEl.innerHTML = '';
    var h = document.createElement('h3');
    h.className = 'perfil-results-title';
    h.textContent = users.length
      ? 'Vendedores para "' + term + '"'
      : 'No se encontraron vendedores para "' + term + '".';
    resultsEl.appendChild(h);

    var list = document.createElement('div');
    list.className = 'perfil-seller-list';
    users.forEach(function (u) {
      var a = document.createElement('a');
      a.className = 'perfil-seller-card';
      a.href = '/perfil?u=' + encodeURIComponent(u.username);
      var proBadge = u.sellerPro
        ? ' <span class="badge-seller-pro" title="Vendedor Pro verificado">★ Pro</span>'
        : '';
      var name = ((u.nombre || '') + ' ' + (u.apellido || '')).trim() || ('@' + u.username);
      a.innerHTML =
        avatarHtml(u, 'sm', 96) +
        '<div class="perfil-seller-info">' +
          '<span class="perfil-seller-name">' + escapeHtml(name) + proBadge + '</span>' +
          '<span class="perfil-seller-handle">@' + escapeHtml(u.username) + '</span>' +
          '<span class="perfil-seller-count">' + u.listingCount + ' anuncio' +
            (u.listingCount === 1 ? '' : 's') + (u.provincia ? ' · ' + escapeHtml(u.provincia) : '') +
          '</span>' +
        '</div>';
      list.appendChild(a);
    });
    resultsEl.appendChild(list);

    resultsEl.classList.remove('hidden');
    profileEl.classList.add('hidden');
  }

  function showStatus(msg) {
    statusEl.textContent = msg || '';
  }

  // ─── Loaders ────────────────────────────────────────────────────────────────
  function loadProfile(username) {
    showStatus('Cargando perfil...');
    fetch(API_BASE_URL + '/api/users/u/' + encodeURIComponent(username))
      .then(function (r) {
        if (r.status === 404) throw new Error('not_found');
        if (!r.ok) throw new Error('http');
        return r.json();
      })
      .then(function (data) { showStatus(''); renderProfile(data); })
      .catch(function (err) {
        showStatus(err.message === 'not_found'
          ? 'No encontramos ningún vendedor con ese nombre de usuario.'
          : 'No se pudo cargar el perfil. Intentá de nuevo.');
      });
  }

  function loadSearch(term) {
    if (sellerInput) sellerInput.value = term;
    showStatus('Buscando...');
    fetch(API_BASE_URL + '/api/users/search?q=' + encodeURIComponent(term))
      .then(function (r) { return r.ok ? r.json() : { users: [] }; })
      .then(function (data) { showStatus(''); renderResults(term, data.users || []); })
      .catch(function () { showStatus('No se pudo realizar la búsqueda.'); });
  }

  // ─── Search box wiring ──────────────────────────────────────────────────────
  function submitSearch() {
    var term = (sellerInput ? sellerInput.value.trim() : '');
    if (term.length < 2) { showStatus('Escribí al menos 2 caracteres.'); return; }
    window.location.href = '/perfil?q=' + encodeURIComponent(term);
  }
  if (sellerBtn) sellerBtn.addEventListener('click', submitSearch);
  if (sellerInput) {
    sellerInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') submitSearch();
    });
  }

  // ─── Initial dispatch ───────────────────────────────────────────────────────
  var params = new URLSearchParams(window.location.search);
  var u = (params.get('u') || '').trim();
  var q = (params.get('q') || '').trim();
  if (u) {
    loadProfile(u);
  } else if (q) {
    loadSearch(q);
  } else {
    showStatus('Escribí el nombre de usuario o el nombre de un vendedor para buscarlo.');
  }
});
