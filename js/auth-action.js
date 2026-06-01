/**
 * auth-action.js — custom Firebase email action handler (on our own domain).
 *
 * Firebase is configured (Console → Authentication → Templates → custom action
 * URL) to send users here: /auth-action?mode=...&oobCode=...
 * This page applies the code with the Firebase SDK and shows a branded result,
 * instead of the default firebaseapp.com page.
 *
 * Handles: verifyEmail, recoverEmail, resetPassword.
 */
document.addEventListener('DOMContentLoaded', function () {
  var card = document.getElementById('action-card');
  var params = new URLSearchParams(window.location.search);
  var mode = params.get('mode');
  var oobCode = params.get('oobCode');

  function render(html) { card.innerHTML = html; }
  function loading(text) { render('<div class="aa-spinner"></div><h2>' + text + '</h2>'); }
  function ok(title, msg, btnText, btnHref) {
    render(
      '<div class="aa-icon">✅</div>' +
      '<h2>' + title + '</h2>' +
      '<p>' + msg + '</p>' +
      '<a class="cta-button" href="' + (btnHref || '/login') + '">' + (btnText || 'Iniciar sesión') + '</a>'
    );
  }
  function fail(title, msg, btnText, btnHref) {
    render(
      '<div class="aa-icon">⚠️</div>' +
      '<h2>' + title + '</h2>' +
      '<p>' + msg + '</p>' +
      '<a class="cta-button" href="' + (btnHref || '/login') + '">' + (btnText || 'Ir a iniciar sesión') + '</a>'
    );
  }

  if (!mode || !oobCode) {
    fail('Enlace inválido', 'Este enlace no es válido o está incompleto. Solicitá uno nuevo desde tu cuenta.');
    return;
  }

  // ─── Verify email (and recover email) ──────────────────────────────────────
  if (mode === 'verifyEmail' || mode === 'recoverEmail') {
    loading('Verificando tu correo…');
    auth.applyActionCode(oobCode).then(function () {
      ok('¡Correo verificado!',
         'Tu cuenta de MercaTico ya está activa. Iniciá sesión para empezar a comprar y vender.',
         'Iniciar sesión', '/login');
    }).catch(function () {
      fail('El enlace expiró',
           'Este enlace de verificación ya no es válido. Iniciá sesión y pedí que te enviemos uno nuevo.',
           'Ir a iniciar sesión', '/login');
    });
    return;
  }

  // ─── Reset password ─────────────────────────────────────────────────────────
  if (mode === 'resetPassword') {
    loading('Cargando…');
    auth.verifyPasswordResetCode(oobCode).then(function (email) {
      render(
        '<div class="aa-icon">🔒</div>' +
        '<h2>Nueva contraseña</h2>' +
        '<p>Elegí una contraseña nueva para <strong>' + (email || 'tu cuenta') + '</strong>.</p>' +
        '<form id="aa-reset-form">' +
          '<label for="aa-pass">Nueva contraseña</label>' +
          '<input type="password" id="aa-pass" autocomplete="new-password" minlength="6" required>' +
          '<label for="aa-pass2">Confirmar contraseña</label>' +
          '<input type="password" id="aa-pass2" autocomplete="new-password" minlength="6" required>' +
          '<p class="aa-error" id="aa-err" style="display:none;"></p>' +
          '<button type="submit" class="cta-button" style="margin-top:0.75rem;">Guardar contraseña</button>' +
        '</form>'
      );

      var form = document.getElementById('aa-reset-form');
      var err = document.getElementById('aa-err');
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var p1 = document.getElementById('aa-pass').value;
        var p2 = document.getElementById('aa-pass2').value;
        err.style.display = 'none';
        if (p1.length < 6) { err.textContent = 'La contraseña debe tener al menos 6 caracteres.'; err.style.display = 'block'; return; }
        if (p1 !== p2)     { err.textContent = 'Las contraseñas no coinciden.'; err.style.display = 'block'; return; }

        var btn = form.querySelector('button');
        btn.disabled = true; btn.textContent = 'Guardando…';
        auth.confirmPasswordReset(oobCode, p1).then(function () {
          ok('¡Contraseña actualizada!',
             'Ya podés iniciar sesión con tu nueva contraseña.',
             'Iniciar sesión', '/login');
        }).catch(function () {
          fail('No se pudo cambiar la contraseña',
               'El enlace pudo haber expirado. Pedí un nuevo enlace de recuperación.',
               'Recuperar contraseña', '/forgot-password');
        });
      });
    }).catch(function () {
      fail('El enlace expiró',
           'Este enlace de recuperación ya no es válido. Solicitá uno nuevo.',
           'Recuperar contraseña', '/forgot-password');
    });
    return;
  }

  // ─── Unknown mode ─────────────────────────────────────────────────────────
  fail('Acción no reconocida', 'No pudimos procesar este enlace.');
});
