document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('publish-form');
  const submitButton = document.getElementById('submit-button');
  const statusBox = document.getElementById('publish-status');
  const paymentsBox = document.getElementById('publish-payments');
  const paymentButton = document.getElementById('payment-button');
  const basicButton  = document.getElementById('basic-button');
  const proButton    = document.getElementById('pro-button');

  const FREE_LIMIT  = 3;
  const BASIC_LIMIT = 20;

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
  const returnedFromPayment = urlParams.get('payment_success') === 'true';
  if (urlParams.get('payment_canceled') === 'true') {
    window.history.replaceState({}, document.title, '/publish');
    if (statusBox) statusBox.textContent = 'Pago cancelado. Puedes intentarlo de nuevo cuando quieras.';
  } else if (returnedFromPayment && urlParams.get('type') === 'single') {
    window.history.replaceState({}, document.title, '/publish');
    if (statusBox) statusBox.textContent = 'Pago recibido. Cargando tu plan...';
  }

  let currentUser = null;
  let isEditMode = false;
  let editId = null;

  const subtitle = document.getElementById('publish-subtitle');
  const setStatus = (text) => { if (statusBox) statusBox.textContent = text; };
  const showForm = () => { form?.classList.remove('hidden'); paymentsBox?.classList.add('hidden'); };
  const showPayments = () => { form?.classList.add('hidden'); paymentsBox?.classList.remove('hidden'); };

  function setSubtitle(plan, listingCount) {
    if (!subtitle) return;
    if (plan === 'pro') {
      subtitle.textContent = 'Tu plan Pro te da publicaciones ilimitadas con destacado automático en todos tus anuncios.';
    } else if (plan === 'basic') {
      const remaining = Math.max(0, BASIC_LIMIT - listingCount);
      subtitle.textContent = `Tu plan Basic incluye hasta ${BASIC_LIMIT} anuncios activos. Te quedan ${remaining} publicación${remaining !== 1 ? 'es' : ''} disponible${remaining !== 1 ? 's' : ''}.`;
    } else {
      const remaining = Math.max(0, 3 - listingCount);
      if (remaining > 0) {
        subtitle.textContent = `Plan gratuito · ${remaining} de 3 anuncios gratuitos disponibles. Publica, vende, y reutiliza el espacio cuando quieras.`;
      } else {
        subtitle.textContent = 'Alcanzaste el límite de 3 anuncios gratuitos. Elige una opción para continuar publicando.';
      }
    }
  }

  // Show form optimistically — swapped to payments only if plan check requires it
  showForm();

  function applyPlanUI(plan, listingCount, credits) {
    setSubtitle(plan, listingCount);
    if (plan === 'pro') {
      setStatus('');
      showForm();
    } else if (plan === 'basic') {
      if (listingCount >= BASIC_LIMIT) {
        setStatus(`Alcanzaste el límite de ${BASIC_LIMIT} anuncios del plan Basic. Mejora a Pro o compra una publicación individual.`);
        showPayments();
      } else {
        setStatus('');
        showForm();
      }
    } else {
      if (listingCount < FREE_LIMIT) {
        setStatus('');
        showForm();
      } else if (credits > 0) {
        setStatus(`Tienes ${credits} crédito${credits > 1 ? 's' : ''} de publicación disponible${credits > 1 ? 's' : ''}.`);
        showForm();
      } else {
        setStatus('');
        showPayments();
      }
    }
  }

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

  const OWNER_EMAIL = 'leomoyawr300@gmail.com';

  auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = '/login'; return; }
    currentUser = user;

    // Owner: set Pro subtitle immediately, no API call needed
    if (user.email === OWNER_EMAIL) setSubtitle('pro', 0);

    editId = new URLSearchParams(window.location.search).get('edit');
    await initEditMode(user.uid);
    if (isEditMode) return;

    // Show cached plan instantly while fresh data loads
    // Skip cache when returning from payment so updated credits are fetched
    const cacheKey = `mcr_plan_${user.uid}`;
    if (returnedFromPayment) sessionStorage.removeItem(cacheKey);
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached && (Date.now() - cached.ts) < 120000) {
      applyPlanUI(cached.plan, cached.listingCount, cached.credits);
    }

    try {
      const profileData = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
      const profile = profileData.user;
      if (!profile) throw new Error('Could not load profile');
      const listingCount = profileData.listingCount || 0;
      const credits = profile.singlePostCredits || 0;

      sessionStorage.setItem(cacheKey, JSON.stringify({
        plan: profile.plan, listingCount, credits, ts: Date.now(),
      }));

      applyPlanUI(profile.plan, listingCount, credits);
    } catch (err) {
      console.error(err);
      if (!cached) setStatus('Error al verificar tu plan. Por favor recarga la página.');
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
          // Invalidate plan cache so dashboard/publish reload fresh counts
          const cacheKey = `mcr_plan_${currentUser.uid}`;
          sessionStorage.removeItem(cacheKey);
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
