document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('publish-form');
  const submitButton = document.getElementById('submit-button');
  const statusBox = document.getElementById('publish-status');
  const paymentsBox = document.getElementById('publish-payments');
  const paymentButton = document.getElementById('payment-button');
  const basicButton  = document.getElementById('basic-button');
  const proButton    = document.getElementById('pro-button');

  const startCheckout = async (type, btn) => {
    const user = auth.currentUser;
    if (!user) { window.location.href = 'login.html'; return; }
    const originalText = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Procesando...';
      const response = await authFetch('/api/payment/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ type }),
      });
      const session = await response.json();
      if (session.url) {
        window.location.href = session.url;
      } else {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    } catch {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  };

  paymentButton?.addEventListener('click', () => startCheckout('single', paymentButton));
  basicButton?.addEventListener('click',   () => startCheckout('basic',  basicButton));
  proButton?.addEventListener('click',     () => startCheckout('pro',    proButton));

  const urlParams = new URLSearchParams(window.location.search);
  const returnType = urlParams.get('type');
  if (urlParams.get('payment_canceled') === 'true') {
    window.history.replaceState({}, document.title, 'publish.html');
    if (statusBox) statusBox.textContent = 'Pago cancelado. Puedes intentarlo de nuevo cuando quieras.';
  } else if (urlParams.get('payment_success') === 'true' && returnType === 'single') {
    window.history.replaceState({}, document.title, 'publish.html');
    if (statusBox) statusBox.textContent = 'Pago recibido. Cargando tu plan...';
  }

  let currentUser = null;
  let isEditMode = false;
  let editId = null;

  const setStatus = (text) => { if (statusBox) statusBox.textContent = text; };
  const showForm = () => { form?.classList.remove('hidden'); paymentsBox?.classList.add('hidden'); };
  const showPayments = () => { form?.classList.add('hidden'); paymentsBox?.classList.remove('hidden'); };

  const initEditMode = async (uid) => {
    if (!editId) return;

    const response = await fetch(API_BASE_URL + `/api/listings/${editId}`);
    const listing = await response.json();
    if (!listing || listing.author !== uid) {
      alert('No tienes permisos para editar este anuncio.');
      window.location.href = 'dashboard.html';
      return;
    }
    isEditMode = true;
    form.name.value = listing.name;
    form.description.value = listing.description;
    form.price.value = listing.price;
    form.category.value = listing.category;
    form.provincia.value = listing.provincia || '';
    form.contact.value = listing.contact;
    submitButton.textContent = 'Guardar cambios';
    showForm();
  };

  auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = 'login.html'; return; }
    currentUser = user;
    setStatus('Verificando tu plan...');

    try {
      await authFetch('/api/users/ensure', {
        method: 'POST',
        body: JSON.stringify({ email: user.email }),
      });

      editId = new URLSearchParams(window.location.search).get('edit');
      await initEditMode(user.uid);
      if (isEditMode) return;

      const profileData = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
      const profile = profileData.user;
      if (!profile) throw new Error('Could not load profile');
      const listingCount = profileData.listingCount || 0;

      const credits = profile.singlePostCredits || 0;

      if (profile.plan === 'pro') {
        setStatus('Plan Pro activo. Puedes publicar sin límites.');
        showForm();
      } else if (profile.plan === 'basic') {
        if (listingCount >= 20) {
          setStatus('Alcanzaste el límite de 20 anuncios del plan Basic. Mejora a Pro o compra una publicación individual.');
          showPayments();
        } else {
          setStatus(`Plan Basic activo. Anuncios: ${listingCount}/20.`);
          showForm();
        }
      } else if (!profile.freeListingUsed) {
        setStatus('Tu primer anuncio es completamente gratis.');
        showForm();
      } else if (credits > 0) {
        setStatus(`Tienes ${credits} publicación${credits > 1 ? 'es' : ''} adicional${credits > 1 ? 'es' : ''} disponible${credits > 1 ? 's' : ''}.`);
        showForm();
      } else {
        setStatus('Elige cómo quieres publicar tu próximo anuncio.');
        showPayments();
      }
    } catch (err) {
      console.error(err);
      setStatus('Error al verificar tu plan. Por favor recarga la página.');
    }
  });

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentUser) { alert('Debes iniciar sesion para publicar.'); return; }

      submitButton.disabled = true;
      submitButton.textContent = 'Publicando...';

      const formData = new FormData(form);
      // author is derived from the verified token on the server — do not send uid in body

      try {
        const endpoint = isEditMode
          ? `/api/listings/update/${editId}`
          : '/api/listings/add';

        const response = await authFetch(endpoint, { method: 'POST', body: formData });

        if (response.ok) {
          alert(isEditMode ? 'Anuncio actualizado con exito.' : 'Anuncio publicado con exito!');
          window.location.href = 'dashboard.html';
        } else if (response.status === 402) {
          setStatus('Necesitas un plan para publicar mas anuncios.');
          showPayments();
        } else {
          const errorData = await response.text();
          alert('Error al publicar: ' + errorData);
        }
      } catch (error) {
        console.error('Error:', error);
        alert('Ocurrio un error al publicar.');
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = isEditMode ? 'Guardar cambios' : 'Publicar';
      }
    });
  }
});
