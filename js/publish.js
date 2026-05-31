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

    // Friendly guard: don't start checkout if already on this plan
    const cached = UserStore.current;
    if (type !== 'single' && cached?.user?.plan === type) {
      const label = type === 'pro' ? 'Pro' : 'Basic';
      Toast.info(`¡Ya tienes el plan ${label} activo! No necesitas volver a comprarlo.`);
      return;
    }

    const originalText = btn.textContent;
    try {
      btn.disabled = true;
      btn.textContent = 'Procesando...';
      const response = await authFetch('/api/payment/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ type }),
      });
      const data = await response.json();

      if (response.status === 400 && data.error === 'already_on_plan') {
        Toast.info(data.message || '¡Ya tienes este plan activo!');
        btn.disabled = false;
        btn.textContent = originalText;
        return;
      }

      // Proration: backend changed the tier on the existing subscription in-place.
      if (data.upgraded) {
        UserStore.invalidate();
        Toast.success(`Tu plan cambió a ${type === 'pro' ? 'Pro' : 'Basic'}. El cobro se prorrateó.`);
        setTimeout(() => window.location.reload(), 1400);
        return;
      }

      if (data.url) {
        window.location.href = data.url;
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

  // ─── Form enhancements ────────────────────────────────────────────────────
  const priceInput = document.getElementById('price');
  const priceHidden = document.getElementById('price-hidden');
  const descriptionInput = document.getElementById('description');
  const descriptionCounter = document.getElementById('description-counter');
  const minDescriptionLength = 20;

  if (priceInput && priceHidden) {
    priceInput.addEventListener('input', () => {
      const rawValue = priceInput.value.replace(/[^0-9]/g, '');
      const numberValue = parseInt(rawValue, 10);

      if (isNaN(numberValue)) {
        priceInput.value = '';
        priceHidden.value = '';
      } else {
        priceInput.value = numberValue.toLocaleString('es-CR');
        priceHidden.value = numberValue;
      }
    });
  }

  if (descriptionInput && descriptionCounter) {
    descriptionInput.addEventListener('input', () => {
      const currentLength = descriptionInput.value.length;
      descriptionCounter.textContent = `${currentLength}/${minDescriptionLength} caracteres`;
      if (currentLength >= minDescriptionLength) {
        descriptionCounter.classList.add('valid');
      } else {
        descriptionCounter.classList.remove('valid');
      }
    });
    // Trigger on load for edit mode
    descriptionInput.dispatchEvent(new Event('input'));
  }


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

  function setSubtitle(plan, listingCount, remaining, maxListings, credits) {
    if (!subtitle) return;
    if (plan === 'pro' || remaining === null) {
      subtitle.textContent = 'Tu plan Pro te da publicaciones ilimitadas.';
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

  // ─── Edit mode ────────────────────────────────────────────────────────────

  const initEditMode = async (uid) => {
    if (!editId) return;
    const response = await fetch(API_BASE_URL + `/api/listings/${editId}`);
    const listing  = await response.json();
    if (!listing || listing.author !== uid) {
      Toast.error('No tienes permisos para editar este anuncio.');
      setTimeout(() => { window.location.href = '/dashboard'; }, 2000);
      return;
    }
    isEditMode = true;
    form.name.value        = listing.name;
    form.description.value = listing.description;
    priceInput.value       = listing.price.toLocaleString('es-CR');
    priceHidden.value      = listing.price;
    form.category.value    = listing.category;
    if (form.condition) form.condition.value = listing.condition || '';
    submitButton.textContent = 'Guardar cambios';
    showForm();
    // Manually trigger input events to update counters
    descriptionInput.dispatchEvent(new Event('input'));
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
      const remaining    = profileData.remaining;
      const maxListings  = profileData.maxListings;
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
      if (!currentUser) {
        Toast.error('Debes iniciar sesión para publicar.');
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = 'Publicando...';

      const formData = new FormData(form);
      const listingName = formData.get('name') || '';

      try {
        const endpoint = isEditMode
          ? `/api/listings/update/${editId}`
          : '/api/listings/add';

        const response = await authFetch(endpoint, {
          method: isEditMode ? 'PUT' : 'POST',
          body: formData,
        });

        if (response.ok) {
          UserStore.invalidate();

          if (isEditMode) {
            // Edit: toast + redirect back to dashboard
            Toast.success('Anuncio actualizado con éxito.');
            setTimeout(() => { window.location.href = '/dashboard'; }, 1800);
          } else {
            // New listing: show success modal with thumbnail + action buttons
            const data = await response.json().catch(() => ({}));
            showPublishSuccess({
              id:    data.id    ? String(data.id) : '',
              name:  data.name  || listingName,
              photo: data.photo || '',
            });
            // Reset the form so "Publish another" starts fresh
            form.reset();
          }

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
          const errorText = await response.text().catch(() => String(response.status));
          Toast.error('Error al publicar. Por favor intenta de nuevo.');
          console.error('[publish] server error:', errorText);
        }
      } catch (error) {
        console.error('[publish] network error:', error);
        Toast.error('No se pudo conectar con el servidor. Intenta de nuevo.');
      } finally {
        submitButton.disabled = false;
        submitButton.textContent = isEditMode ? 'Guardar cambios' : 'Confirmar Publicación';
      }
    });
  }
});
