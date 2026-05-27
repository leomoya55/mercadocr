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
        submitButton.textContent = 'Creando cuenta...';

        try {
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);
            const user = userCredential.user;

            // Set Firebase display name if provided
            if (nombre && apellido) {
                await user.updateProfile({ displayName: `${nombre} ${apellido}` });
                // onAuthStateChanged already fired before updateProfile ran, so update nav directly
                const navBtn = document.getElementById('nav-user-btn');
                if (navBtn) navBtn.textContent = `${nombre} ${apellido}`;
            }

            // Fire-and-forget — neither call blocks the redirect
            user.sendEmailVerification().catch(e => console.warn('Verification email:', e.message));

            user.getIdToken().then(token => {
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 8000);
                return fetch(API_BASE_URL + '/api/users/ensure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ email, nombre, apellido, phone, provincia }),
                    signal: controller.signal,
                });
            }).catch(e => console.warn('Profile API:', e.message));

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
