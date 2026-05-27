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

    checkButton.addEventListener('click', async () => {
        if (!userRef) {
            statusLabel.textContent = 'Iniciá sesión para verificar tu correo.';
            return;
        }

        try {
            await userRef.reload();
            if (userRef.emailVerified) {
                sessionStorage.removeItem('verificationEmail');
                window.location.href = 'index.html';
            } else {
                statusLabel.textContent = 'Tu correo aún no está verificado. Revisá tu bandeja de entrada o spam.';
            }
        } catch (error) {
            console.error('Check verification error:', error);
            statusLabel.textContent = 'No se pudo verificar el estado del correo.';
        }
    });
});
