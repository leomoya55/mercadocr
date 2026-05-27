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

  function setPlanBar(plan) {
    const badge = document.getElementById('publish-plan-badge');
    const hint  = document.getElementById('publish-upgrade-hint');
    if (!badge) return;
    const labels = { pro: 'Plan Pro', basic: 'Plan Basic', free: 'Plan Gratis' };
    badge.textContent = labels[plan] || 'Plan Gratis';
    badge.className   = plan === 'pro' ? 'badge-pro' : '';
    if (hint) hint.classList.toggle('hidden', plan === 'pro');
  }

  function setSubtitle(plan, listingCount, credits = 0) {
    if (!subtitle) return;
    if (plan === 'pro') {
      subtitle.textContent = 'Tu plan Pro te da publicaciones ilimitadas con destacado automático en todos tus anuncios.';
    } else if (plan === 'basic') {
      const remaining = Math.max(0, BASIC_LIMIT - listingCount);
      subtitle.textContent = `Tu plan Basic incluye hasta ${BASIC_LIMIT} anuncios activos. Te quedan ${remaining} publicación${remaining !== 1 ? 'es' : ''} disponible${remaining !== 1 ? 's' : ''}.`;
    } else {
      const remaining = Math.max(0, FREE_LIMIT - listingCount);
      if (remaining > 0) {
        subtitle.textContent = `Plan gratuito · ${remaining} de ${FREE_LIMIT} anuncios gratuitos disponibles.`;
      } else if (credits > 0) {
        subtitle.textContent = `Tienes ${credits} crédito${credits !== 1 ? 's' : ''} de publicación individual disponible${credits !== 1 ? 's' : ''}.`;
      } else {
        subtitle.textContent = `Alcanzaste el límite de ${FREE_LIMIT} anuncios gratuitos. Elige una opción para continuar publicando.`;
      }
    }
  }

  // Show form optimistically — swapped to payments only if plan check requires it
  showForm();

  function applyPlanUI(plan, listingCount, credits) {
    setSubtitle(plan, listingCount, credits);
    setPlanBar(plan);
    if (plan === 'pro') {
      showForm();
    } else if (plan === 'basic') {
      if (listingCount >= BASIC_LIMIT) showPayments();
      else showForm();
    } else {
      if (listingCount < FREE_LIMIT || credits > 0) showForm();
      else showPayments();
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
    submitButton.textContent = 'Guardar cambios';
    showForm();
  };

  const OWNER_EMAIL = 'leomoyawr300@gmail.com';

  auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = '/login'; return; }
    currentUser = user;

    // Owner: apply Pro UI immediately — no API call needed
    if (user.email === OWNER_EMAIL) applyPlanUI('pro', 0, 0);

    editId = new URLSearchParams(window.location.search).get('edit');
    await initEditMode(user.uid);
    if (isEditMode) return;

    const cacheKey = `mcr_plan_${user.uid}`;
    if (returnedFromPayment) sessionStorage.removeItem(cacheKey);
    const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
    if (cached && (Date.now() - cached.ts) < 120000) {
      applyPlanUI(cached.plan, cached.listingCount, cached.credits);
      if (user.email === OWNER_EMAIL) applyPlanUI('pro', 0, 0); // re-apply after cache
    }

    // Fetch plan with up to 3 attempts — retries handle cold-start DB delays
    let profileData = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await authFetch(`/api/users/${user.uid}`);
        const data = await res.json();
        if (data.user) { profileData = data; break; }
        throw new Error('No profile in response');
      } catch (err) {
        console.warn(`Plan check attempt ${attempt} failed:`, err.message);
        if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }

    if (profileData) {
      const profile = profileData.user;
      // Owner override: always force Pro regardless of what DB says
      if (user.email === OWNER_EMAIL) profile.plan = 'pro';
      const listingCount = profileData.listingCount || 0;
      const credits = profile.singlePostCredits || 0;

      sessionStorage.setItem(cacheKey, JSON.stringify({
        plan: profile.plan, listingCount, credits, ts: Date.now(),
      }));
      applyPlanUI(profile.plan, listingCount, credits);
    } else {
      // All retries failed — owner still gets Pro, others keep form visible
      if (user.email === OWNER_EMAIL) applyPlanUI('pro', 0, 0);
      console.error('Plan check failed after 3 attempts — server may be starting up');
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
