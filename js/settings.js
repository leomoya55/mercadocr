document.addEventListener('DOMContentLoaded', () => {
    const profileForm    = document.getElementById('profile-form');
    const passwordForm   = document.getElementById('password-form');
    const profileStatus  = document.getElementById('profile-status');
    const passwordStatus = document.getElementById('password-status');

    function showStatus(el, message, type) {
        el.textContent = message;
        el.className = `settings-status ${type}`;
        setTimeout(() => { el.className = 'settings-status'; el.textContent = ''; }, 4000);
    }

    function lockNameFields() {
        const nombreInput   = profileForm['nombre'];
        const apellidoInput = profileForm['apellido'];
        [nombreInput, apellidoInput].forEach(el => {
            el.readOnly = true;
            el.style.opacity = '0.5';
            el.style.cursor  = 'not-allowed';
            el.title = 'El nombre no puede modificarse una vez registrado';
        });
        const existingNote = document.getElementById('name-lock-note');
        if (!existingNote) {
            const note = document.createElement('p');
            note.id = 'name-lock-note';
            note.style.cssText = 'font-size:0.82rem;color:#888;margin-top:-0.5rem;';
            note.textContent = 'El nombre no puede modificarse una vez registrado.';
            nombreInput.closest('.form-row').after(note);
        }
    }

    // Phone is the WhatsApp number shown on every listing — lock it once set.
    // This is a UX hint only; the server (PUT /me/profile) is the real enforcer.
    function lockPhoneField() {
        const phoneInput = profileForm['phone'];
        if (!phoneInput) return;
        phoneInput.readOnly = true;
        phoneInput.style.opacity = '0.5';
        phoneInput.style.cursor  = 'not-allowed';
        phoneInput.title = 'El teléfono no puede modificarse aquí. Escríbenos a soporte para cambiarlo.';
        if (!document.getElementById('phone-lock-note')) {
            const note = document.createElement('p');
            note.id = 'phone-lock-note';
            note.style.cssText = 'font-size:0.82rem;color:#888;margin-top:-0.5rem;';
            note.innerHTML = 'Para cambiar tu número escríbenos a <a href="mailto:soporte@mercadocr.com" style="color:#e8c97a;">soporte@mercadocr.com</a>.';
            phoneInput.after(note);
        }
    }

    // ─── Load profile ─────────────────────────────────────────────────────────
    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.href = '/login';
            return;
        }

        try {
            // UserStore handles retries + mcr_reg forwarding automatically
            const data    = await UserStore.getProfile(user);
            const profile = data.user || {};

            // Fallback: if DB has no name, parse Firebase displayName
            let nombre   = profile.nombre   || '';
            let apellido = profile.apellido || '';
            if (!nombre && user.displayName) {
                const parts = user.displayName.trim().split(' ');
                nombre   = parts[0] || '';
                apellido = parts.slice(1).join(' ') || '';
            }

            profileForm['nombre'].value    = nombre;
            profileForm['apellido'].value  = apellido;
            profileForm['phone'].value     = profile.phone     || '';
            profileForm['provincia'].value = profile.provincia || '';

            if (nombre && apellido) lockNameFields();
            // Lock the phone field only if one is already saved (settable once).
            if (profile.phone && profile.phone.trim()) lockPhoneField();
        } catch (err) {
            console.error('[settings] profile load failed:', err);
            // Fallback to Firebase displayName if API is down
            if (user.displayName) {
                const parts = user.displayName.trim().split(' ');
                profileForm['nombre'].value   = parts[0] || '';
                profileForm['apellido'].value = parts.slice(1).join(' ') || '';
                if (profileForm['nombre'].value && profileForm['apellido'].value) lockNameFields();
            }
        }
    });

    // ─── Save profile ─────────────────────────────────────────────────────────
    profileForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user) return;

        const btn = document.getElementById('profile-save');
        btn.disabled = true;
        btn.textContent = 'Guardando...';

        const nombre    = profileForm['nombre'].value.trim();
        const apellido  = profileForm['apellido'].value.trim();
        const phone     = profileForm['phone'].value.trim();
        const provincia = profileForm['provincia'].value;

        try {
            // Retry up to 3 times — different Vercel instances may be cold
            let saveRes;
            for (let attempt = 1; attempt <= 3; attempt++) {
                saveRes = await authFetch('/api/users/me/profile', {
                    method: 'PUT',
                    body: JSON.stringify({ nombre, apellido, phone, provincia }),
                });
                if (saveRes.ok || saveRes.status === 409) break;
                if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
            }

            if (saveRes.status === 409) {
                throw new Error('Este número de teléfono ya está registrado en otra cuenta.');
            }
            if (!saveRes.ok) {
                const errText = await saveRes.text().catch(() => String(saveRes.status));
                throw new Error(`Error del servidor (${saveRes.status}): ${errText}`);
            }

            // Invalidate profile cache so other pages re-fetch the new data
            UserStore.invalidate();

            // Update Firebase display name
            await user.updateProfile({ displayName: `${nombre} ${apellido}` });
            const navBtn = document.getElementById('nav-user-btn');
            if (navBtn) navBtn.textContent = `${nombre} ${apellido}`;

            lockNameFields();
            showStatus(profileStatus, 'Perfil actualizado con éxito.', 'success');
        } catch (err) {
            console.error('Profile save failed:', err.message);
            showStatus(
                profileStatus,
                err.message.startsWith('Este número')
                    ? err.message
                    : 'Error al guardar el perfil. Intenta de nuevo.',
                'error'
            );
        } finally {
            btn.disabled = false;
            btn.textContent = 'Guardar cambios';
        }
    });

    // ─── Change password ──────────────────────────────────────────────────────
    passwordForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const user = auth.currentUser;
        if (!user) return;

        const currentPassword = passwordForm['currentPassword'].value;
        const newPassword     = passwordForm['newPassword'].value;
        const confirmPassword = passwordForm['confirmPassword'].value;

        if (newPassword !== confirmPassword) {
            showStatus(passwordStatus, 'Las contraseñas nuevas no coinciden.', 'error');
            return;
        }

        const btn = document.getElementById('password-save');
        btn.disabled = true;
        btn.textContent = 'Cambiando...';

        try {
            const credential = firebase.auth.EmailAuthProvider.credential(user.email, currentPassword);
            await user.reauthenticateWithCredential(credential);
            await user.updatePassword(newPassword);
            passwordForm.reset();
            showStatus(passwordStatus, 'Contraseña cambiada con éxito.', 'success');
        } catch (err) {
            const msg = err.code === 'auth/wrong-password'
                ? 'La contraseña actual es incorrecta.'
                : 'Error al cambiar la contraseña.';
            showStatus(passwordStatus, msg, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Cambiar contraseña';
        }
    });
});
