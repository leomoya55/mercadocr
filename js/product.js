/**
 * product.js — product detail page
 * Renders: image carousel, product info, WhatsApp contact button.
 * Requires: config.js (escapeHtml, API_BASE_URL), ui.js (buildWaLink, Toast).
 */

// Inline WhatsApp SVG icon — same path used in listings.js
var _WA_ICON_LG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24"' +
  ' fill="currentColor" aria-hidden="true">' +
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

document.addEventListener('DOMContentLoaded', function () {
  var container = document.getElementById('product-detail');
  var params    = new URLSearchParams(window.location.search);
  var productId = params.get('id');

  container.innerHTML = '<div class="loading">Cargando producto...</div>';

  if (!productId) {
    container.innerHTML = '<p class="product-error">Producto no encontrado.</p>';
    return;
  }

  // ── Unique authenticated view tracking ──────────────────────────────────────
  // Fires once when auth state resolves. Backend atomically enforces all rules:
  //   - guests never count (no token → request never sent)
  //   - owner viewing own listing → server filter won't match → no count
  //   - same user revisiting → viewedBy already contains their UID → no count
  //   - page refresh = no extra count ever
  // No localStorage. No client-side deduplication. All logic is server-side.
  auth.onAuthStateChanged(function (user) {
    if (!user || !productId) return;
    user.getIdToken().then(function (token) {
      fetch(API_BASE_URL + '/api/listings/' + productId + '/view', {
        method:  'POST',
        headers: { 'Authorization': 'Bearer ' + token },
      }).catch(function () {}); // fire-and-forget — never block the page
    }).catch(function () {});
  });

  fetch(API_BASE_URL + '/api/listings/' + productId)
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (product) {
      if (!product || !product._id) {
        container.innerHTML = '<p class="product-error">Producto no encontrado.</p>';
        return;
      }

      var photos = Array.isArray(product.photos) && product.photos.length
        ? product.photos.map(cldAuto) : [];
      var seller = product.seller || null;

      // Build seller display name
      var sellerName = seller
        ? (escapeHtml(seller.nombre || '') + ' ' + escapeHtml(seller.apellido || '')).trim() || 'Vendedor'
        : 'Vendedor';

      // WhatsApp button — uses seller.phone from User lookup
      var waLink = (typeof buildWaLink === 'function') ? buildWaLink(seller && seller.phone) : null;
      var waHtml = waLink
        ? '<a href="' + waLink + '" target="_blank" rel="noopener noreferrer" class="wa-btn-large">' +
            _WA_ICON_LG + ' Contactar por WhatsApp' +
          '</a>'
        : '';

      var featuredBadge = product.featured
        ? '<span class="badge-featured">Destacado</span>'
        : '';

      // Views counter
      var viewsHtml = product.views
        ? '<div class="product-views">👁 ' + Number(product.views).toLocaleString('es-CR') + ' visitas</div>'
        : '';

      // Real-estate details (Bienes Raíces only)
      var re = product.realEstate || {};
      var isRealEstate = product.category === 'Bienes Raíces';
      var RE_OP_LABELS   = { alquiler: 'Alquiler', venta: 'Venta' };
      var RE_TYPE_LABELS = { casa: 'Casa', apartamento: 'Apartamento', lote: 'Lote / Terreno', local: 'Local comercial', oficina: 'Oficina', bodega: 'Bodega', finca: 'Finca' };
      var priceSuffix = (isRealEstate && re.operation === 'alquiler') ? '<span> /mes</span>' : '';
      var reRows = [];
      if (isRealEstate) {
        if (re.operation)          reRows.push(['Operación',    RE_OP_LABELS[re.operation] || re.operation]);
        if (re.propertyType)       reRows.push(['Tipo',         RE_TYPE_LABELS[re.propertyType] || re.propertyType]);
        if (re.area != null)       reRows.push(['Área',         re.area + ' m²']);
        if (re.bedrooms != null)   reRows.push(['Habitaciones', String(re.bedrooms)]);
        if (re.bathrooms != null)  reRows.push(['Baños',        String(re.bathrooms)]);
      }
      var reHtml = reRows.length
        ? '<div class="product-realestate"><h3>Detalles de la propiedad</h3><ul>' +
            reRows.map(function (r) {
              return '<li><span>' + escapeHtml(r[0]) + '</span><strong>' + escapeHtml(r[1]) + '</strong></li>';
            }).join('') +
          '</ul></div>'
        : '';

      container.innerHTML =
        '<div class="product-grid">' +
          '<div class="product-images-col">' +
            _buildCarouselHtml(photos, product.name) +
          '</div>' +
          '<div class="product-info">' +
            '<h1>' + escapeHtml(product.name) +
              (featuredBadge ? ' ' + featuredBadge : '') +
            '</h1>' +
            '<div class="product-price">₡' + Number(product.price).toLocaleString('es-CR') + priceSuffix + '</div>' +
            viewsHtml +
            reHtml +
            (product.size
              ? '<div class="product-size"><h3>Talla</h3><p>' + escapeHtml(product.size) + '</p></div>'
              : '') +
            '<div class="product-description">' +
              '<h3>Descripción</h3>' +
              '<p>' + escapeHtml(product.description) + '</p>' +
            '</div>' +
            (product.provincia
              ? '<div class="product-location"><h3>Ubicación</h3><p>📍 ' + escapeHtml(product.provincia) + '</p></div>'
              : '') +
            '<div class="product-seller">' +
              '<h3>Vendedor</h3>' +
              '<p>' + sellerName + '</p>' +
            '</div>' +
            waHtml +
            '<button type="button" class="report-btn" id="report-btn" data-listing-id="' + escapeHtml(product._id) + '">' +
              '⚑ Reportar anuncio' +
            '</button>' +
          '</div>' +
        '</div>';

      _initCarousel(photos, product.name);
      _initReportButton(product._id);
    })
    .catch(function (err) {
      console.error('[product]', err);
      container.innerHTML = '<p class="product-error">Error al cargar el producto. Por favor recarga la página.</p>';
    });
});

