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

            // Send verification email — non-blocking so a timeout/error doesn't freeze the form.
            // The user can resend from verify-email.html if needed.
            try {
                await Promise.race([
                    user.sendEmailVerification(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
                ]);
            } catch (verifyErr) {
                console.warn('Could not send verification email:', verifyErr.message);
            }

            // Create DB profile — non-blocking: if API is unreachable, registration still succeeds.
            // Profile fields can be completed later via Settings.
            try {
                const token = await user.getIdToken();
                const controller = new AbortController();
                setTimeout(() => controller.abort(), 8000);
                await fetch(API_BASE_URL + '/api/users/ensure', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                    body: JSON.stringify({ email, nombre, apellido, phone, provincia }),
                    signal: controller.signal,
                });
            } catch (apiErr) {
                // API unreachable — profile will be created on first login
                console.warn('Could not save profile during registration, will retry on login:', apiErr.message);
            }

            sessionStorage.setItem('verificationEmail', email);
            window.location.href = 'verify-email.html';

        } catch (error) {
            submitButton.disabled = false;
            submitButton.textContent = 'Registrarse';

            const friendlyCodes = {
                'auth/email-already-in-use': {
                    msg: 'Este email ya tiene una cuenta.',
                    link: 'login.html',
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
