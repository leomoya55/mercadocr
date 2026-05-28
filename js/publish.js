document.addEventListener('DOMContentLoaded', () => {
  const form          = document.getElementById('publish-form');
  const submitButton  = document.getElementById('submit-button');
  const statusBox     = document.getElementById('publish-status');
  const paymentsBox   = document.getElementById('publish-payments');
  const paymentButton = document.getElementById('payment-button');
  const basicButton   = document.getElementById('basic-button');
  const proButton     = document.getElementById('pro-button');

  const OWNER_EMAIL = 'leomoyawr300@gmail.com';

  // ─── Checkout helpers ─────────────────────────────────────────────────────
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

  // ─── URL flags ────────────────────────────────────────────────────────────
  const urlParams           = new URLSearchParams(window.location.search);
  const returnedFromPayment = urlParams.get('payment_success') === 'true';

  if (urlParams.get('payment_canceled') === 'true') {
    window.history.replaceState({}, document.title, '/publish');
    if (statusBox) statusBox.textContent = 'Pago cancelado. Puedes intentarlo de nuevo cuando quieras.';
  } else if (returnedFromPayment && urlParams.get('type') === 'single') {
    window.history.replaceState({}, document.title, '/publish');
    if (statusBox) statusBox.textContent = 'Pago recibido. Cargando tu plan...';
  }

  let currentUser = null;
  let isEditMode  = false;
  let editId      = null;

  const subtitle  = document.getElementById('publish-subtitle');
  const setStatus = (text) => { if (statusBox) statusBox.textContent = text; };
  const showForm     = () => { form?.classList.remove('hidden'); paymentsBox?.classList.add('hidden'); };
  const showPayments = () => { form?.classList.add('hidden');   paymentsBox?.classList.remove('hidden'); };

  // ─── Plan UI helpers ──────────────────────────────────────────────────────

  function setPlanBar(plan) {
    const badge = document.getElementById('publish-plan-badge');
    const hint  = document.getElementById('publish-upgrade-hint');
    if (!badge) return;
    const labels = { pro: 'Plan Pro', basic: 'Plan Basic', free: 'Plan Gratis' };
    badge.textContent = labels[plan] || 'Plan Gratis';
    badge.className   = plan === 'pro' ? 'badge-pro' : '';
    if (hint) hint.classList.toggle('hidden', plan === 'pro');
  }

  /**
   * Build the subtitle text from server-computed values.
   * Frontend never computes limits — it uses what the API returned.
   *
   * @param {string}      plan
   * @param {number}      listingCount
   * @param {number|null} remaining    — null = unlimited (Pro)
   * @param {number}      maxListings  — null = unlimited
   * @param {number}      credits
   */
  function setSubtitle(plan, listingCount, remaining, maxListings, credits) {
    if (!subtitle) return;
    if (plan === 'pro' || remaining === null) {
      subtitle.textContent = 'Tu plan Pro te da publicaciones ilimitadas con destacado automático en todos tus anuncios.';
    } else if (remaining > 0) {
      subtitle.textContent = `Plan ${plan === 'basic' ? 'Basic' : 'gratuito'} · ${remaining} de ${maxListings} anuncio${maxListings !== 1 ? 's' : ''} disponible${remaining !== 1 ? 's' : ''}.`;
    } else if (credits > 0) {
      subtitle.textContent = `Tienes ${credits} crédito${credits !== 1 ? 's' : ''} de publicación individual disponible${credits !== 1 ? 's' : ''}.`;
    } else {
      subtitle.textContent = `Alcanzaste el límite de ${maxListings} anuncio${maxListings !== 1 ? 's' : ''} de tu plan. Elige una opción para continuar publicando.`;
    }
  }

  // Show form optimistically — swapped to payments only if backend says limit reached
  showForm();

  function applyPlanUI(plan, listingCount, remaining, maxListings, credits) {
    setSubtitle(plan, listingCount, remaining, maxListings, credits);
    setPlanBar(plan);

    if (plan === 'pro' || remaining === null) {
      showForm();
    } else if (remaining > 0 || credits > 0) {
      showForm();
    } else {
      showPayments();
    }
  }

  const initEditMode = async (uid) => {
    if (!editId) return;
    const response = await fetch(API_BASE_URL + `/api/listings/${editId}`);
    const listing  = await response.json();
    if (!listing || listing.author !== uid) {
      alert('No tienes permisos para editar este anuncio.');
      window.location.href = '/dashboard';
      return;
    }
    isEditMode = true;
    form.name.value        = listing.name;
    form.description.value = listing.description;
    form.price.value       = listing.price;
    form.category.value    = listing.category;
    submitButton.textContent = 'Guardar cambios';
    showForm();
  };

  // ─── Auth state ───────────────────────────────────────────────────────────
  auth.onAuthStateChanged(async (user) => {
    if (!user) { window.location.href = '/login'; return; }
    currentUser = user;

    // Owner: apply Pro UI immediately — no API call needed
    if (user.email === OWNER_EMAIL) applyPlanUI('pro', 0, null, null, 0);

    editId = new URLSearchParams(window.location.search).get('edit');
    await initEditMode(user.uid);
    if (isEditMode) return;

    // Invalidate UserStore cache if returning from a payment flow
    if (returnedFromPayment) UserStore.invalidate();

    let profileData = null;
    try {
      profileData = await UserStore.getProfile(user, returnedFromPayment);
    } catch (err) {
      console.warn('Publish plan check failed:', err.message);
    }

    if (profileData) {
      const profile      = profileData.user;
      const listingCount = profileData.listingCount || 0;
      const remaining    = profileData.remaining;      // server-computed
      const maxListings  = profileData.maxListings;    // server-computed
      const credits      = profileData.credits || 0;
      applyPlanUI(profile.plan, listingCount, remaining, maxListings, credits);
    } else {
      // All retries failed — show safe defaults so the page is always usable
      applyPlanUI(user.email === OWNER_EMAIL ? 'pro' : 'free', 0, 3, 3, 0);
    }
  });

  // ─── Publish form submit ──────────────────────────────────────────────────
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentUser) { alert('Debes iniciar sesión para publicar.'); return; }

      submitButton.disabled = true;
      submitButton.textContent = 'Publicando...';

      const formData = new FormData(form);

      try {
        const endpoint = isEditMode
          ? `/api/listings/update/${editId}`
          : '/api/listings/add';

        const response = await authFetch(endpoint, { method: 'POST', body: formData });

        if (response.ok) {
          UserStore.invalidate();
          alert(isEditMode ? 'Anuncio actualizado con éxito.' : '¡Anuncio publicado con éxito!');
          window.location.href = '/dashboard';

        } else if (response.status === 402) {
          // Backend enforced the limit — parse structured error for better prompt
          const errData = await response.json().catch(() => ({}));
          let msg = 'Alcanzaste el límite de publicaciones de tu plan.';
          if (errData.code === 'LIMIT_REACHED' && errData.maxListings) {
            const planLabel = { free: 'gratuito', basic: 'Basic', pro: 'Pro' }[errData.plan] || errData.plan;
            msg = `Alcanzaste el límite de ${errData.maxListings} anuncios del plan ${planLabel}.`;
          }
          setStatus(msg);
          showPayments();

        } else {
          const errorData = await response.text();
          alert('Error al publicar: ' + errorData);
        }
      } catch (error) {
        console.error('Error:', error);
        alert('Ocurrió un error al publicar.');
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = isEditMode ? 'Guardar cambios' : 'Publicar';
      }
    });
  }
});