// ─── Report button ────────────────────────────────────────────────────────────

var REPORT_REASONS = [
  { value: 'spam',           label: 'Es spam o publicidad' },
  { value: 'scam',           label: 'Posible estafa o fraude' },
  { value: 'inappropriate',  label: 'Contenido inapropiado' },
  { value: 'wrong_category', label: 'Categoría incorrecta' },
  { value: 'duplicate',      label: 'Anuncio duplicado' },
  { value: 'other',          label: 'Otro motivo' },
];

function _initReportButton(listingId) {
  var btn = document.getElementById('report-btn');
  if (!btn) return;

  btn.addEventListener('click', function () {
    // Check login state — auth is global from Firebase
    if (typeof auth === 'undefined' || !auth.currentUser) {
      if (typeof Toast !== 'undefined') {
        Toast.info('Debes iniciar sesión para reportar un anuncio.');
      }
      return;
    }

    var optionsHtml = REPORT_REASONS.map(function (r) {
      return '<label class="report-reason-label">' +
        '<input type="radio" name="report-reason" value="' + r.value + '">' +
        ' ' + r.label +
      '</label>';
    }).join('');

    var body =
      '<p style="color:#aaa;font-size:0.9rem;margin:0 0 1rem;">Selecciona el motivo del reporte:</p>' +
      '<div class="report-reasons">' + optionsHtml + '</div>' +
      '<textarea id="report-details" placeholder="Detalles adicionales (opcional)" rows="3" ' +
        'style="width:100%;margin-top:1rem;background:#1a1a1a;border:1px solid #444;' +
               'color:#fff;border-radius:6px;padding:0.6rem;resize:vertical;font-family:inherit;"></textarea>' +
      '<button type="button" id="report-submit" class="cta-button" style="margin-top:1rem;width:100%;">Enviar reporte</button>';

    if (typeof Modal !== 'undefined') {
      // Modal.show renders opts.html (not opts.body) — pass html so the report
      // form actually appears instead of an empty modal.
      Modal.show({
        ariaLabel: 'Reportar anuncio',
        html: '<h2 class="modal-confirm-title">Reportar anuncio</h2>' + body,
      });
    }

    // Wire up the submit button inside the modal (after it's in the DOM)
    setTimeout(function () {
      var submitBtn = document.getElementById('report-submit');
      if (!submitBtn) return;
      submitBtn.addEventListener('click', function () {
        var selected = document.querySelector('input[name="report-reason"]:checked');
        if (!selected) {
          if (typeof Toast !== 'undefined') Toast.error('Por favor selecciona un motivo.');
          return;
        }
        var details = (document.getElementById('report-details') || {}).value || '';
        submitBtn.disabled    = true;
        submitBtn.textContent = 'Enviando...';

        auth.currentUser.getIdToken().then(function (token) {
          return fetch(API_BASE_URL + '/api/reports', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body:    JSON.stringify({ listingId: listingId, reason: selected.value, details: details }),
          });
        })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) {
          if (typeof Modal !== 'undefined') Modal.hide();
          if (res.ok) {
            if (typeof Toast !== 'undefined') Toast.success(res.d.message || 'Reporte enviado.');
          } else {
            if (typeof Toast !== 'undefined') Toast.error(res.d.error || 'Error al enviar el reporte.');
          }
        })
        .catch(function () {
          if (typeof Toast !== 'undefined') Toast.error('No se pudo conectar con el servidor.');
          submitBtn.disabled    = false;
          submitBtn.textContent = 'Enviar reporte';
        });
      });
    }, 50);
  });
}

// ─── Carousel HTML builder ────────────────────────────────────────────────────

