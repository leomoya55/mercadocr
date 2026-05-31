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

  // Format an ISO date as a localized Costa Rica date.
  function fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleDateString('es-CR', { day: 'numeric', month: 'long', year: 'numeric' }); }
    catch { return ''; }
  }

  /**
   * Render the subscription panel from the RESOLVED membership (data.effective).
   * @param {'free'|'basic'|'pro'} currentPlan
   * @param {object|null} effective { active, status, currentPeriodEnd, cancelAtPeriodEnd }
   */
  function applyPlanUI(currentPlan, effective) {
    removeCancelSection();

    if (basicButton) { basicButton.disabled = false; basicButton.textContent = LABELS.basic; basicButton.classList.remove('current-plan-btn'); }
    if (proButton)   { proButton.disabled = false;   proButton.textContent = LABELS.pro;     proButton.classList.remove('current-plan-btn'); }

    if (currentPlan !== 'basic' && currentPlan !== 'pro') return; // free → nothing to manage

    const btn = currentPlan === 'basic' ? basicButton : proButton;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '✓ Plan activo';
      btn.classList.add('current-plan-btn');
    }

    const planName = currentPlan === 'pro' ? 'Pro' : 'Basic';
    const until    = fmtDate(effective && effective.currentPeriodEnd);
    const willCancel = !!(effective && effective.cancelAtPeriodEnd);

    const section = document.createElement('section');
    section.id = 'pricing-cancel-section';
    section.className = 'pricing-cancel';

    if (willCancel) {
      // Scheduled to cancel — user keeps access until period end; offer resume.
      section.innerHTML = `
        <p>Tu plan <strong>${planName}</strong> está activo${until ? ` hasta el <strong>${until}</strong>` : ''} y <strong>no se renovará</strong>.</p>
        <button class="cancel-sub-btn" id="resume-sub-btn" type="button">Reanudar suscripción</button>
      `;
      document.querySelector('.pricing-cards').after(section);
      document.getElementById('resume-sub-btn').addEventListener('click', async () => {
        const b = document.getElementById('resume-sub-btn');
        b.disabled = true; b.textContent = 'Reanudando...';
        try {
          const res = await authFetch('/api/payment/resume-subscription', { method: 'POST' });
          if (res.ok) {
            if (typeof UserStore !== 'undefined') UserStore.invalidate();
            showBanner('Tu suscripción se reanudó y se renovará normalmente.');
            window.location.reload();
          } else { b.disabled = false; b.textContent = 'Reanudar suscripción'; }
        } catch { b.disabled = false; b.textContent = 'Reanudar suscripción'; }
      });
    } else {
      // Active and renewing — offer cancellation (cancels at period end).
      section.innerHTML = `
        <p>Tienes el plan <strong>${planName}</strong> activo${until ? `. Se renovará el <strong>${until}</strong>` : ''}.</p>
        <button class="cancel-sub-btn" id="cancel-sub-btn" type="button">Cancelar suscripción</button>
      `;
      document.querySelector('.pricing-cards').after(section);
      document.getElementById('cancel-sub-btn').addEventListener('click', async () => {
        const ok = await Modal.confirm({
          title: 'Cancelar suscripción',
          message: 'Mantendrás el acceso hasta el final del periodo que ya pagaste. ¿Deseas cancelar la renovación?',
          confirmText: 'Cancelar renovación',
          cancelText: 'Volver',
          danger: true,
        });
        if (!ok) return;
        const cancelBtn = document.getElementById('cancel-sub-btn');
        cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelando...';
        try {
          const res = await authFetch('/api/payment/cancel-subscription', { method: 'POST' });
          if (res.ok) {
            const body = await res.json().catch(() => ({}));
            const end  = fmtDate(body.accessUntil);
            if (typeof UserStore !== 'undefined') UserStore.invalidate();
            showBanner(end
              ? `Suscripción cancelada. Mantendrás acceso ${planName} hasta el ${end}.`
              : 'Suscripción cancelada. Mantendrás el acceso hasta el final del periodo pagado.', 'info');
            window.location.reload();
          } else { cancelBtn.disabled = false; cancelBtn.textContent = 'Cancelar suscripción'; }
        } catch { cancelBtn.disabled = false; cancelBtn.textContent = 'Cancelar suscripción'; }
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

      // Already on this plan (server-validated against resolved membership)
      if (response.status === 400 && session.error === 'already_on_plan') {
        showBanner(session.message || 'Ya tienes este plan activo.', 'info');
        btn.disabled = false;
        btn.textContent = LABELS[type];
        return;
      }

      // Proration path: the backend swapped the price on the existing
      // subscription in-place (no Checkout redirect). Reflect it immediately.
      if (session.upgraded) {
        if (typeof UserStore !== 'undefined') UserStore.invalidate();
        showBanner(`Tu plan cambió a ${PLAN_LABELS[type] || type}. El ajuste de cobro se prorrateó automáticamente.`);
        setTimeout(() => window.location.reload(), 1500);
        return;
      }

      // New subscription: redirect to Stripe Checkout.
      if (session.url) {
        window.location.href = session.url;
      } else {
        showBanner('No se pudo iniciar el pago. Intenta de nuevo.', 'info');
        btn.disabled = false;
        btn.textContent = LABELS[type];
      }
    } catch {
      showBanner('Error de conexión. Intenta de nuevo.', 'info');
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
          // data.plan is the backend-resolved tier (never the stale stored field)
          if (data.plan === targetPlan) {
            const label = PLAN_LABELS[targetPlan] || targetPlan;
            showBanner(`¡Plan ${label} activado con éxito! Bienvenido.`);
            if (typeof UserStore !== 'undefined') UserStore.invalidate();
            applyPlanUI(data.plan, data.effective);
            activated = true;
            break;
          }
        } catch { /* keep polling */ }
      }
      if (!activated) {
        showBanner('Pago recibido. Si tu plan no se actualiza en un momento, recarga la página.', 'info');
        try {
          const data = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
          if (data.plan) applyPlanUI(data.plan, data.effective);
        } catch {}
      }
    } else {
      try {
        const data = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
        if (data.plan) applyPlanUI(data.plan, data.effective);
      } catch {}
    }
  });
});
