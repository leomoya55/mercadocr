document.addEventListener('DOMContentLoaded', () => {
  const basicButton = document.getElementById('pricing-basic');
  const proButton   = document.getElementById('pricing-pro');

  const PLAN_LABELS = { basic: 'Basic', pro: 'Pro' };

  // ── Success banner ──────────────────────────────────────────────
  function showBanner(msg, type = 'success') {
    let banner = document.getElementById('pricing-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'pricing-banner';
      banner.style.cssText = [
        'padding:1rem 1.5rem',
        'border-radius:10px',
        'margin-bottom:1.5rem',
        'font-weight:600',
        'font-size:1rem',
        'text-align:center',
        type === 'success'
          ? 'background:rgba(100,200,130,0.15);border:1px solid #64c882;color:#64c882'
          : 'background:rgba(232,201,122,0.15);border:1px solid #e8c97a;color:#e8c97a',
      ].join(';');
      document.querySelector('.pricing-hero').after(banner);
    }
    banner.textContent = msg;
    banner.style.display = 'block';
  }

  // ── Plan button state ─────────────────────────────────────────
  const LABELS = { basic: 'Activar Basic', pro: 'Activar Pro' };

  function removeCancelSection() {
    document.getElementById('pricing-cancel-section')?.remove();
  }

  function applyPlanUI(currentPlan) {
    removeCancelSection();

    if (basicButton) { basicButton.disabled = false; basicButton.textContent = LABELS.basic; basicButton.classList.remove('current-plan-btn'); }
    if (proButton)   { proButton.disabled = false;   proButton.textContent = LABELS.pro;     proButton.classList.remove('current-plan-btn'); }

    if (currentPlan === 'basic' || currentPlan === 'pro') {
      const btn = currentPlan === 'basic' ? basicButton : proButton;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '✓ Plan activo';
        btn.classList.add('current-plan-btn');
      }

      const section = document.createElement('section');
      section.id = 'pricing-cancel-section';
      section.className = 'pricing-cancel';
      section.innerHTML = `
        <p>Tienes el plan <strong>${currentPlan === 'pro' ? 'Pro' : 'Basic'}</strong> activo.</p>
        <button class="cancel-sub-btn" id="cancel-sub-btn" type="button">Cancelar suscripción</button>
      `;
      document.querySelector('.pricing-cards').after(section);

      document.getElementById('cancel-sub-btn').addEventListener('click', async () => {
        if (!confirm('¿Seguro que deseas cancelar tu suscripción? Tu plan volverá a Gratis.')) return;
        const cancelBtn = document.getElementById('cancel-sub-btn');
        cancelBtn.disabled = true;
        cancelBtn.textContent = 'Cancelando...';
        try {
          const res = await authFetch('/api/payment/cancel-subscription', { method: 'POST' });
          if (res.ok) {
            showBanner('Suscripción cancelada. Tu plan ha vuelto a Gratis.', 'info');
            window.location.reload();
          } else {
            cancelBtn.disabled = false;
            cancelBtn.textContent = 'Cancelar suscripción';
          }
        } catch {
          cancelBtn.disabled = false;
          cancelBtn.textContent = 'Cancelar suscripción';
        }
      });
    }
  }

  // ── Checkout ───────────────────────────────────────────────────
  const startCheckout = async (type) => {
    const user = auth.currentUser;
    if (!user) { window.location.href = '/login'; return; }
    const btn = type === 'basic' ? basicButton : proButton;
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
        btn.textContent = LABELS[type];
      }
    } catch {
      btn.disabled = false;
      btn.textContent = LABELS[type];
    }
  };

  basicButton?.addEventListener('click', () => startCheckout('basic'));
  proButton?.addEventListener('click',  () => startCheckout('pro'));

  // ── Auth & success handling ────────────────────────────────────
  auth.onAuthStateChanged(async (user) => {
    const urlParams  = new URLSearchParams(window.location.search);
    const isSuccess  = urlParams.get('payment_success') === 'true';
    const targetPlan = urlParams.get('type'); // 'basic' or 'pro'

    if (isSuccess && targetPlan) {
      window.history.replaceState({}, document.title, '/pricing');
      const label = PLAN_LABELS[targetPlan] || targetPlan;
      showBanner(`¡Bienvenido al plan ${label}! Tu suscripción está siendo activada...`);
    }

    if (!user) return;

    if (isSuccess && targetPlan) {
      // Poll until the webhook updates the plan in the DB (up to ~16 s)
      let activated = false;
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const data = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
          if (data.user?.plan === targetPlan) {
            const label = PLAN_LABELS[targetPlan] || targetPlan;
            showBanner(`¡Plan ${label} activado con éxito! Bienvenido.`);
            applyPlanUI(targetPlan);
            activated = true;
            break;
          }
        } catch { /* keep polling */ }
      }
      if (!activated) {
        showBanner('Pago recibido. Si tu plan no se actualiza en un momento, recarga la página.', 'info');
        try {
          const data = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
          if (data.user) applyPlanUI(data.user.plan);
        } catch {}
      }
    } else {
      try {
        const data = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
        if (data.user) applyPlanUI(data.user.plan);
      } catch {}
    }
  });
});
