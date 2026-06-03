document.addEventListener('DOMContentLoaded', () => {
  const featuredListingsContainer = document.querySelector('.featured-listings .listings-grid');
  const featuredSection = document.querySelector('.featured-listings');

  if (featuredListingsContainer) {
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.textContent = 'Cargando anuncios destacados...';
    featuredSection.appendChild(loading);

    // Home "Anuncios destacados" shows ONLY genuinely featured listings (paid
    // boosts or admin/editorial). If there are none yet, we DON'T pass off the
    // newest listings as "destacados" — instead we relabel the section heading to
    // "Anuncios recientes" so nothing is ever mislabeled as featured.
    const heading = featuredSection.querySelector('h2');
    const pick = (data) => {
      const list = Array.isArray(data) ? data : (data.listings || []);
      return list;
    };
    fetch(API_BASE_URL + '/api/listings?featured=true&limit=4')
      .then(r => r.json())
      .then(data => {
        const featuredOnly = pick(data);
        if (featuredOnly.length) return featuredOnly;
        // Nothing featured yet: relabel and show the newest as plain recent items.
        if (heading) heading.textContent = 'Anuncios recientes';
        return fetch(API_BASE_URL + '/api/listings?limit=4').then(r => r.json()).then(pick);
      })
      .then(list => {
        loading.remove();
        const featured = list.slice(0, 4);
        // Hide the whole section if there are no listings at all.
        if (!featured.length) { featuredSection.classList.add('hidden'); return; }
        featured.forEach(listing => {
          const listingElement = document.createElement('a');
          listingElement.href = `/product?id=${listing._id}`;
          listingElement.classList.add('listing-item');
          const isJob = listing.category === 'Empleos';
          const featuredBadge = listing.featured ? '<span class="badge-featured">Destacado</span>' : '';
          const photo = listing.photos && listing.photos[0] ? escapeHtml(cldAuto(listing.photos[0])) : '';
          const imgHtml = photo
            ? `<img src="${photo}" alt="${escapeHtml(listing.name)}" loading="lazy">`
            : `<div class="listing-noimg" aria-hidden="true">${isJob ? '💼' : '🛍️'}</div>`;
          const priceHtml = isJob
            ? `<div class="listing-item-price">${escapeHtml(listing.job && listing.job.salary ? listing.job.salary : 'Empleo')}</div>`
            : `<div class="listing-item-price">₡${Number(listing.price).toLocaleString('es-CR')}</div>`;
          listingElement.innerHTML = `
            ${imgHtml}
            <div class="listing-item-content">
              <div class="listing-item-title">${escapeHtml(listing.name)}</div>
              <div class="listing-item-meta">
                ${priceHtml}
                ${featuredBadge}
              </div>
              ${listing.provincia ? `<div class="listing-item-location">📍 ${escapeHtml(listing.provincia)}</div>` : ''}
            </div>
          `;
          featuredListingsContainer.appendChild(listingElement);
        });
      })
      .catch(error => console.error('Error fetching featured listings:', error));
  }
});
