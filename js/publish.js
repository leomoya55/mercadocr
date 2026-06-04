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
  const minDescriptionLength = 10; // matches the server minimum; less friction to publish

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

  // ─── Image pipeline: compress + upload on SELECT (not on submit) ─────────────
  //
  // WHY: the old flow only began uploading after the user pressed "Publicar", so
  // they stared at "Subiendo imágenes..." for the full network time. Now each
  // photo is compressed (browser-image-compression) and uploaded to Cloudinary in
  // the BACKGROUND the moment it's chosen — while the user is still typing the
  // title/description. By the time they submit, the photos are usually already up,
  // so publishing feels instant. Each thumbnail shows its own status (⏳/✓/⚠).
  //
  // Trade-off: a user who selects photos then abandons the page leaves orphaned
  // Cloudinary images (never attached to a listing). That's a small storage cost;
  // a periodic orphan-sweep is recommended in the launch review.
  const imagesInput      = document.getElementById('images');
  const previewContainer = document.getElementById('image-preview-container');
  const MAX_IMAGES = 10;

  // Each entry: { file, status:'uploading'|'done'|'error', url, error, el, promise }
  let uploadItems = [];
  let cachedSig   = null; // one Cloudinary signature reused for the whole session

  async function getUploadSignature() {
    if (cachedSig && cachedSig.expires > Date.now()) return cachedSig;
    const response = await authFetch('/api/listings/upload-signature', { method: 'POST' });
    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      throw new Error(raw || 'No se pudo preparar la subida de imágenes.');
    }
    const sig = await response.json();
    sig.expires = Date.now() + 50 * 60 * 1000; // signatures last ~1h; refresh early
    cachedSig = sig;
    return sig;
  }

  // Shrink large phone photos before upload. Falls back to the original file if
  // the library is unavailable or can't process the format (e.g. some HEIC).
  async function compressIfNeeded(file) {
    if (typeof imageCompression !== 'function') return file;
    if (!file.type || !file.type.startsWith('image/')) return file;
    try {
      return await imageCompression(file, {
        maxSizeMB: 0.9,
        maxWidthOrHeight: 1600,
        useWebWorker: true,
        initialQuality: 0.8,
      });
    } catch (e) {
      console.warn('[publish] compression failed, using original:', e.message);
      return file;
    }
  }

  function setItemStatus(item, status) {
    item.status = status;
    if (!item.el) return;
    item.el.classList.remove('is-uploading', 'is-done', 'is-error');
    item.el.classList.add('is-' + status);
    const badge = item.el.querySelector('.thumb-badge');
    if (badge) {
      badge.textContent = status === 'done' ? '✓' : status === 'error' ? '⚠' : '';
    }
  }

  function buildThumb(item) {
    const thumb = document.createElement('div');
    thumb.className = 'preview-thumb is-uploading';
    const url = URL.createObjectURL(item.file);
    const img = document.createElement('img');
    img.src = url;
    img.alt = item.file.name || '';
    img.addEventListener('load', () => URL.revokeObjectURL(url));
    const badge = document.createElement('span');
    badge.className = 'thumb-badge';
    const spinner = document.createElement('span');
    spinner.className = 'thumb-spinner';
    // Remove ("×") button — lets the user drop a wrongly-chosen photo without
    // having to re-pick the whole selection.
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'thumb-remove';
    removeBtn.setAttribute('aria-label', 'Quitar imagen');
    removeBtn.title = 'Quitar imagen';
    removeBtn.textContent = '×';
    removeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeItem(item);
    });
    thumb.appendChild(img);
    thumb.appendChild(spinner);
    thumb.appendChild(badge);
    thumb.appendChild(removeBtn);
    item.el = thumb;
    previewContainer.appendChild(thumb);
  }

  // Remove a single staged photo: drop it from the list + DOM and keep the file
  // input in sync so validation and any later re-selection are consistent. The
  // already-uploaded Cloudinary image (if any) is simply left unreferenced; it's
  // never attached to the listing (covered by the orphan-sweep noted in the launch review).
  function removeItem(item) {
    const idx = uploadItems.indexOf(item);
    if (idx !== -1) uploadItems.splice(idx, 1);
    if (item.el && item.el.parentNode) item.el.parentNode.removeChild(item.el);
    syncInputFiles();
  }

  // Rebuild imagesInput.files from the still-selected items so the native input
  // reflects exactly what will be published.
  function syncInputFiles() {
    if (!imagesInput) return;
    try {
      const dt = new DataTransfer();
      uploadItems.forEach((it) => { if (it.file) dt.items.add(it.file); });
      imagesInput.files = dt.files;
    } catch (e) {
      // DataTransfer unsupported (very old browser) — non-fatal; submit still
      // relies on uploadItems for the actual URLs.
    }
  }

  async function uploadOne(item) {
    try {
      const file = await compressIfNeeded(item.file);
      const sig  = await getUploadSignature();
      const data = new FormData();
      data.append('file', file);
      data.append('api_key', sig.apiKey);
      data.append('timestamp', sig.timestamp);
      data.append('signature', sig.signature);
      if (sig.folder) data.append('folder', sig.folder);

      const r = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, {
        method: 'POST', body: data,
      });
      const payload = await r.json().catch(() => ({}));
      if (!r.ok || !payload.secure_url) {
        throw new Error((payload.error && payload.error.message) || 'No se pudo subir la imagen.');
      }
      item.url = payload.secure_url;
      setItemStatus(item, 'done');
    } catch (e) {
      item.error = e.message;
      setItemStatus(item, 'error');
    }
  }

  function startUploads(files) {
    if (!previewContainer) return;
    uploadItems = [];
    previewContainer.innerHTML = '';
    files.forEach((file) => {
      if (!file.type || !file.type.startsWith('image/')) return;
      const item = { file, status: 'uploading', url: null, error: null, el: null, promise: null };
      buildThumb(item);
      item.promise = uploadOne(item);
      uploadItems.push(item);
    });
  }

  if (imagesInput) {
    imagesInput.addEventListener('change', () => {
      let files = Array.from(imagesInput.files || []);
      if (files.length > MAX_IMAGES) {
        Toast.info(`Puedes subir un máximo de ${MAX_IMAGES} fotos. Se usarán las primeras ${MAX_IMAGES}.`);
        files = files.slice(0, MAX_IMAGES);
        const dataTransfer = new DataTransfer();
        files.forEach((f) => dataTransfer.items.add(f));
        imagesInput.files = dataTransfer.files;
      }
      startUploads(files);
    });
  }

  // Wait for any in-flight uploads and return the successful URLs. Used at submit.
  async function awaitUploadedPhotos() {
    if (!uploadItems.length) return { urls: [], failed: 0 };
    await Promise.allSettled(uploadItems.map((it) => it.promise));
    const urls   = uploadItems.filter((it) => it.url).map((it) => it.url);
    const failed = uploadItems.filter((it) => !it.url).length;
    return { urls, failed };
  }

  // ─── Category-specific fields (clothing size / real-estate details) ──────────
  const categorySelect = document.getElementById('category');
  const subcategoryGroup  = document.getElementById('subcategory-group');
  const subcategorySelect = document.getElementById('subcategory');
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

  // Populate the category dropdown from the shared taxonomy (single source of
  // truth). Keeps the disabled placeholder; appends one <option> per category.
  function populateCategoryOptions() {
    if (!categorySelect || typeof Taxonomy === 'undefined') return;
    Taxonomy.CATEGORIES.forEach((c) => {
      const opt = document.createElement('option');
      opt.value = c.value;
      opt.textContent = (c.icon ? c.icon + '  ' : '') + c.label;
      categorySelect.appendChild(opt);
    });
  }

  // Fill the subcategory dropdown for the chosen category and toggle its
  // visibility. `selected` pre-selects a value (used in edit mode).
  function populateSubcategories(catValue, selected) {
    if (!subcategorySelect || typeof Taxonomy === 'undefined') return;
    const subs = Taxonomy.subcategoriesFor(catValue);
    subcategorySelect.innerHTML = '<option value="">Todas</option>';
    subs.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = s;
      if (selected && s === selected) opt.selected = true;
      subcategorySelect.appendChild(opt);
    });
    const hasSubs = subs.length > 0;
    if (subcategoryGroup) subcategoryGroup.classList.toggle('hidden', !hasSubs);
    // When there's no subcategory column, let the category select take the full row
    // width instead of leaving an empty half.
    const categoryRow = document.getElementById('category-row');
    if (categoryRow) categoryRow.classList.toggle('row-collapsed', !hasSubs);
    if (!hasSubs) subcategorySelect.value = '';
  }

  populateCategoryOptions();

  function updateCategoryFields() {
    const value = categorySelect ? categorySelect.value : '';

    // Refresh subcategories for the chosen category (no preselect on manual change).
    populateSubcategories(value);

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

  // Option A downgrade banner: existing listings stay live; new ones are blocked
  // while the account exceeds its current plan limit.
  function showOverLimitBanner(data) {
    const banner = document.getElementById('over-limit-banner');
    if (!banner) return;
    if (!data || !data.overLimit) { banner.classList.add('hidden'); return; }
    const planLabel = { free: 'Gratis', basic: 'Basic', pro: 'Pro' }[data.plan] || data.plan;
    banner.innerHTML =
      '<strong>Tu cuenta supera el límite de tu plan.</strong> ' +
      'Tenés ' + data.listingCount + ' anuncios activos y el plan ' + planLabel +
      ' permite ' + data.maxListings + '. Tus anuncios actuales siguen publicados, pero para ' +
      'crear uno nuevo mejorá tu plan o eliminá algunos. ' +
      '<a href="/pricing">Mejorar plan</a> · <a href="/dashboard">Administrar mis anuncios</a>';
    banner.classList.remove('hidden');
  }

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
    // updateCategoryFields rebuilt the subcategory options; now select the stored one.
    if (subcategorySelect) populateSubcategories(listing.category, listing.subcategory || '');
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
      showOverLimitBanner(profileData);
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

      // Photos were already compressed + uploaded in the background as they were
      // chosen. Here we just wait for any still in flight and collect the URLs —
      // usually instant.
      let uploadedPhotos = [];
      const stillUploading = uploadItems.some((it) => it.status === 'uploading');
      if (stillUploading) setStatus('Terminando de subir las imágenes...');
      try {
        const { urls, failed } = await awaitUploadedPhotos();
        uploadedPhotos = urls;
        setStatus('');
        if (failed > 0 && urls.length === 0 && !isEditMode && !isJob) {
          Toast.error('No se pudieron subir las imágenes. Volvé a intentarlo.');
          submitButton.disabled = false;
          submitButton.textContent = isEditMode ? 'Guardar cambios' : 'Confirmar Publicación';
          return;
        }
        if (failed > 0 && urls.length > 0) {
          Toast.info(`${failed} imagen(es) no se pudieron subir; se publicará con ${urls.length}.`);
        }
        if (uploadedPhotos.length === 0 && !isEditMode && !isJob) {
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
        subcategory: subcategorySelect ? subcategorySelect.value : '',
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
            uploadItems = []; // clear staged uploads so the next listing starts fresh
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
