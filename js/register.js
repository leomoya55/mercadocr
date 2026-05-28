document.addEventListener('DOMContentLoaded', () => {
    const registerForm = document.getElementById('register-form');
    const submitButton = registerForm.querySelector('button[type="submit"]');

    // Inline error display
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

        const nombre    = (registerForm.nombre?.value    || '').trim();
        const apellido  = (registerForm.apellido?.value  || '').trim();
        const email     =  registerForm.email.value.trim();
        const phone     = (registerForm.phone?.value     || '').trim();
        const provincia =  registerForm.provincia?.value || '';
        const password  =  registerForm.password.value;
        const confirmPassword = registerForm['confirm-password'].value;

        if (password !== confirmPassword) {
            showError('Las contraseñas no coinciden.');
            return;
        }

        submitButton.disabled = true;
        submitButton.textContent = 'Verificando...';

        // ── Step 1: Check phone uniqueness BEFORE creating Firebase account ──
        // This is a best-effort check — the server validates again on profile save.
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
                // Fail open — server-side check runs again when profile is saved
            }
        }

        submitButton.textContent = 'Creando cuenta...';

        try {
            // ── Step 2: Create Firebase auth account ──────────────────────────
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            const user = userCredential.user;

            if (nombre && apellido) {
                await user.updateProfile({ displayName: `${nombre} ${apellido}` });
                const navBtn = document.getElementById('nav-user-btn');
                if (navBtn) navBtn.textContent = `${nombre} ${apellido}`;
            }

            // Send verification email — fire and forget, doesn't block redirect
            user.sendEmailVerification().catch(e => console.warn('Verification email:', e.message));

            // ── Step 3: Persist registration data immediately to the server ─────
            //
            // We call /api/users/ensure right now, while we still have the form data
            // and a fresh ID token. This avoids the sessionStorage cross-tab problem:
            // email clients open the verification link in a NEW tab, which has its own
            // (empty) sessionStorage — the mcr_reg backup never arrives.
            submitButton.textContent = 'Guardando perfil...';
            try {
                const token = await user.getIdToken();
                await fetch(API_BASE_URL + '/api/users/ensure', {
                    method:  'POST',
                    headers: {
                        'Content-Type':  'application/json',
                        'Authorization': 'Bearer ' + token,
                    },
                    body: JSON.stringify({ nombre, apellido, phone, provincia, email }),
                });
            } catch (persistErr) {
                // Network failure during registration — keep mcr_reg as a backup.
                // UserStore.getProfile() will forward it on the first authenticated page load.
                console.warn('[register] immediate profile persist failed:', persistErr.message);
            }

            // mcr_reg backup: forwarded by UserStore.getProfile() if the /ensure
            // call above failed (e.g. server was cold-starting).
            sessionStorage.setItem('mcr_reg', JSON.stringify({ phone, provincia, nombre, apellido }));

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