function _buildCarouselHtml(photos, name) {
  if (!photos.length) {
    return '<div class="carousel-empty">Sin imágenes</div>';
  }

  var mainHtml =
    '<div class="carousel-main">' +
      '<img id="carousel-main-img"' +
      ' src="' + escapeHtml(photos[0]) + '"' +
      ' alt="' + escapeHtml(name) + '"' +
      ' loading="eager">';

  if (photos.length > 1) {
    mainHtml +=
      '<button class="carousel-arrow carousel-prev" aria-label="Imagen anterior">&#8249;</button>' +
      '<button class="carousel-arrow carousel-next" aria-label="Imagen siguiente">&#8250;</button>' +
      '<div class="carousel-counter"><span id="carousel-cur">1</span> / ' + photos.length + '</div>';
  }

  mainHtml += '</div>';

  if (photos.length > 1) {
    mainHtml += '<div class="carousel-thumbs" id="carousel-thumbs" role="tablist">';
    photos.forEach(function (src, i) {
      mainHtml +=
        '<button class="carousel-thumb' + (i === 0 ? ' thumb-active' : '') + '"' +
        ' data-idx="' + i + '"' +
        ' role="tab"' +
        ' aria-selected="' + (i === 0) + '"' +
        ' aria-label="Imagen ' + (i + 1) + '">' +
        '<img src="' + escapeHtml(src) + '" alt="" loading="lazy">' +
        '</button>';
    });
    mainHtml += '</div>';
  }

  return mainHtml;
}

// ─── Carousel behaviour ───────────────────────────────────────────────────────

function _initCarousel(photos, name) {
  if (photos.length <= 1) return;

  var mainImg  = document.getElementById('carousel-main-img');
  var counter  = document.getElementById('carousel-cur');
  var thumbBox = document.getElementById('carousel-thumbs');
  var prevBtn  = document.querySelector('.carousel-prev');
  var nextBtn  = document.querySelector('.carousel-next');
  var current  = 0;

  function goTo(index) {
    current = ((index % photos.length) + photos.length) % photos.length;

    // Shimmer while switching, then cross-fade in
    mainImg.style.opacity = '0';
    mainImg.classList.add('img-loading');

    setTimeout(function () {
      mainImg.src = photos[current];
      mainImg.alt = escapeHtml(name) + ' — imagen ' + (current + 1);

      function onLoaded() {
        mainImg.classList.remove('img-loading');
        mainImg.style.opacity = '1';
      }
      if (mainImg.complete) {
        onLoaded();
      } else {
        mainImg.addEventListener('load',  onLoaded, { once: true });
        mainImg.addEventListener('error', onLoaded, { once: true }); // don't hang on broken images
      }
    }, 100);

    if (counter) counter.textContent = current + 1;

    // Sync thumbnails
    if (thumbBox) {
      thumbBox.querySelectorAll('.carousel-thumb').forEach(function (btn, i) {
        var active = i === current;
        btn.classList.toggle('thumb-active', active);
        btn.setAttribute('aria-selected', active);
      });
      var activeThumb = thumbBox.querySelector('.thumb-active');
      if (activeThumb) {
        activeThumb.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
      }
    }

    // Preload adjacent images (N-1 and N+1) so transitions feel instant
    [-1, 1].forEach(function (offset) {
      var adj = ((current + offset + photos.length) % photos.length);
      if (adj !== current) {
        var pre = new Image();
        pre.src = photos[adj];
      }
    });
  }

  // Shimmer on initial load of the first image
  if (!mainImg.complete) {
    mainImg.classList.add('img-loading');
    mainImg.addEventListener('load',  function () { mainImg.classList.remove('img-loading'); }, { once: true });
    mainImg.addEventListener('error', function () { mainImg.classList.remove('img-loading'); }, { once: true });
  }

  if (prevBtn) prevBtn.addEventListener('click', function () { goTo(current - 1); });
  if (nextBtn) nextBtn.addEventListener('click', function () { goTo(current + 1); });

  // Thumbnail clicks
  if (thumbBox) {
    thumbBox.addEventListener('click', function (e) {
      var thumb = e.target.closest('.carousel-thumb');
      if (thumb) goTo(parseInt(thumb.dataset.idx, 10));
    });
  }

  // Keyboard — only when not typing in an input/textarea
  document.addEventListener('keydown', function (e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); goTo(current - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); goTo(current + 1); }
  });

  // Touch swipe — horizontal drag of ≥40px switches slide
  var mainWrap = document.querySelector('.carousel-main');
  if (mainWrap) {
    var touchX = 0;
    var touchY = 0;
    mainWrap.addEventListener('touchstart', function (e) {
      touchX = e.changedTouches[0].clientX;
      touchY = e.changedTouches[0].clientY;
    }, { passive: true });
    mainWrap.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - touchX;
      var dy = e.changedTouches[0].clientY - touchY;
      if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
        goTo(dx < 0 ? current + 1 : current - 1);
      }
    }, { passive: true });
  }
}
