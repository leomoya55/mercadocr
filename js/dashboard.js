document.addEventListener('DOMContentLoaded', () => {
  const metricCount = document.getElementById('metric-count');
  const metricFree = document.getElementById('metric-free');
  const metricPlan = document.getElementById('metric-plan');
  const listingsContainer = document.getElementById('dashboard-listings');
  const upgradeSection = document.getElementById('dashboard-upgrade');
  const upgradeButton = document.getElementById('upgrade-pro');

  const FREE_LIMIT  = 3;
  const BASIC_LIMIT = 20;
  const OWNER_EMAIL = 'leomoyawr300@gmail.com';

  // 12s > Vercel's 10s function timeout — Vercel always responds before we abort.
  const fetchWithTimeout = (url, opts = {}, ms = 12000) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return authFetch(url, { ...opts, signal: controller.signal })
      .finally(() => clearTimeout(timer));
  };

  // ─── Listings renderer — shared between normal and fallback paths ────────────
  function renderListings(listings, container) {
    container.innerHTML = '';
    listings.forEach(listing => {
      const card = document.createElement('div');
      card.className = 'listing-item';
      const isSold = listing.status === 'sold';
      const featuredBadge = listing.featured && !isSold ? '<span class="badge-featured">Destacado</span>' : '';
      const soldBadge     = isSold ? '<span class="badge-sold">Vendido</span>' : '';
      const editBtn       = !isSold ? `<button data-edit="${listing._id}">Editar</button>` : '';
      const markSoldBtn   = !isSold ? `<button data-mark-sold="${listing._id}" class="btn-mark-sold">Marcar vendido</button>` : '';

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
          window.location.reload();
        } catch {
          btn.disabled = false;
          btn.textContent = 'Eliminar';
        }
      });
    });
  }

  // ─── Listings fetcher ────────────────────────────────────────────────────────
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

  // ─── Main dashboard loader ───────────────────────────────────────────────────
  const loadDashboard = async (user) => {
    // Show loading states immediately
    if (metricFree)  metricFree.textContent  = '...';
    if (metricPlan)  metricPlan.textContent  = '...';
    if (metricCount) metricCount.textContent = '...';
    if (listingsContainer) listingsContainer.innerHTML =
      '<p class="dashboard-empty" style="color:#666;">Cargando tus anuncios...</p>';

    // Retry profile up to 5 times — handles cold-start DB reconnects
    let profileData = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        let profileResponse = await fetchWithTimeout(`/api/users/${user.uid}`);

        // First-ever login: profile may not exist — create it then retry
        if (profileResponse.status === 404) {
          const regData = JSON.parse(sessionStorage.getItem('mcr_reg') || '{}');
          sessionStorage.removeItem('mcr_reg');
          await fetchWithTimeout('/api/users/ensure', {
            method: 'POST',
            body: JSON.stringify({
              email:     user.email,
              nombre:    regData.nombre    || '',
              apellido:  regData.apellido  || '',
              phone:     regData.phone     || '',
              provincia: regData.provincia || '',
            }),
          });
          profileResponse = await fetchWithTimeout(`/api/users/${user.uid}`);
        }

        const data = await profileResponse.json();
        if (data && data.user) { profileData = data; break; }
        throw new Error('No user in response');
      } catch (err) {
        console.warn(`Dashboard profile attempt ${attempt} failed:`, err.message);
        if (attempt < 5) await new Promise(r => setTimeout(r, 600 * attempt));
      }
    }

    // ── Profile API failed — show fallback metrics + still try listings ───────
    if (!profileData) {
      const isOwnerUser = user.email === OWNER_EMAIL;
      if (metricCount) metricCount.textContent = '0';
      if (metricPlan)  metricPlan.textContent  = isOwnerUser ? 'Pro' : 'Gratis';
      if (metricFree)  metricFree.textContent  = isOwnerUser ? 'Ilimitadas' : String(FREE_LIMIT);
      if (upgradeSection) upgradeSection.classList.toggle('hidden', isOwnerUser);

      // Still try to show listings — this endpoint is simpler and may succeed
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
    const profile = profileData.user;
    if (user.email === OWNER_EMAIL) profile.plan = 'pro';
    const listingCount = profileData.listingCount || 0;

    if (metricCount) metricCount.textContent = listingCount;

    const planLabels = { free: 'Gratis', basic: 'Basic', pro: 'Pro' };
    if (metricPlan) metricPlan.textContent = planLabels[profile.plan] || 'Gratis';

    const credits = profile.singlePostCredits || 0;

    if (metricFree) {
      let freeText;
      if (profile.plan === 'pro') {
        freeText = 'Ilimitadas';
      } else if (profile.plan === 'basic') {
        freeText = String(Math.max(0, BASIC_LIMIT - listingCount));
      } else {
        const remaining = Math.max(0, FREE_LIMIT - listingCount);
        freeText = remaining > 0 ? String(remaining)
          : credits > 0 ? `${credits} crédito${credits !== 1 ? 's' : ''}`
          : '0';
      }
      metricFree.textContent = freeText;
    }

    const creditsCard    = document.getElementById('metric-credits-card');
    const metricCredits  = document.getElementById('metric-credits');
    if (creditsCard && profile.plan === 'free') {
      creditsCard.style.display = '';
      if (metricCredits) metricCredits.textContent = credits;
    }

    if (upgradeSection) upgradeSection.classList.toggle('hidden', profile.plan === 'pro');

    if (!listingsContainer) return;

    const listings = await loadListings(user.uid);
    if (!listings.length) {
      listingsContainer.innerHTML =
        '<p class="dashboard-empty">Aún no has publicado nada. <a href="/publish">Publica tu primer anuncio gratis →</a></p>';
      return;
    }

    renderListings(listings, listingsContainer);
  };

  function applyOwnerUI() {
    if (metricPlan)  metricPlan.textContent  = 'Pro';
    if (metricFree)  metricFree.textContent  = 'Ilimitadas';
    if (upgradeSection) upgradeSection.classList.add('hidden');
  }

  auth.onAuthStateChanged((user) => {
    if (!user) { window.location.href = '/login'; return; }
    if (user.email === OWNER_EMAIL) applyOwnerUI();

    loadDashboard(user).catch(err => {
      console.error(err);
      if (user.email === OWNER_EMAIL) applyOwnerUI();
      else {
        if (metricFree)  metricFree.textContent  = String(FREE_LIMIT);
        if (metricPlan)  metricPlan.textContent  = 'Gratis';
        if (metricCount) metricCount.textContent = '0';
        if (listingsContainer) listingsContainer.innerHTML =
          '<p class="dashboard-empty">Error al cargar el panel. <a href="" onclick="location.reload();return false;">Recarga la página →</a></p>';
      }
    });
  });

  if (upgradeButton) {
    upgradeButton.addEventListener('click', async () => {
      const user = auth.currentUser;
      if (!user) { window.location.href = '/login'; return; }
      try {
        upgradeButton.disabled = true;
        upgradeButton.textContent = 'Procesando...';
        const response = await authFetch('/api/payment/create-checkout-session', {
          method: 'POST',
          body: JSON.stringify({ type: 'pro' }),
        });
        const session = await response.json();
        if (session.url) {
          window.location.href = session.url;
        } else {
          alert('Error al iniciar el pago.');
          upgradeButton.disabled = false;
          upgradeButton.textContent = 'Hacerme Pro';
        }
      } catch (error) {
        console.error('Error:', error);
        alert('No se pudo conectar con el servidor.');
        upgradeButton.disabled = false;
        upgradeButton.textContent = 'Hacerme Pro';
      }
    });
  }
});
