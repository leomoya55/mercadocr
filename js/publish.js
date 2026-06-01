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

  // ─── Live image preview ─────────────────────────────────────────────────────
  const imagesInput      = document.getElementById('images');
  const previewContainer = document.getElementById('image-preview-container');
  const MAX_IMAGES = 10;

  function renderImagePreviews() {
    if (!previewContainer) return;
    previewContainer.innerHTML = '';
    const files = imagesInput ? Array.from(imagesInput.files || []) : [];
    files.forEach((file) => {
      if (!file.type || !file.type.startsWith('image/')) return;
      const url   = URL.createObjectURL(file);
      const thumb = document.createElement('div');
      thumb.className = 'preview-thumb';
      const img = document.createElement('img');
      img.src = url;
      img.alt = file.name || '';
      img.addEventListener('load', () => URL.revokeObjectURL(url));
      thumb.appendChild(img);
      previewContainer.appendChild(thumb);
    });
  }

  if (imagesInput) {
    imagesInput.addEventListener('change', () => {
      const files = Array.from(imagesInput.files);
      if (files.length > MAX_IMAGES) {
        Toast.info(`Puedes subir un máximo de ${MAX_IMAGES} fotos. Se usarán las primeras ${MAX_IMAGES}.`);
        // Create a new FileList object with the first 10 files
        const dataTransfer = new DataTransfer();
        for (let i = 0; i < MAX_IMAGES; i++) {
          dataTransfer.items.add(files[i]);
        }
        imagesInput.files = dataTransfer.files;
      }
      renderImagePreviews();
    });
  }

  // ─── Category-specific fields (clothing size / real-estate details) ──────────
  const categorySelect = document.getElementById('category');
  const sizeGroup      = document.getElementById('size-group');
  const sizeSelect     = document.getElementById('size');
  const realestateGroup = document.getElementById('realestate-group');
  const jobGroup        = document.getElementById('job-group');
  const conditionPriceRow = document.getElementById('condition-price-row');
  const imagesLabel     = document.getElementById('images-label');
  const SIZE_CATEGORY  = 'Ropa y accesorios';
  const RE_CATEGORY    = 'Bienes Raíces';
  const JOB_CATEGORY   = 'Empleos';
  // Real-estate inputs, cleared whenever the category isn't Bienes Raíces.
  const reFields = ['re_operation', 're_type', 're_area', 're_bedrooms', 're_bathrooms']
    .map((id) => document.getElementById(id));
  // Job inputs, cleared whenever the category isn't Empleos.
  const jobFields = ['job_company', 'job_type', 'job_modality', 'job_salary', 'job_apply_email', 'job_apply_url']
    .map((id) => document.getElementById(id));

  function updateCategoryFields() {
    const value = categorySelect ? categorySelect.value : '';

    const showSize = value === SIZE_CATEGORY;
    if (sizeGroup) sizeGroup.classList.toggle('hidden', !showSize);
    if (!showSize && sizeSelect) sizeSelect.value = '';

    // Empleos: show job fields, hide the condition/price row, photos optional.
    const showJob = value === JOB_CATEGORY;
    if (jobGroup) jobGroup.classList.toggle('hidden', !showJob);
    if (conditionPriceRow) conditionPriceRow.classList.toggle('hidden', showJob);
    if (imagesLabel) imagesLabel.textContent = showJob ? 'Imágenes (opcional)' : 'Imágenes';
    if (!showJob) jobFields.forEach((el) => { if (el) el.value = ''; });

    const showRe = value === RE_CATEGORY;
    if (realestateGroup) realestateGroup.classList.toggle('hidden', !showRe);
    if (!showRe) reFields.forEach((el) => { if (el) el.value = ''; });
  }

  if (categorySelect) categorySelect.addEventListener('change', updateCategoryFields);


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
    if (sizeSelect) sizeSelect.value = listing.size || '';
    // Pre-fill real-estate fields when editing a Bienes Raíces listing.
    const re = listing.realEstate || {};
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = (val === null || val === undefined) ? '' : val; };
    setVal('re_operation', re.operation || '');
    setVal('re_type',      re.propertyType || '');
    setVal('re_area',      re.area);
    setVal('re_bedrooms',  re.bedrooms);
    setVal('re_bathrooms', re.bathrooms);
    // Pre-fill job fields when editing an Empleos listing.
    const jb = listing.job || {};
    setVal('job_company',     jb.company || '');
    setVal('job_type',        jb.employmentType || '');
    setVal('job_modality',    jb.modality || '');
    setVal('job_salary',      jb.salary || '');
    setVal('job_apply_email', jb.applyEmail || '');
    setVal('job_apply_url',   jb.applyUrl || '');
    updateCategoryFields();
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
    const getUploadSignature = async () => {
      const response = await authFetch('/api/listings/upload-signature', { method: 'POST' });
      if (!response.ok) {
        const raw = await response.text().catch(() => '');
        throw new Error(raw || 'No se pudo preparar la subida de imágenes.');
      }
      return response.json();
    };

    const uploadImagesDirect = async (files) => {
      if (!files || files.length === 0) return [];
      setStatus('Subiendo imágenes...');

      const sig = await getUploadSignature();
      const uploadUrl = `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`;

      const uploads = files.map(async (file) => {
        const data = new FormData();
        data.append('file', file);
        data.append('api_key', sig.apiKey);
        data.append('timestamp', sig.timestamp);
        data.append('signature', sig.signature);
        if (sig.folder) data.append('folder', sig.folder);
        if (sig.transformation) data.append('transformation', sig.transformation);
        if (sig.format) data.append('format', sig.format);

        const response = await fetch(uploadUrl, { method: 'POST', body: data });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.secure_url) {
          const msg = payload.error && payload.error.message
            ? payload.error.message
            : 'No se pudo subir una imagen.';
          throw new Error(msg);
        }
        return payload.secure_url;
      });

      const urls = await Promise.all(uploads);
      setStatus('');
      return urls;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentUser) {
        Toast.error('Debes iniciar sesión para publicar.');
        return;
      }

      // ── Pre-submit validation: instant, clear feedback for any missing field,
      //    on any category — so problems never surface as a vague server error. ──
      const nameValue = (form.name.value || '').trim();
      if (nameValue.length < 3) {
        Toast.error('El título debe tener al menos 3 caracteres.');
        return;
      }
      if (!form.category.value) {
        Toast.error('Selecciona una categoría.');
        return;
      }
      const isJob = form.category.value === 'Empleos';
      // Jobs have no price and don't require a photo, but need a contact email.
      if (!isJob && (!priceHidden.value || Number(priceHidden.value) < 0)) {
        Toast.error('Ingresá un precio válido.');
        return;
      }
      if (isJob) {
        const email = (document.getElementById('job_apply_email') || {}).value || '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
          Toast.error('Ingresá un correo válido para recibir las aplicaciones.');
          return;
        }
      }
      const descriptionValue = descriptionInput.value || '';
      if (descriptionValue.length < minDescriptionLength) {
        Toast.error(`La descripción debe tener al menos ${minDescriptionLength} caracteres.`);
        return;
      }
      if (!isJob && !isEditMode && imagesInput && (!imagesInput.files || imagesInput.files.length === 0)) {
        Toast.error('Agregá al menos una foto de tu anuncio.');
        return;
      }
      if (imagesInput && imagesInput.files.length > MAX_IMAGES) {
        Toast.error(`Puedes subir un máximo de ${MAX_IMAGES} fotos.`);
        return;
      }

      submitButton.disabled = true;
      submitButton.textContent = 'Publicando...';

      const listingName = nameValue;
      const imageFiles = imagesInput ? Array.from(imagesInput.files || []) : [];

      let uploadedPhotos = [];
      try {
        if (imageFiles.length > 0) {
          uploadedPhotos = await uploadImagesDirect(imageFiles);
        } else if (!isEditMode && !isJob) {
          Toast.error('Agregá al menos una foto de tu anuncio.');
          submitButton.disabled = false;
          submitButton.textContent = isEditMode ? 'Guardar cambios' : 'Confirmar Publicación';
          return;
        }
      } catch (uploadError) {
        console.error('Cloudinary upload error:', uploadError);
        Toast.error(uploadError.message || 'No se pudieron subir las imágenes.');
        submitButton.disabled = false;
        submitButton.textContent = isEditMode ? 'Guardar cambios' : 'Confirmar Publicación';
        setStatus('');
        return;
      }

      const payload = {
        name: nameValue,
        description: descriptionValue,
        price: priceHidden.value,
        category: form.category.value,
        condition: form.condition ? form.condition.value : '',
        size: sizeSelect ? sizeSelect.value : '',
        re_operation: document.getElementById('re_operation')?.value || '',
        re_type: document.getElementById('re_type')?.value || '',
        re_area: document.getElementById('re_area')?.value || '',
        re_bedrooms: document.getElementById('re_bedrooms')?.value || '',
        re_bathrooms: document.getElementById('re_bathrooms')?.value || '',
        job_company: document.getElementById('job_company')?.value || '',
        job_type: document.getElementById('job_type')?.value || '',
        job_modality: document.getElementById('job_modality')?.value || '',
        job_salary: document.getElementById('job_salary')?.value || '',
        job_apply_email: document.getElementById('job_apply_email')?.value || '',
        job_apply_url: document.getElementById('job_apply_url')?.value || '',
      };
      if (uploadedPhotos.length > 0) payload.photos = uploadedPhotos;

      try {
        const endpoint = isEditMode
          ? `/api/listings/update/${editId}`
          : '/api/listings/add';

        const response = await authFetch(endpoint, {
          method: 'POST', // both /add and /update/:id are POST routes on the server
          body: JSON.stringify(payload),
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
            if (previewContainer) previewContainer.innerHTML = '';
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
          // Always surface the server's specific reason so the user knows what
          // to fix. Read the body once as text, then try to parse JSON; if there
          // is no message, fall back to the HTTP status so it's never a dead end.
          const raw = await response.text().catch(() => '');
          let errData = null;
          try { errData = JSON.parse(raw); } catch { /* not JSON */ }
          const msg = (errData && errData.error)
            ? errData.error
            : `No se pudo publicar (código ${response.status}). ${raw ? raw.slice(0, 160) : 'Intenta de nuevo.'}`;
          Toast.error(msg, 7000);
          console.error('[publish] server error:', response.status, errData || raw);
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
