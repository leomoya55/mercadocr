/**
 * listings.js — public listings grid with server-side search, filter, and pagination.
 *
 * Architecture:
 *   - All filtering is done on the server (GET /api/listings?q=&category=&...).
 *   - Client holds NO local copy of all listings — page state is in `currentParams`.
 *   - Cards are <div role="link"> with ONE delegated click+keydown listener on the container.
 *   - Zero inline onclick handlers anywhere.
 *   - buildWaLink() is sourced from ui.js.
 *
 * Requires: config.js (escapeHtml, API_BASE_URL), ui.js (buildWaLink, Toast).
 */

// Compact WhatsApp SVG — same path used across the site
var _WA_ICON_SM =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
  '<path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15' +
  '-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475' +
  '-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52' +
  '.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207' +
  '-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372' +
  '-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2' +
  ' 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719' +
  ' 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347' +
  'm-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374' +
  'a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898' +
  'a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884' +
  'm8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892' +
  'c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005' +
  'c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>' +
  '</svg>';

var CONDITION_LABELS = {
  'new':      'Nuevo',
  'like_new': 'Como nuevo',
  'good':     'Buen estado',
  'fair':     'Estado regular',
  'regular':  'Para reparar',
};

document.addEventListener('DOMContentLoaded', function () {
  var listingsContainer = document.getElementById('listings-container');
  var listingsCount     = document.getElementById('listings-count');
  var paginationEl      = document.getElementById('listings-pagination');
  if (!listingsContainer) return;

  // ─── Current query state ──────────────────────────────────────────────────
  var currentParams = {
    q:         '',
    category:  '',
    condition: '',
    provincia: '',
    minPrice:  '',
    maxPrice:  '',
    sort:      'newest',
    page:      1,
  };

  // ─── Delegated event handling ─────────────────────────────────────────────
  // Single listener handles card navigation; WA <a> tags are native links.
  listingsContainer.addEventListener('click', function (e) {
    if (e.target.closest('.listing-wa-btn')) return; // let native <a> handle
    var card = e.target.closest('.listing-item[data-id]');
    if (card) window.location.href = '/product?id=' + card.dataset.id;
  });

  listingsContainer.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (e.target.closest('.listing-wa-btn')) return;
    var card = e.target.closest('.listing-item[data-id]');
    if (card) window.location.href = '/product?id=' + card.dataset.id;
  });

  // ─── Card builder ─────────────────────────────────────────────────────────
  function buildCard(listing) {
    var isJob = listing.category === 'Empleos';
    var card = document.createElement('div');
    card.className = 'listing-item';
    card.setAttribute('role', 'link');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', listing.name);
    card.dataset.id = listing._id;

    var featuredBadge = listing.featured
      ? '<span class="badge-featured">Destacado</span>'
      : '';

    var conditionBadge = listing.condition && CONDITION_LABELS[listing.condition]
      ? '<span class="badge-condition">' + CONDITION_LABELS[listing.condition] + '</span>'
      : '';

    // Jobs are contacted via the product page (email/link), not WhatsApp.
    var waLink = (!isJob && typeof buildWaLink === 'function') ? buildWaLink(listing.contact) : null;
    var waBtn  = waLink
      ? '<a href="' + waLink + '"' +
          ' class="listing-wa-btn"' +
          ' target="_blank"' +
          ' rel="noopener noreferrer"' +
          ' aria-label="Contactar al vendedor por WhatsApp">' +
          _WA_ICON_SM + '<span>Contactar</span>' +
        '</a>'
      : '';

    // Image, or a placeholder when there is none (jobs may have no photo).
    var photo0 = (listing.photos && listing.photos[0]) ? cldAuto(listing.photos[0]) : '';
    var imgHtml = photo0
      ? '<img src="' + escapeHtml(photo0) + '" alt="' + escapeHtml(listing.name) +
        '" loading="lazy" width="400" height="200">'
      : '<div class="listing-noimg" aria-hidden="true">' + (isJob ? '💼' : '🛍️') + '</div>';

    // Price for products; salary (or "Empleo") for jobs.
    var priceHtml = isJob
      ? '<div class="listing-item-price">' +
          escapeHtml(listing.job && listing.job.salary ? listing.job.salary : 'Empleo') +
        '</div>'
      : '<div class="listing-item-price">₡' + Number(listing.price).toLocaleString('es-CR') + '</div>';

    card.innerHTML =
      imgHtml +
      '<div class="listing-item-content">' +
        '<div class="listing-item-title">' + escapeHtml(listing.name) + '</div>' +
        '<div class="listing-item-meta">' +
          priceHtml +
          '<div class="listing-item-badges">' + conditionBadge + featuredBadge + waBtn + '</div>' +
        '</div>' +
        (listing.provincia
          ? '<div class="listing-item-location">📍 ' + escapeHtml(listing.provincia) + '</div>'
          : '') +
      '</div>';

    return card;
  }

  // ─── Renderer ─────────────────────────────────────────────────────────────
  function renderListings(listings) {
    listingsContainer.innerHTML = '';
    if (!listings.length) {
      var empty = document.createElement('p');
      empty.style.cssText = 'color:#888;padding:2rem 0;text-align:center;';
      empty.textContent = 'No se encontraron anuncios.';
      listingsContainer.appendChild(empty);
      return;
    }
    var frag = document.createDocumentFragment();
    listings.forEach(function (l) { frag.appendChild(buildCard(l)); });
    listingsContainer.appendChild(frag);
  }

  // ─── Pagination ───────────────────────────────────────────────────────────
  function renderPagination(pagination) {
    if (!paginationEl) return;
    paginationEl.innerHTML = '';
    if (!pagination || pagination.pages <= 1) return;

    function makeBtn(label, page, disabled, active) {
      var btn = document.createElement('button');
      btn.textContent = label;
      btn.className   = 'page-btn' + (active ? ' page-btn-active' : '');
      btn.disabled    = disabled;
      btn.setAttribute('aria-current', active ? 'page' : 'false');
      btn.addEventListener('click', function () {
        currentParams.page = page;
        fetchAndRender();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      return btn;
    }

    var p = pagination.page;
    var t = pagination.pages;
    paginationEl.appendChild(makeBtn('‹', p - 1, p <= 1, false));

    // Show at most 5 page buttons around the current page
    var start = Math.max(1, p - 2);
    var end   = Math.min(t, p + 2);
    for (var i = start; i <= end; i++) {
      paginationEl.appendChild(makeBtn(String(i), i, false, i === p));
    }

    paginationEl.appendChild(makeBtn('›', p + 1, p >= t, false));
  }

  // ─── Count label ─────────────────────────────────────────────────────────
  function renderCount(pagination) {
    if (!listingsCount || !pagination) return;
    if (pagination.total === 0) {
      listingsCount.textContent = '';
      return;
    }
    var from = (pagination.page - 1) * pagination.limit + 1;
    var to   = Math.min(pagination.page * pagination.limit, pagination.total);
    listingsCount.textContent =
      'Mostrando ' + from + '–' + to + ' de ' + pagination.total + ' anuncios';
  }

  // ─── Fetch ────────────────────────────────────────────────────────────────
  function buildQueryString(params) {
    var parts = [];
    if (params.q)         parts.push('q='         + encodeURIComponent(params.q));
    if (params.category)  parts.push('category='  + encodeURIComponent(params.category));
    if (params.condition) parts.push('condition='  + encodeURIComponent(params.condition));
    if (params.provincia) parts.push('provincia=' + encodeURIComponent(params.provincia));
    if (params.minPrice)  parts.push('minPrice='  + encodeURIComponent(params.minPrice));
    if (params.maxPrice)  parts.push('maxPrice='  + encodeURIComponent(params.maxPrice));
    if (params.sort)      parts.push('sort='      + encodeURIComponent(params.sort));
    parts.push('page='  + params.page);
    parts.push('limit=' + 20);
    return parts.join('&');
  }

  function showLoading() {
    listingsContainer.innerHTML =
      '<p style="color:#888;padding:2rem 0;text-align:center;">Cargando anuncios...</p>';
  }

  function showError() {
    listingsContainer.innerHTML = '';
    var errEl = document.createElement('p');
    errEl.style.cssText = 'color:#888;padding:2rem 0;text-align:center;';
    errEl.textContent = 'Error al cargar los anuncios. ';
    var link = document.createElement('a');
    link.href = '';
    link.style.color = '#e8c97a';
    link.textContent = 'Recargar →';
    link.addEventListener('click', function (e) { e.preventDefault(); location.reload(); });
    errEl.appendChild(link);
    listingsContainer.appendChild(errEl);
  }

  function fetchAndRender() {
    showLoading();
    fetch(API_BASE_URL + '/api/listings?' + buildQueryString(currentParams))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        // Support both old array response and new paginated shape
        var listings   = Array.isArray(data) ? data : (data.listings   || []);
        var pagination = Array.isArray(data) ? null : (data.pagination || null);
        renderListings(listings);
        renderCount(pagination);
        renderPagination(pagination);
      })
      .catch(function (err) {
        console.error('Error fetching listings:', err);
        showError();
      });
  }

  // ─── Filter controls ──────────────────────────────────────────────────────

  // Sidebar category links
  document.querySelectorAll('.category-link').forEach(function (link) {
    link.addEventListener('click', function (e) {
      e.preventDefault();
      currentParams.category = e.currentTarget.dataset.category || '';
      currentParams.page     = 1;
      fetchAndRender();
    });
  });

  // Search bar — submit on button click or Enter key
  var searchInput = document.getElementById('search-q');
  var searchBtn   = document.getElementById('search-btn');

  function applySearch() {
    currentParams.q    = (searchInput ? searchInput.value.trim() : '');
    currentParams.page = 1;
    fetchAndRender();
  }

  if (searchBtn)   searchBtn.addEventListener('click', applySearch);
  if (searchInput) {
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') applySearch();
    });
  }

  // Advanced filters (Apply button)
  var filterBtn = document.getElementById('filter-button');
  if (filterBtn) {
    filterBtn.addEventListener('click', function () {
      currentParams.condition = (document.getElementById('filter-condition') || {}).value || '';
      currentParams.provincia = (document.getElementById('filter-provincia') || {}).value || '';
      currentParams.minPrice  = (document.getElementById('min-price')       || {}).value || '';
      currentParams.maxPrice  = (document.getElementById('max-price')       || {}).value || '';
      currentParams.sort      = (document.getElementById('filter-sort')     || {}).value || 'newest';
      currentParams.page      = 1;
      fetchAndRender();
    });
  }

  // Reset button — clears all filters
  var resetBtn = document.getElementById('reset-button');
  if (resetBtn) {
    resetBtn.addEventListener('click', function () {
      if (searchInput) searchInput.value = '';
      var cond = document.getElementById('filter-condition'); if (cond) cond.value = '';
      var prov = document.getElementById('filter-provincia'); if (prov) prov.value = '';
      var mn   = document.getElementById('min-price');       if (mn)   mn.value   = '';
      var mx   = document.getElementById('max-price');       if (mx)   mx.value   = '';
      var srt  = document.getElementById('filter-sort');     if (srt)  srt.value  = 'newest';
      currentParams = { q:'', category:'', condition:'', provincia:'', minPrice:'', maxPrice:'', sort:'newest', page:1 };
      fetchAndRender();
    });
  }

  // ─── Initial load ─────────────────────────────────────────────────────────
  // Check URL for a pre-selected category (e.g. from homepage category links)
  var urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('category')) {
    currentParams.category = urlParams.get('category');
  }
  if (urlParams.get('q')) {
    currentParams.q = urlParams.get('q');
    if (searchInput) searchInput.value = currentParams.q;
  }

  fetchAndRender();
});
