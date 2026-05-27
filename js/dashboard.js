document.addEventListener('DOMContentLoaded', () => {
  const metricCount = document.getElementById('metric-count');
  const metricFree = document.getElementById('metric-free');
  const metricPlan = document.getElementById('metric-plan');
  const listingsContainer = document.getElementById('dashboard-listings');
  const loading = document.getElementById('dashboard-loading');
  const upgradeSection = document.getElementById('dashboard-upgrade');
  const upgradeButton = document.getElementById('upgrade-pro');

  const loadDashboard = async (user) => {
    await authFetch('/api/users/ensure', {
      method: 'POST',
      body: JSON.stringify({ email: user.email }),
    });

    const profileResponse = await authFetch(`/api/users/${user.uid}`);
    const profileData = await profileResponse.json();
    const profile = profileData.user;
    const listingCount = profileData.listingCount || 0;

    if (metricCount) metricCount.textContent = listingCount;

    const planLabels = { free: 'Gratis', basic: 'Basic', pro: 'Pro' };
    if (metricPlan) metricPlan.textContent = planLabels[profile.plan] || 'Gratis';

    // "Publicaciones disponibles" metric
    if (metricFree) {
      if (profile.plan === 'pro') {
        metricFree.textContent = 'Ilimitadas';
      } else if (profile.plan === 'basic') {
        metricFree.textContent = `${listingCount}/20`;
      } else if (!profile.freeListingUsed) {
        metricFree.textContent = '1 gratis';
      } else {
        metricFree.textContent = 'Ninguna';
      }
    }

    // Credits card — only show for free-plan users
    const credits = profile.singlePostCredits || 0;
    const creditsCard = document.getElementById('metric-credits-card');
    const metricCredits = document.getElementById('metric-credits');
    if (creditsCard && profile.plan === 'free') {
      creditsCard.style.display = '';
      if (metricCredits) metricCredits.textContent = credits;
    }

    if (upgradeSection) {
      upgradeSection.classList.toggle('hidden', profile.plan === 'pro');
    }

    if (loading) loading.classList.remove('hidden');
    const listingsResponse = await authFetch(`/api/listings/user/${user.uid}`);
    const listings = await listingsResponse.json();
    if (loading) loading.classList.add('hidden');

    if (!listings.length) {
      listingsContainer.innerHTML = '<div class="loading">Aun no tienes anuncios publicados. <a href="publish.html">Publica tu primer anuncio gratis</a></div>';
      return;
    }

    listingsContainer.innerHTML = '';
    listings.forEach(listing => {
      const card = document.createElement('div');
      card.className = 'listing-item';
      const featuredBadge = listing.featured ? '<span class="badge-featured">Destacado</span>' : '';
      card.innerHTML = `
        <img src="${escapeHtml(listing.photos[0])}" alt="${escapeHtml(listing.name)}">
        <div class="listing-item-content">
          <div class="listing-item-title">${escapeHtml(listing.name)}</div>
          <div class="listing-item-meta">
            <div class="listing-item-price">₡${Number(listing.price).toLocaleString('es-CR')}</div>
            ${featuredBadge}
          </div>
          ${listing.provincia ? `<div class="listing-item-location">📍 ${escapeHtml(listing.provincia)}</div>` : ''}
          <div class="dashboard-actions">
            <button data-edit="${listing._id}">Editar</button>
            <button data-delete="${listing._id}">Eliminar</button>
          </div>
        </div>
      `;
      listingsContainer.appendChild(card);
    });

    listingsContainer.querySelectorAll('[data-edit]').forEach(button => {
      button.addEventListener('click', () => {
        window.location.href = `publish.html?edit=${button.getAttribute('data-edit')}`;
      });
    });

    listingsContainer.querySelectorAll('[data-delete]').forEach(button => {
      button.addEventListener('click', async () => {
        if (!confirm('¿Seguro que deseas eliminar este anuncio?')) return;
        await authFetch(`/api/listings/delete/${button.getAttribute('data-delete')}`, {
          method: 'POST',
        });
        window.location.reload();
      });
    });
  };

  auth.onAuthStateChanged((user) => {
    if (!user) {
      window.location.href = 'login.html';
      return;
    }
    loadDashboard(user).catch(err => {
      console.error(err);
      if (loading) loading.textContent = 'Error al cargar el panel.';
    });
  });

  if (upgradeButton) {
    upgradeButton.addEventListener('click', async () => {
      const user = auth.currentUser;
      if (!user) { window.location.href = 'login.html'; return; }
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
