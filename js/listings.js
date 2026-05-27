document.addEventListener('DOMContentLoaded', () => {
  const listingsContainer = document.getElementById('listings-container');
  const listingsPage = document.querySelector('.listings-page');
  let allListings = [];

  if (!listingsContainer) return;

  function displayListings(listings) {
    listingsContainer.innerHTML = '';
    listings.forEach(listing => {
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
      listingsContainer.appendChild(listingElement);
    });
  }

  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = 'Cargando anuncios...';
  listingsPage.insertBefore(loading, listingsContainer);

  fetch(API_BASE_URL + '/api/listings')
    .then(response => response.json())
    .then(data => {
      allListings = data;
      loading.remove();
      displayListings(allListings);
    })
    .catch(error => console.error('Error fetching listings:', error));

  const filterButton = document.getElementById('filter-button');
  filterButton.addEventListener('click', () => {
    const minPrice = parseFloat(document.getElementById('min-price').value);
    const maxPrice = parseFloat(document.getElementById('max-price').value);
    let filtered = allListings;
    if (!isNaN(minPrice)) filtered = filtered.filter(l => l.price >= minPrice);
    if (!isNaN(maxPrice)) filtered = filtered.filter(l => l.price <= maxPrice);
    displayListings(filtered);
  });

  document.querySelectorAll('.category-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const category = e.target.dataset.category;
      displayListings(category ? allListings.filter(l => l.category === category) : allListings);
    });
  });
});
