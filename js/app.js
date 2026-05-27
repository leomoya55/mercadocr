document.addEventListener('DOMContentLoaded', () => {
  const featuredListingsContainer = document.querySelector('.featured-listings .listings-grid');
  const featuredSection = document.querySelector('.featured-listings');

  if (featuredListingsContainer) {
    const loading = document.createElement('div');
    loading.className = 'loading';
    loading.textContent = 'Cargando anuncios destacados...';
    featuredSection.appendChild(loading);

    fetch(API_BASE_URL + '/api/listings')
      .then(response => response.json())
      .then(listings => {
        loading.remove();
        const featured = listings.slice(0, 4);
        featured.forEach(listing => {
          const listingElement = document.createElement('a');
          listingElement.href = `product.html?id=${listing._id}`;
          listingElement.classList.add('listing-item');
          const featuredBadge = listing.featured ? '<span class="badge-featured">Destacado</span>' : '';
          listingElement.innerHTML = `
            <img src="${escapeHtml(listing.photos[0])}" alt="${escapeHtml(listing.name)}">
            <div class="listing-item-content">
              <div class="listing-item-title">${escapeHtml(listing.name)}</div>
              <div class="listing-item-meta">
                <div class="listing-item-price">₡${Number(listing.price).toLocaleString('es-CR')}</div>
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
