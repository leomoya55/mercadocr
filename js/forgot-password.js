document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('forgot-password-form');
  const emailInput = document.getElementById('email');
  const submitButton = document.getElementById('submit-button');
  const statusMessage = document.getElementById('status-message');

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value;

    if (!email) {
      statusMessage.textContent = 'Por favor, ingresa tu correo electrónico.';
      statusMessage.className = 'status-message error';
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Enviando...';
    statusMessage.textContent = '';
    statusMessage.className = 'status-message';

    try {
      await auth.sendPasswordResetEmail(email);
      statusMessage.textContent = '¡Éxito! Revisa tu correo electrónico (incluida la carpeta de spam) para obtener el enlace y restablecer tu contraseña.';
      statusMessage.className = 'status-message success';
      form.reset();
    } catch (error) {
      console.error('Error sending password reset email:', error);
      let message = 'Ocurrió un error. Por favor, inténtalo de nuevo.';
      if (error.code === 'auth/user-not-found') {
        message = 'No se encontró ninguna cuenta con ese correo electrónico.';
      }
      statusMessage.textContent = message;
      statusMessage.className = 'status-message error';
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Enviar Enlace';
    }
  });
});
