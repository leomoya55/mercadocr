document.addEventListener('DOMContentLoaded', () => {
  const metricCount = document.getElementById('metric-count');
  const metricFree = document.getElementById('metric-free');
  const metricPlan = document.getElementById('metric-plan');
  const listingsContainer = document.getElementById('dashboard-listings');
  const upgradeSection = document.getElementById('dashboard-upgrade');
  const upgradeButton = document.getElementById('upgrade-pro');

  const FREE_LIMIT  = 3;
  const BASIC_LIMIT = 25;

  const loadDashboard = async (user) => {
    let profileResponse = await authFetch(`/api/users/${user.uid}`);

    // First-ever login: profile may not exist yet — create it then retry
    if (profileResponse.status === 404) {
      await authFetch('/api/users/ensure', {
        method: 'POST',
        body: JSON.stringify({ email: user.email }),
      });
      profileResponse = await authFetch(`/api/users/${user.uid}`);
    }

    const profileData = await profileResponse.json();
    console.log('[dashboard] profile response:', profileData);
    const profile = profileData.user;
    if (!profile) throw new Error('Profile missing: ' + JSON.stringify(profileData));
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
        if (remaining > 0) {
          freeText = String(remaining);
        } else if (credits > 0) {
          freeText = `${credits} crédito${credits !== 1 ? 's' : ''}`;
        } else {
          freeText = '0';
        }
      }
      metricFree.textContent = freeText;
    }

    // Credits card — only for free-plan users
    const creditsCard = document.getElementById('metric-credits-card');
    const metricCredits = document.getElementById('metric-credits');
    if (creditsCard && profile.plan === 'free') {
      creditsCard.style.display = '';
      if (metricCredits) metricCredits.textContent = credits;
    }

    if (upgradeSection) {
      upgradeSection.classList.toggle('hidden', profile.plan === 'pro');
    }

    const listingsResponse = await authFetch(`/api/listings/user/${user.uid}`);
    const listings = await listingsResponse.json();

    if (!listings.length) {
      listingsContainer.innerHTML = '<p class="dashboard-empty">Aún no has publicado nada. <a href="/publish">Publica tu primer anuncio gratis →</a></p>';
      return;
    }

    listingsContainer.innerHTML = '';
    listings.forEach(listing => {
      const card = document.createElement('div');
      card.className = 'listing-item';
      const isSold = listing.status === 'sold';
      const featuredBadge = listing.featured && !isSold ? '<span class="badge-featured">Destacado</span>' : '';
      const soldBadge = isSold ? '<span class="badge-sold">Vendido</span>' : '';
      const editBtn = !isSold ? `<button data-edit="${listing._id}">Editar</button>` : '';
      const markSoldBtn = !isSold ? `<button data-mark-sold="${listing._id}" class="btn-mark-sold">Marcar vendido</button>` : '';

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
      listingsContainer.appendChild(card);
    });

    listingsContainer.querySelectorAll('[data-edit]').forEach(button => {
      button.addEventListener('click', () => {
        window.location.href = `/publish?edit=${button.getAttribute('data-edit')}`;
      });
    });

    listingsContainer.querySelectorAll('[data-mark-sold]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('¿Marcar este anuncio como vendido? Quedará archivado y liberará un espacio para publicar otro.')) return;
        button.disabled = true;
        button.textContent = 'Marcando...';
        try {
          await authFetch(`/api/listings/mark-sold/${button.getAttribute('data-mark-sold')}`, { method: 'POST' });
          window.location.reload();
        } catch {
          button.disabled = false;
          button.textContent = 'Marcar vendido';
        }
      });
    });

    listingsContainer.querySelectorAll('[data-delete]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('¿Seguro que deseas eliminar este anuncio?')) return;
        button.disabled = true;
        button.textContent = 'Eliminando...';
        try {
          await authFetch(`/api/listings/delete/${button.getAttribute('data-delete')}`, { method: 'POST' });
          window.location.reload();
        } catch {
          button.disabled = false;
          button.textContent = 'Eliminar';
        }
      });
    });
  };

  auth.onAuthStateChanged((user) => {
    if (!user) {
      window.location.href = '/login';
      return;
    }
    loadDashboard(user).catch(err => {
      console.error(err);
      if (listingsContainer) listingsContainer.innerHTML = '<p class="dashboard-empty">Error al cargar el panel. Recarga la página.</p>';
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
