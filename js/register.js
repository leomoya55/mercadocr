document.addEventListener('DOMContentLoaded', () => {
    const registerForm = document.getElementById('register-form');
    const submitButton = registerForm.querySelector('button[type="submit"]');

    // Create inline error element
    const errorEl = document.createElement('p');
    errorEl.style.cssText = 'color:#e08080;font-size:0.88rem;margin:0.5rem 0 0;';
    errorEl.style.display = 'none';
    submitButton.before(errorEl);

    function showError(msg, linkHref, linkText) {
        errorEl.innerHTML = msg + (linkHref ? ` <a href="${linkHref}" style="color:#e8c97a;">${linkText}</a>` : '');
        errorEl.style.display = 'block';
    }
    function clearError() { errorEl.style.display = 'none'; }

    registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError();

        const nombre    = (registerForm.nombre?.value || '').trim();
        const apellido  = (registerForm.apellido?.value || '').trim();
        const email     = registerForm.email.value.trim();
        const phone     = (registerForm.phone?.value || '').trim();
        const provincia = registerForm.provincia?.value || '';
        const password  = registerForm.password.value;
        const confirmPassword = registerForm['confirm-password'].value;

        if (password !== confirmPassword) {
            showError('Las contraseñas no coinciden.');
            return;
        }

        submitButton.disabled = true;
        submitButton.textContent = 'Verificando...';

        // ── Step 1: Check phone uniqueness BEFORE creating Firebase account ──
        if (phone) {
            try {
                const checkRes = await fetch(
                    API_BASE_URL + `/api/users/phone-check?phone=${encodeURIComponent(phone)}`
                );
                const check = await checkRes.json();
                if (!check.available) {
                    showError('Este número de teléfono ya está registrado. Usa otro número.');
                    submitButton.disabled = false;
                    submitButton.textContent = 'Registrarse';
                    return;
                }
            } catch {
                // If the check fails (cold start), continue — ensure validates again server-side
            }
        }

        submitButton.textContent = 'Creando cuenta...';

        try {
            // ── Step 2: Create Firebase auth account ──
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            const user = userCredential.user;

            // Set Firebase display name
            if (nombre && apellido) {
                await user.updateProfile({ displayName: `${nombre} ${apellido}` });
                const navBtn = document.getElementById('nav-user-btn');
                if (navBtn) navBtn.textContent = `${nombre} ${apellido}`;
            }

            // Send verification email (fire-and-forget — doesn't block redirect)
            user.sendEmailVerification().catch(e => console.warn('Verification email:', e.message));

            // ── Step 3: Save profile to DB — AWAITED with 5s timeout ──
            // This guarantees phone, provincia, nombre, apellido are stored permanently.
            // sessionStorage is the safety net if this times out (dashboard picks it up).
            sessionStorage.setItem('mcr_reg', JSON.stringify({ phone, provincia, nombre, apellido }));
            submitButton.textContent = 'Guardando perfil...';
            try {
                const token = await user.getIdToken();
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), 5000);
                const ensureRes = await fetch(API_BASE_URL + '/api/users/ensure', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                    body: JSON.stringify({ email, nombre, apellido, phone, provincia }),
                    signal: controller.signal,
                });
                clearTimeout(timer);

                if (ensureRes.status === 409) {
                    // Phone was taken by the time we got here (race condition)
                    // Profile was still created but without the phone
                    console.warn('Phone conflict on ensure — profile saved without phone');
                }
                // Profile saved — clear the sessionStorage safety net
                if (ensureRes.ok) sessionStorage.removeItem('mcr_reg');
            } catch (profileErr) {
                // Timed out or network error — sessionStorage still has the data
                // Dashboard will forward it to ensure on first visit
                console.warn('Profile save during registration:', profileErr.message);
            }

            sessionStorage.setItem('verificationEmail', email);
            window.location.href = '/verify-email';

        } catch (error) {
            submitButton.disabled = false;
            submitButton.textContent = 'Registrarse';

            const friendlyCodes = {
                'auth/email-already-in-use': {
                    msg: 'Este email ya tiene una cuenta.',
                    link: '/login',
                    linkText: 'Inicia sesión aquí →',
                },
                'auth/weak-password': { msg: 'La contraseña debe tener al menos 6 caracteres.' },
                'auth/invalid-email':  { msg: 'El email no es válido.' },
            };

            const known = friendlyCodes[error.code];
            if (known) {
                showError(known.msg, known.link, known.linkText);
            } else {
                showError('Error al crear la cuenta. Intenta de nuevo.');
                console.error('Register error:', error.code, error.message);
            }
        }
    });
});
