document.addEventListener('DOMContentLoaded', () => {
  const basicButton = document.getElementById('pricing-basic');
  const proButton   = document.getElementById('pricing-pro');

  const LABELS = { basic: 'Activar Basic', pro: 'Activar Pro' };

  const startCheckout = async (type) => {
    const user = auth.currentUser;
    if (!user) { window.location.href = 'login.html'; return; }
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

  function removeCancelSection() {
    document.getElementById('pricing-cancel-section')?.remove();
  }

  function applyPlanUI(currentPlan) {
    removeCancelSection();

    // Reset both buttons
    if (basicButton) { basicButton.disabled = false; basicButton.textContent = LABELS.basic; basicButton.classList.remove('current-plan-btn'); }
    if (proButton)   { proButton.disabled = false;   proButton.textContent = LABELS.pro;     proButton.classList.remove('current-plan-btn'); }

    if (currentPlan === 'basic' || currentPlan === 'pro') {
      const btn = currentPlan === 'basic' ? basicButton : proButton;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '✓ Ya eres miembro';
        btn.classList.add('current-plan-btn');
      }

      // Cancel section
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
            alert('Suscripción cancelada. Tu plan ha cambiado a Gratis.');
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

  auth.onAuthStateChanged(async (user) => {
    const urlParams = new URLSearchParams(window.location.search);
    const paymentSuccess = urlParams.get('payment_success') === 'true';

    if (paymentSuccess) {
      const type = urlParams.get('type');
      alert(`Plan ${type === 'pro' ? 'Pro' : 'Basic'} activado con éxito. ¡Bienvenido!`);
      window.history.replaceState({}, document.title, 'pricing.html');
    }

    if (user) {
      try {
        if (paymentSuccess) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
        const data = await authFetch(`/api/users/${user.uid}`).then(r => r.json());
        if (data.user) applyPlanUI(data.user.plan);
      } catch {}
    }
  });

  basicButton?.addEventListener('click', () => startCheckout('basic'));
  proButton?.addEventListener('click',  () => startCheckout('pro'));
});
