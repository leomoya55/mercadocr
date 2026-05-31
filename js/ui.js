/**
 * ui.js — reusable UI components for MercaTico
 *
 * Exposes on window:
 *   Toast.success / .error / .info  — slide-in notifications with deduplication
 *   Modal.show / .hide              — accessible modal overlay with close button
 *   showPublishSuccess(opts)        — publish success modal with confetti
 *   buildWaLink(phone)              — sanitize phone → wa.me URL (Costa Rica)
 *
 * Must load after config.js (uses escapeHtml).
 */
(function () {
  'use strict';

  // ─── Toast ─────────────────────────────────────────────────────────────────
  // Deduplication: if the same message is already visible, don't stack another.

  var _toastContainer = null;
  var _activeMessages = Object.create(null); // message → count

  function getContainer() {
    if (!_toastContainer) {
      _toastContainer = document.createElement('div');
      _toastContainer.id = 'toast-container';
      _toastContainer.setAttribute('aria-live', 'polite');
      _toastContainer.setAttribute('aria-atomic', 'false');
      document.body.appendChild(_toastContainer);
    }
    return _toastContainer;
  }

  var ICONS = {
    success: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    error:   '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e05c5c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    info:    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#e8c97a" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  window.Toast = {
    show: function (message, type, duration) {
      type     = type     || 'info';
      duration = duration || 4000;

      // Deduplication: skip if this exact message is already on screen
      if (_activeMessages[message]) return;
      _activeMessages[message] = true;

      var c  = getContainer();
      var el = document.createElement('div');
      el.className = 'toast toast-' + type;
      el.setAttribute('role', 'status');
      el.innerHTML = (ICONS[type] || ICONS.info) + '<span>' + message + '</span>';
      c.appendChild(el);

      setTimeout(function () {
        delete _activeMessages[message];
        el.classList.add('toast-exit');
        el.addEventListener('animationend', function () { el.remove(); }, { once: true });
      }, duration);
    },
    success: function (msg, dur) { this.show(msg, 'success', dur); },
    error:   function (msg, dur) { this.show(msg, 'error',   dur); },
    info:    function (msg, dur) { this.show(msg, 'info',    dur); },
  };

  // ─── Modal ──────────────────────────────────────────────────────────────────

  var _overlay      = null;
  var _prevFocus    = null; // element that had focus before modal opened

  var CLOSE_ICON =
    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"' +
    ' stroke-width="2.5" stroke-linecap="round" aria-hidden="true">' +
    '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>' +
    '</svg>';

  window.Modal = {
    show: function (opts) {
      this.hide();
      _prevFocus = document.activeElement;

      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', opts.ariaLabel || 'Ventana de diálogo');

      var box = document.createElement('div');
      box.className = 'modal-box';
      box.innerHTML =
        '<button class="modal-close" aria-label="Cerrar ventana">' + CLOSE_ICON + '</button>' +
        opts.html;

      overlay.appendChild(box);
      document.body.appendChild(overlay);
      _overlay = overlay;
      document.body.style.overflow = 'hidden';

      // Wire close button
      var closeBtn = box.querySelector('.modal-close');
      if (closeBtn) {
        closeBtn.addEventListener('click', function () {
          window.Modal.hide();
          if (opts.onClose) opts.onClose();
        });
        // Delay focus so animation doesn't fight it
        setTimeout(function () { closeBtn.focus(); }, 60);
      }

      // Backdrop click dismisses
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) {
          window.Modal.hide();
          if (opts.onClose) opts.onClose();
        }
      });
    },

    hide: function () {
      if (_overlay) {
        _overlay.remove();
        _overlay = null;
        document.body.style.overflow = '';
        // Return focus to the element that triggered the modal
        if (_prevFocus && typeof _prevFocus.focus === 'function') {
          _prevFocus.focus();
        }
        _prevFocus = null;
      }
    },
  };

  // ESC key closes modal
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _overlay) window.Modal.hide();
  });

  // ─── Publish success modal ──────────────────────────────────────────────────

  var CHECK_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="#25D366" stroke-width="2.5"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<polyline points="20 6 9 17 4 12"/>' +
    '</svg>';

  window.showPublishSuccess = function (opts) {
    var id    = opts.id    || '';
    var name  = opts.name  || 'Tu anuncio';
    var photo = opts.photo || '';

    var thumbHtml = photo
      ? '<img src="' + escapeHtml(photo) + '" alt="' + escapeHtml(name) + '"' +
        ' class="success-thumb" loading="lazy">'
      : '';

    var viewHref = id ? '/product?id=' + id : '/listings';

    window.Modal.show({
      ariaLabel: 'Anuncio publicado con éxito',
      html:
        '<div class="success-checkmark">' + CHECK_SVG + '</div>' +
        '<div class="success-title">¡Publicado con éxito!</div>' +
        thumbHtml +
        '<div class="success-subtitle">' + escapeHtml(name) + '</div>' +
        '<div class="success-actions">' +
          '<a href="' + viewHref + '" class="btn-view">Ver anuncio →</a>' +
          '<a href="/dashboard" class="btn-dash">Ir al panel</a>' +
          '<button class="btn-another" id="ui-publish-another">Publicar otro</button>' +
        '</div>',
    });

    // "Publish another" — close modal and scroll to top so form is fresh
    var anotherBtn = document.getElementById('ui-publish-another');
    if (anotherBtn) {
      anotherBtn.addEventListener('click', function () {
        window.Modal.hide();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    }

    _runConfetti();
  };

  // ─── Lightweight confetti ───────────────────────────────────────────────────

  function _runConfetti() {
    var canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:8999;width:100%;height:100%;';
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    var ctx = canvas.getContext('2d');

    var COLORS = ['#e8c97a', '#25D366', '#ffffff', '#64c882', '#ffd966'];
    var pieces = [];
    for (var i = 0; i < 90; i++) {
      pieces.push({
        x:     Math.random() * canvas.width,
        y:     -8 - Math.random() * (canvas.height * 0.4),
        w:     5 + Math.random() * 8,
        h:     4 + Math.random() * 5,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        vx:    (Math.random() - 0.5) * 3,
        vy:    2.5 + Math.random() * 4,
        angle: Math.random() * Math.PI * 2,
        spin:  (Math.random() - 0.5) * 0.13,
      });
    }

    var frame = 0;
    var MAX   = 140;

    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      pieces.forEach(function (p) {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.angle);
        ctx.fillStyle   = p.color;
        ctx.globalAlpha = Math.max(0, 1 - frame / MAX);
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
        p.x += p.vx; p.y += p.vy; p.angle += p.spin;
      });
      frame++;
      if (frame < MAX) requestAnimationFrame(draw);
      else canvas.remove();
    }
    requestAnimationFrame(draw);
  }

  // ─── WhatsApp link builder ──────────────────────────────────────────────────
  //
  // Single source of truth for WA link generation across the whole app.
  // Strips all non-digit characters, then prepends the Costa Rica code (506)
  // if not already present. Returns null when the number is too short to be real.
  //
  // Security: all WA anchors must use target="_blank" rel="noopener noreferrer".
  // ui.js does not inject anchors — callers (product.js, listings.js) do,
  // and they are responsible for adding the correct rel attribute.

  window.buildWaLink = function (phone) {
    if (!phone) return null;
    var digits = String(phone).replace(/\D/g, '');
    if (digits.length < 8) return null;
    var waNumber = digits.startsWith('506') ? digits : '506' + digits;
    return 'https://wa.me/' + waNumber;
  };

}());
