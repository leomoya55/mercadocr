document.addEventListener('DOMContentLoaded', () => {
  const productDetailContainer = document.getElementById('product-detail');
  const params = new URLSearchParams(window.location.search);
  const productId = params.get('id');

  productDetailContainer.innerHTML = '<div class="loading">Cargando producto...</div>';

  if (!productId) {
    productDetailContainer.innerHTML = '<p>Producto no encontrado.</p>';
    return;
  }

  fetch(API_BASE_URL + `/api/listings/${productId}`)
    .then(response => response.json())
    .then(product => {
      if (!product || !product._id) {
        productDetailContainer.innerHTML = '<p>Producto no encontrado.</p>';
        return;
      }

      const featuredBadge = product.featured ? '<span class="badge-featured">Destacado</span>' : '';
      const photos = (product.photos || [])
        .map(photo => `<img src="${escapeHtml(photo)}" alt="${escapeHtml(product.name)}">`)
        .join('');

      const seller = product.seller;
      const sellerName = seller
        ? `${escapeHtml(seller.nombre || '')} ${escapeHtml(seller.apellido || '')}`.trim() || 'Vendedor'
        : 'Vendedor';

      // WhatsApp link: strip non-digits, prepend Costa Rica code +506
      let whatsappBtn = '';
      if (seller && seller.phone) {
        const digits = seller.phone.replace(/\D/g, '');
        if (digits.length >= 8) {
          const waNumber = digits.startsWith('506') ? digits : `506${digits}`;
          whatsappBtn = `
            <a href="https://wa.me/${waNumber}" target="_blank" rel="noopener" class="contact-button whatsapp-btn">
              Contactar por WhatsApp
            </a>`;
        }
      }

      productDetailContainer.innerHTML = `
        <div class="product-grid">
          <div class="product-images">${photos}</div>
          <div class="product-info">
            <h1>${escapeHtml(product.name)} ${featuredBadge}</h1>
            <div class="product-price">₡${Number(product.price).toLocaleString('es-CR')}</div>

            <div class="product-description">
              <h3>Descripción</h3>
              <p>${escapeHtml(product.description)}</p>
            </div>

            ${product.provincia ? `<div class="product-location"><h3>Ubicación</h3><p>📍 ${escapeHtml(product.provincia)}</p></div>` : ''}

            <div class="product-seller">
              <h3>Vendedor</h3>
              <p>${sellerName}${seller && seller.provincia ? ` · ${escapeHtml(seller.provincia)}` : ''}</p>
              ${seller && seller.phone ? `<p class="seller-phone">📞 ${escapeHtml(seller.phone)}</p>` : ''}
            </div>

            ${whatsappBtn}
          </div>
        </div>
      `;
    })
    .catch(err => {
      console.error(err);
      productDetailContainer.innerHTML = '<p>Error al cargar el producto.</p>';
    });
});
