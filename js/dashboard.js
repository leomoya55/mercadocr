document.addEventListener('DOMContentLoaded', () => {
  const metricCount       = document.getElementById('metric-count');
  const metricFree        = document.getElementById('metric-free');
  const metricPlan        = document.getElementById('metric-plan');
  const listingsContainer = document.getElementById('dashboard-listings');
  const upgradeSection    = document.getElementById('dashboard-upgrade');
  const upgradeButton     = document.getElementById('upgrade-pro');

  const OWNER_EMAIL = 'leomoyawr300@gmail.com';

  // 12s > Vercel's 10s function timeout — server always responds before abort.
  const fetchWithTimeout = (url, opts = {}, ms = 12000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return authFetch(url, { ...opts, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };

  // ─── Listings renderer ────────────────────────────────────────────────────
  function renderListings(listings, container) {
    container.innerHTML = '';
    listings.forEach(listing => {
      const card   = document.createElement('div');
      card.className = 'listing-item';
      const now           = Date.now();
      const isSold        = listing.status === 'sold';
      const isExpired     = !isSold && listing.expiresAt &&
                            new Date(listing.expiresAt).getTime() <= now;
      const isLive        = !isSold && !isExpired;

      const featuredBadge = listing.featured && isLive ? '<span class="badge-featured">Destacado</span>' : '';
      const soldBadge     = isSold ? '<span class="badge-sold">Vendido</span>' : '';
      const expiredBadge  = isExpired ? '<span class="badge-expired">Expirado</span>' : '';

      // Live listings can be edited / marked sold; expired ones can be renewed.
      const editBtn     = isLive ? `<button data-edit="${listing._id}">Editar</button>` : '';
      const markSoldBtn = isLive
        ? `<button data-mark-sold="${listing._id}" class="btn-mark-sold">Marcar vendido</button>`
        : '';
      const renewBtn = isExpired
        ? `<button data-renew="${listing._id}" class="btn-renew">Renovar</button>`
        : '';
      // Boost button on live listings — "Destacar" or "Extender" if already featured.
      const boostBtn = isLive
        ? `<button data-boost="${listing._id}" class="btn-boost">${listing.featured ? '⭐ Extender' : '⭐ Destacar'}</button>`
        : '';

      // Sold listings auto-delete a week after being marked sold.
      let statusNote = '';
      if (isSold) {
        const removalMs = (listing.soldAt ? new Date(listing.soldAt).getTime() : now)
          + 7 * 24 * 60 * 60 * 1000;
        const daysLeft = Math.max(0, Math.ceil((removalMs - now) / (24 * 60 * 60 * 1000)));
        statusNote = `<div class="sold-note">Se elimina en ${daysLeft} día${daysLeft !== 1 ? 's' : ''}</div>`;
      } else if (isExpired) {
        const deleteMs = new Date(listing.expiresAt).getTime() + 7 * 24 * 60 * 60 * 1000;
        const daysToDelete = Math.max(0, Math.ceil((deleteMs - now) / (24 * 60 * 60 * 1000)));
        statusNote = `<div class="expired-note">Expirado · se elimina en ${daysToDelete} día${daysToDelete !== 1 ? 's' : ''} si no renuevas.</div>`;
      } else if (listing.expiresAt) {
        const daysLeft = Math.max(0, Math.ceil((new Date(listing.expiresAt).getTime() - now) / (24 * 60 * 60 * 1000)));
        statusNote = `<div class="expiry-note">Vence en ${daysLeft} día${daysLeft !== 1 ? 's' : ''}</div>`;
      }

      const dimmed = isSold || isExpired;
      const isJob = listing.category === 'Empleos';
      const photo = listing.photos && listing.photos[0] ? escapeHtml(cldAuto(listing.photos[0])) : '';
      const imgHtml = photo
        ? `<img src="${photo}" alt="${escapeHtml(listing.name)}"${dimmed ? ' style="opacity:0.55"' : ''}>`
        : `<div class="listing-noimg"${dimmed ? ' style="opacity:0.55"' : ''} aria-hidden="true">${isJob ? '💼' : '🛍️'}</div>`;
      const priceHtml = isJob
        ? `<div class="listing-item-price">${escapeHtml(listing.job && listing.job.salary ? listing.job.salary : 'Empleo')}</div>`
        : `<div class="listing-item-price">₡${Number(listing.price).toLocaleString('es-CR')}</div>`;
      card.innerHTML = `
        ${imgHtml}
        <div class="listing-item-content">
          <div class="listing-item-title">${escapeHtml(listing.name)}</div>
          <div class="listing-item-meta">
            ${priceHtml}
            ${featuredBadge}${soldBadge}${expiredBadge}
          </div>
          ${statusNote}
          ${listing.provincia ? `<div class="listing-item-location">📍 ${escapeHtml(listing.provincia)}</div>` : ''}
          <div class="dashboard-actions">
            ${renewBtn}
            ${boostBtn}
            ${editBtn}
            ${markSoldBtn}
            <button data-delete="${listing._id}">Eliminar</button>
          </div>
        </div>
      `;
      container.appendChild(card);
    });

    container.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        window.location.href = `/publish?edit=${btn.getAttribute('data-edit')}`;
      });
    });

    container.querySelectorAll('[data-mark-sold]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await Modal.confirm({
          title: 'Marcar como vendido',
          message: 'Se mostrará como “Vendido” en tu panel durante una semana y luego se eliminará automáticamente. Esto libera un espacio para publicar otro anuncio.',
          confirmText: 'Marcar vendido',
          cancelText: 'Cancelar',
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Marcando...';
        try {
          await fetchWithTimeout(`/api/listings/mark-sold/${btn.getAttribute('data-mark-sold')}`, { method: 'POST' });
          UserStore.invalidate();
          window.location.reload();
        } catch {
          btn.disabled = false;
          btn.textContent = 'Marcar vendido';
        }
      });
    });

    container.querySelectorAll('[data-renew]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await Modal.confirm({
          title: 'Renovar anuncio',
          message: 'Tu anuncio volverá a estar activo en el mercado durante 30 días más.',
          confirmText: 'Renovar',
          cancelText: 'Cancelar',
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Renovando...';
        try {
          const r = await fetchWithTimeout(`/api/listings/renew/${btn.getAttribute('data-renew')}`, { method: 'POST' });
          if (r.ok) {
            UserStore.invalidate();
            Toast.success('Anuncio renovado por 30 días.');
            window.location.reload();
          } else if (r.status === 402) {
            Toast.error('Alcanzaste el límite de tu plan. Libera un espacio o mejora tu plan para renovar.');
            btn.disabled = false;
            btn.textContent = 'Renovar';
          } else {
            Toast.error('No se pudo renovar. Intenta de nuevo.');
            btn.disabled = false;
            btn.textContent = 'Renovar';
          }
        } catch {
          btn.disabled = false;
          btn.textContent = 'Renovar';
        }
      });
    });

    container.querySelectorAll('[data-boost]').forEach(btn => {
      btn.addEventListener('click', () => openBoostChooser(btn.getAttribute('data-boost')));
    });

    container.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const ok = await Modal.confirm({
          title: 'Eliminar anuncio',
          message: '¿Seguro que deseas eliminar este anuncio? Esta acción no se puede deshacer.',
          confirmText: 'Eliminar',
          cancelText: 'Cancelar',
          danger: true,
        });
        if (!ok) return;
        btn.disabled = true;
        btn.textContent = 'Eliminando...';
        try {
          await fetchWithTimeout(`/api/listings/delete/${btn.getAttribute('data-delete')}`, { method: 'POST' });
          UserStore.invalidate();
          window.location.reload();
        } catch {
          btn.disabled = false;
          btn.textContent = 'Eliminar';
        }
      });
    });
  }

  // ─── Boost / featured purchase ─────────────────────────────────────────────
  // Pricing mirrors server/config/featured.js (BOOST_PACKAGES). Keep in sync.
  const BOOST_OPTIONS = [
    { type: '24h', title: 'Destacado 24 horas', price: '₡500' },
    { type: '7d',  title: 'Destacado 7 días',   price: '₡1.500' },
    { type: '30d', title: 'Destacado 30 días',  price: '₡4.000' },
  ];

  function openBoostChooser(listingId) {
    const cards = BOOST_OPTIONS.map(o =>
      `<button type="button" class="boost-option" data-boost-type="${o.type}">
         <span class="boost-option-title">${o.title}</span>
         <span class="boost-option-price">${o.price}</span>
       </button>`).join('');
    Modal.show({
      ariaLabel: 'Destacar anuncio',
      html:
        '<div class="modal-confirm-title">Destacá tu anuncio ⭐</div>' +
        '<div class="modal-confirm-message">Tu anuncio aparecerá arriba del resto y de primero en las búsquedas durante el periodo elegido.</div>' +
        '<div class="boost-options">' + cards + '</div>',
    });
    document.querySelectorAll('.boost-option').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.getAttribute('data-boost-type');
        Modal.hide();
        startBoostCheckout(listingId, type);
      });
    });
  }

  async function startBoostCheckout(listingId, boostType) {
    const user = auth.currentUser;
    if (!user) { window.location.href = '/login'; return; }
    try {
      Toast.info('Redirigiendo al pago...');
      const r = await authFetch('/api/payment/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ type: 'boost', boostType, listingId }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.ok && data.url) {
        window.location.href = data.url;
      } else {
        Toast.error(data.message || data.error || 'No se pudo iniciar el pago del destacado.');
      }
    } catch {
      Toast.error('No se pudo conectar con el servidor.');
    }
  }

  // ─── Listings fetcher ─────────────────────────────────────────────────────
  async function loadListings(uid) {
    try {
      const r = await fetchWithTimeout(`/api/listings/user/${uid}`);
      const d = await r.json();
      return Array.isArray(d) ? d : [];
    } catch (err) {
      console.warn('Listings fetch failed:', err.message);
      return [];
    }
  }

  // ─── Metric helpers ───────────────────────────────────────────────────────

  /**
   * Compute the "Publicaciones disponibles" display string.
   * Uses server-computed `remaining` so the frontend never duplicates limit logic.
   *
   * @param {string} plan     — 'free' | 'basic' | 'pro'
   * @param {number|null} remaining — null means unlimited (Pro)
   * @param {number} credits  — singlePostCredits (free plan only)
   */
  function buildAvailableText(plan, remaining, credits) {
    if (plan === 'pro' || remaining === null) return 'Ilimitadas';
    if (remaining > 0)  return String(remaining);
    if (credits  > 0)   return `${credits} crédito${credits !== 1 ? 's' : ''}`;
    return '0';
  }

  // Option A downgrade banner — existing listings stay live; new ones blocked.
  function showOverLimitBanner(data) {
    if (!listingsContainer) return;
    let banner = document.getElementById('over-limit-banner');
    if (!data || !data.overLimit) { if (banner) banner.classList.add('hidden'); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'over-limit-banner';
      banner.className = 'over-limit-banner';
      banner.setAttribute('role', 'status');
      listingsContainer.parentNode.insertBefore(banner, listingsContainer);
    }
    banner.classList.remove('hidden');
    const planLabel = { free: 'Gratis', basic: 'Basic', pro: 'Pro' }[data.plan] || data.plan;
    banner.innerHTML =
      '<strong>Tu cuenta supera el límite de tu plan.</strong> ' +
      'Tenés ' + data.listingCount + ' anuncios activos y el plan ' + planLabel +
      ' permite ' + data.maxListings + '. Tus anuncios siguen publicados, pero no podrás crear ' +
      'nuevos hasta mejorar tu plan o eliminar algunos. <a href="/pricing">Mejorar plan</a>';
  }

  function applyOwnerUI() {
    if (metricPlan)     metricPlan.textContent  = 'Pro';
    if (metricFree)     metricFree.textContent  = 'Ilimitadas';
    if (upgradeSection) upgradeSection.classList.add('hidden');
  }

  // ─── Referral / invite link ────────────────────────────────────────────────
  // Builds the member's invite link from their public username (referral.code)
  // and shows their lifetime referral count. Hidden until a code exists.
  let _referralWired = false;
  const renderReferral = (referral) => {
    const section = document.getElementById('dashboard-referral');
    if (!section) return;

    const code = referral && referral.code;
    if (!code) { section.style.display = 'none'; return; }

    const link    = `${window.location.origin}/register?ref=${encodeURIComponent(code)}`;
    const linkInp = document.getElementById('referral-link');
    const countEl = document.getElementById('referral-count');
    const copyBtn = document.getElementById('referral-copy');

    if (linkInp) linkInp.value = link;
    if (countEl) countEl.textContent = (referral && referral.count) || 0;
    section.style.display = '';

    if (copyBtn && !_referralWired) {
      _referralWired = true;
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(link);
          Toast.success('Enlace copiado.');
        } catch {
          // Clipboard API unavailable (e.g. insecure context) — select for manual copy.
          if (linkInp) { linkInp.focus(); linkInp.select(); }
          Toast.info('Copia el enlace seleccionado.');
        }
      });
    }
  };

  // ─── Main loader ──────────────────────────────────────────────────────────
  const loadDashboard = async (user) => {
    if (metricFree)        metricFree.textContent  = '...';
    if (metricPlan)        metricPlan.textContent  = '...';
    if (metricCount)       metricCount.textContent = '...';
    if (listingsContainer) listingsContainer.innerHTML =
      '<p class="dashboard-empty" style="color:#666;">Cargando tus anuncios...</p>';

    // UserStore handles retries, mcr_reg forwarding, and owner override
    let profileData = null;
    try {
      profileData = await UserStore.getProfile(user);
    } catch (err) {
      console.warn('Dashboard profile failed:', err.message);
    }

    if (!profileData) {
      // Profile API failed — show safe fallback values
      if (user.email === OWNER_EMAIL) {
        applyOwnerUI();
      } else {
        if (metricCount)    metricCount.textContent = '0';
        if (metricPlan)     metricPlan.textContent  = 'Gratis';
        if (metricFree)     metricFree.textContent  = '3'; // FREE_LIMIT fallback
        if (upgradeSection) upgradeSection.classList.remove('hidden');
      }
      if (listingsContainer) {
        const listings = await loadListings(user.uid);
        if (!listings.length) {
          listingsContainer.innerHTML =
            '<p class="dashboard-empty">Aún no has publicado nada. <a href="/publish">Publica tu primer anuncio gratis →</a></p>';
        } else {
          renderListings(listings, listingsContainer);
        }
      }
      return;
    }

    // ── Profile loaded ────────────────────────────────────────────────────────
    const profile      = profileData.user;
    const listingCount = profileData.listingCount || 0;
    const credits      = profileData.credits      || 0; // from API (singlePostCredits)
    const remaining    = profileData.remaining;          // null = unlimited, number = slots left

    if (metricCount) metricCount.textContent = listingCount;

    showOverLimitBanner(profileData);

    const planLabels = { free: 'Gratis', basic: 'Basic', pro: 'Pro' };
    if (metricPlan) metricPlan.textContent = planLabels[profile.plan] || 'Gratis';

    if (metricFree) {
      metricFree.textContent = buildAvailableText(profile.plan, remaining, credits);
    }

    const creditsCard   = document.getElementById('metric-credits-card');
    const metricCredits = document.getElementById('metric-credits');
    if (creditsCard && profile.plan === 'free') {
      creditsCard.style.display = '';
      if (metricCredits) metricCredits.textContent = credits;
    }

    // ── Referral / invite section ──────────────────────────────────────────
    renderReferral(profileData.referral);

    // Show upgrade banner unless Pro or no slots warning needed
    if (upgradeSection) {
      const limitReached = remaining !== null && remaining === 0 && credits === 0;
      upgradeSection.classList.toggle('hidden', profile.plan === 'pro');
      // Add urgency class when limit is actually hit
      upgradeSection.classList.toggle('upgrade-urgent', limitReached && profile.plan !== 'pro');
    }

    if (!listingsContainer) return;

    const listings = await loadListings(user.uid);
    if (!listings.length) {
      listingsContainer.innerHTML =
        '<p class="dashboard-empty">Aún no has publicado nada. <a href="/publish">Publica tu primer anuncio gratis →</a></p>';
      return;
    }
    renderListings(listings, listingsContainer);
  };

  // Returning from a boost checkout — surface the result and refresh the cache so
  // the new "Destacado" status shows after the webhook applies it.
  const dashParams = new URLSearchParams(window.location.search);
  if (dashParams.get('boost_success') === 'true') {
    UserStore.invalidate();
    Toast.success('¡Pago recibido! Tu anuncio se está destacando.');
    window.history.replaceState({}, document.title, '/dashboard');
  } else if (dashParams.get('boost_canceled') === 'true') {
    Toast.info('Pago cancelado. Tu anuncio no fue destacado.');
    window.history.replaceState({}, document.title, '/dashboard');
  }

  auth.onAuthStateChanged((user) => {
    if (!user) { window.location.href = '/login'; return; }
    if (user.email === OWNER_EMAIL) applyOwnerUI();

    loadDashboard(user).catch(err => {
      console.error(err);
      if (user.email === OWNER_EMAIL) {
        applyOwnerUI();
      } else {
        if (metricFree)        metricFree.textContent  = '3';
        if (metricPlan)        metricPlan.textContent  = 'Gratis';
        if (metricCount)       metricCount.textContent = '0';
        if (listingsContainer) {
          listingsContainer.innerHTML = '<p class="dashboard-empty">Error al cargar el panel. <a href="" id="dashboard-reload-link">Recarga la página →</a></p>';
          const reloadLink = listingsContainer.querySelector('#dashboard-reload-link');
          if (reloadLink) reloadLink.addEventListener('click', (e) => { e.preventDefault(); location.reload(); });
        }
      }
    });
  });

  if (upgradeButton) {
    upgradeButton.addEventListener('click', async () => {
      const user = auth.currentUser;
      if (!user) { window.location.href = '/login'; return; }

      // Friendly guard: don't start checkout if already Pro
      const cached = UserStore.current;
      if (cached?.user?.plan === 'pro') {
        Toast.info('¡Ya tienes el plan Pro activo! No necesitas volver a comprarlo.');
        return;
      }

      try {
        upgradeButton.disabled = true;
        upgradeButton.textContent = 'Procesando...';
        const response = await authFetch('/api/payment/create-checkout-session', {
          method: 'POST',
          body: JSON.stringify({ type: 'pro' }),
        });
        const data = await response.json();

        if (response.status === 400 && data.error === 'already_on_plan') {
          Toast.info(data.message || '¡Ya tienes el plan Pro activo!');
          upgradeButton.disabled = false;
          upgradeButton.textContent = 'Hacerme Pro';
          return;
        }

        // Proration: tier changed on the existing subscription in-place.
        if (data.upgraded) {
          UserStore.invalidate();
          Toast.success('Tu plan cambió a Pro. El cobro se prorrateó.');
          setTimeout(() => window.location.reload(), 1400);
          return;
        }

        if (data.url) {
          window.location.href = data.url;
        } else {
          Toast.error('Error al iniciar el pago. Intenta de nuevo.');
          upgradeButton.disabled = false;
          upgradeButton.textContent = 'Hacerme Pro';
        }
      } catch (error) {
        console.error('Error:', error);
        Toast.error('No se pudo conectar con el servidor.');
        upgradeButton.disabled = false;
        upgradeButton.textContent = 'Hacerme Pro';
      }
    });
  }
});
