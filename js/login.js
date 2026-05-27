document.addEventListener('DOMContentLoaded', () => {
    const loginForm   = document.getElementById('login-form');
    const errorEl     = document.getElementById('login-error');
    const submitBtn   = loginForm.querySelector('button[type="submit"]');

    function showError(msg) {
        errorEl.textContent = msg;
        errorEl.style.display = 'block';
    }
    function clearError() {
        errorEl.style.display = 'none';
        errorEl.textContent = '';
    }

    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        clearError();
        const email    = loginForm.email.value;
        const password = loginForm.password.value;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Ingresando...';

        try {
            const userCredential = await auth.signInWithEmailAndPassword(email, password);
            const user = userCredential.user;

            if (!user.emailVerified) {
                await auth.signOut();
                sessionStorage.setItem('verificationEmail', user.email);
                window.location.href = '/verify-email';
                return;
            }

            // Redirect immediately — dashboard creates the profile if missing
            window.location.href = '/dashboard';
        } catch (error) {
            const friendlyCodes = {
                'auth/user-not-found':     'Usuario o contraseña incorrecta.',
                'auth/wrong-password':     'Usuario o contraseña incorrecta.',
                'auth/invalid-credential': 'Usuario o contraseña incorrecta.',
                'auth/too-many-requests':  'Demasiados intentos. Intenta más tarde.',
                'auth/invalid-email':      'El email no es válido.',
            };
            showError(friendlyCodes[error.code] || 'Usuario o contraseña incorrecta.');
            submitBtn.disabled = false;
            submitBtn.textContent = 'Iniciar Sesión';
        }
    });
});
