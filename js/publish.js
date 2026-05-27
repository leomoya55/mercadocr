document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('publish-form');
  const submitButton = document.getElementById('submit-button');
  const statusBox = document.getElementById('publish-status');
  const paymentsBox = document.getElementById('publish-payments');
  const paymentButton = document.getElementById('payment-button');
  const basicButton  = document.getElementById('basic-button');
  const proButton    = document.getElementById('pro-button');

  const FREE_LIMIT  = 3;
  const BASIC_LIMIT = 25;

  const startCheckout = async (type, btn) => {
    const user = auth.currentUser;
    if (!user) { window.location.href = '/login'; return; }
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
    window.history.replaceState({}, document.title, '/publish');
    if (statusBox) statusBox.textContent = 'Pago cancelado. Puedes intentarlo de nuevo cuando quieras.';
  } else if (urlParams.get('payment_success') === 'true' && returnType === 'single') {
    window.history.replaceState({}, document.title, '/publish');
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
      window.location.href = '/dashboard';
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
    if (!user) { window.location.href = '/login'; return; }
    currentUser = user;
    setStatus('Verificando tu plan...');

    try {
      editId = new URLSearchParams(window.location.search).get('edit');
      await initEditMode(user.uid);
      if (isEditMode) return;

      const profileData = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
      const profile = profileData.user;
      if (!profile) throw new Error('Could not load profile');
      const listingCount = profileData.listingCount || 0;
      const credits = profile.singlePostCredits || 0;

      if (profile.plan === 'pro') {
        setStatus('Plan Pro · Publica sin límites.');
        showForm();
      } else if (profile.plan === 'basic') {
        if (listingCount >= BASIC_LIMIT) {
          setStatus(`Alcanzaste el límite de ${BASIC_LIMIT} anuncios del plan Basic. Mejora a Pro o compra una publicación individual.`);
          showPayments();
        } else {
          setStatus(`Plan Basic · ${listingCount}/${BASIC_LIMIT} anuncios activos.`);
          showForm();
        }
      } else {
        if (listingCount < FREE_LIMIT) {
          setStatus(`Plan Gratuito · ${listingCount}/${FREE_LIMIT} anuncios activos.`);
          showForm();
        } else if (credits > 0) {
          setStatus(`Tienes ${credits} crédito${credits > 1 ? 's' : ''} de publicación disponible${credits > 1 ? 's' : ''}.`);
          showForm();
        } else {
          setStatus(`Alcanzaste el límite de ${FREE_LIMIT} anuncios gratuitos. Elige cómo continuar:`);
          showPayments();
        }
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

      try {
        const endpoint = isEditMode
          ? `/api/listings/update/${editId}`
          : '/api/listings/add';

        const response = await authFetch(endpoint, { method: 'POST', body: formData });

        if (response.ok) {
          alert(isEditMode ? 'Anuncio actualizado con exito.' : 'Anuncio publicado con exito!');
          window.location.href = '/dashboard';
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
