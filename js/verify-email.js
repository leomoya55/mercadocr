document.addEventListener('DOMContentLoaded', () => {
    const emailLabel = document.getElementById('verify-email-address');
    const timerLabel = document.getElementById('verify-timer');
    const resendButton = document.getElementById('resend-button');
    const checkButton = document.getElementById('check-button');
    const statusLabel = document.getElementById('verify-status');

    const email = sessionStorage.getItem('verificationEmail');
    emailLabel.textContent = email || 'No disponible';

    let secondsLeft = 60;
    let userRef = null;

    const updateTimer = () => {
        if (secondsLeft > 0) {
            timerLabel.textContent = `Podés reenviar el correo en: ${secondsLeft} segundos`;
            secondsLeft -= 1;
        } else {
            timerLabel.textContent = 'Ya podés reenviar el correo.';
            resendButton.classList.remove('hidden');
            clearInterval(timerInterval);
        }
    };

    const timerInterval = setInterval(updateTimer, 1000);
    updateTimer();

    auth.onAuthStateChanged((user) => {
        userRef = user;
    });

    resendButton.addEventListener('click', async () => {
        if (!userRef) {
            statusLabel.textContent = 'Iniciá sesión de nuevo para reenviar el correo.';
            return;
        }

        try {
            resendButton.disabled = true;
            resendButton.textContent = 'Enviando...';
            await userRef.sendEmailVerification();
            statusLabel.textContent = 'Correo reenviado. Revisá tu bandeja de entrada.';
        } catch (error) {
            console.error('Verification email error:', error);
            statusLabel.textContent = 'No se pudo reenviar el correo. Intentá más tarde.';
        } finally {
            resendButton.disabled = false;
            resendButton.textContent = 'Reenviar correo de verificación';
        }
    });

    // ── "Usar otro correo" — fix a wrong email by discarding this account ───────
    // If the user typed the wrong email, they're stuck on this screen forever
    // (the verification link goes to an inbox they don't own). This lets them
    // throw the just-created, still-unverified account away themselves — deleting
    // both the MongoDB profile and the Firebase Auth user — and start over, with
    // no manual cleanup needed by the owner.
    const switchEmailLink = document.querySelector('.verify-link');
    if (switchEmailLink) {
        switchEmailLink.addEventListener('click', async (e) => {
            e.preventDefault();
            const ok = window.confirm(
                'Esto eliminará esta cuenta sin verificar para que puedas registrarte de nuevo con el correo correcto. ¿Continuar?'
            );
            if (!ok) return;

            statusLabel.textContent = 'Eliminando la cuenta sin verificar...';
            try {
                if (userRef) {
                    // 1) Server-side delete (Mongo profile + Firebase user) while the
                    //    token is still valid.
                    try {
                        const token = await userRef.getIdToken();
                        await fetch(API_BASE_URL + '/api/users/me', {
                            method: 'DELETE',
                            headers: { Authorization: 'Bearer ' + token },
                        });
                    } catch (err) {
                        console.warn('Server-side account delete failed:', err);
                    }
                    // 2) Client-side delete as a backstop (no-op if already removed).
                    try { await userRef.delete(); } catch (err) { /* already gone / needs recent login */ }
                    try { await auth.signOut(); } catch (err) { /* ignore */ }
                }
            } finally {
                sessionStorage.removeItem('verificationEmail');
                sessionStorage.removeItem('mcr_reg');
                window.location.href = '/register';
            }
        });
    }

    checkButton.addEventListener('click', async () => {
        if (!userRef) {
            statusLabel.textContent = 'Iniciá sesión para verificar tu correo.';
            return;
        }

        try {
            await userRef.reload();
            if (userRef.emailVerified) {
                sessionStorage.removeItem('verificationEmail');
                window.location.href = '/';
            } else {
                statusLabel.textContent = 'Tu correo aún no está verificado. Revisá tu bandeja de entrada o spam.';
            }
        } catch (error) {
            console.error('Check verification error:', error);
            statusLabel.textContent = 'No se pudo verificar el estado del correo.';
        }
    });
});
