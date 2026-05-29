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
      const isSold        = listing.status === 'sold';
      const featuredBadge = listing.featured && !isSold ? '<span class="badge-featured">Destacado</span>' : '';
      const soldBadge     = isSold ? '<span class="badge-sold">Vendido</span>' : '';
      const editBtn       = !isSold ? `<button data-edit="${listing._id}">Editar</button>` : '';
      const markSoldBtn   = !isSold
        ? `<button data-mark-sold="${listing._id}" class="btn-mark-sold">Marcar vendido</button>`
        : '';

      card.innerHTML = `
        <img src="${escapeHtml(listing.photos[0])}" alt="${escapeHtml(listing.name)}"${isSold ? ' style="opacity:0.55"' : ''}>
        <div class="listing-item-content">
          <div class="listing-item-title">${escapeHtml(listing.name)}</div>
          <div class="listing-item-meta">
            <div class="listing-item-price">₡${Number(listing.price).toLocaleString('es-CR')}</div>
            ${featuredBadge}${soldBadge}
          </div>
          ${listing.provincia ? `<div class="listing-item-location">📍 ${escapeHtml(listing.provincia)}</div>` : ''}
          <div class="dashboard-actions">
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
        if (!confirm('¿Marcar este anuncio como vendido? Quedará archivado y liberará un espacio para publicar otro.')) return;
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

    container.querySelectorAll('[data-delete]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('¿Seguro que deseas eliminar este anuncio?')) return;
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

  function applyOwnerUI() {
    if (metricPlan)     metricPlan.textContent  = 'Pro';
    if (metricFree)     metricFree.textContent  = 'Ilimitadas';
    if (upgradeSection) upgradeSection.classList.add('hidden');
  }

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
