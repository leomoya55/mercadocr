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

    // ─── Profile picture ──────────────────────────────────────────────────────
    const avatarInput     = document.getElementById('avatar-input');
    const avatarUploadBtn = document.getElementById('avatar-upload-btn');
    const avatarRemoveBtn = document.getElementById('avatar-remove-btn');
    const avatarImg       = document.getElementById('avatar-img');
    const avatarLetter    = document.getElementById('avatar-letter');
    const avatarStatus    = document.getElementById('avatar-status');

    // Reflect the current photo (or initial-letter fallback) in the preview.
    function renderAvatar(photoURL, nameSource) {
        if (photoURL) {
            avatarImg.src = cldAvatar(photoURL, 200);
            avatarImg.hidden = false;
            if (avatarLetter) avatarLetter.hidden = true;
            if (avatarRemoveBtn) avatarRemoveBtn.hidden = false;
        } else {
            avatarImg.hidden = true;
            if (avatarLetter) {
                avatarLetter.hidden = false;
                const n = (nameSource || '').trim();
                avatarLetter.textContent = n ? n.charAt(0).toUpperCase() : '?';
            }
            if (avatarRemoveBtn) avatarRemoveBtn.hidden = true;
        }
    }

    async function uploadAvatar(file) {
        if (!file || !file.type || !file.type.startsWith('image/')) {
            showStatus(avatarStatus, 'Selecciona una imagen válida.', 'error');
            return;
        }
        avatarUploadBtn.disabled = true;
        const original = avatarUploadBtn.textContent;
        avatarUploadBtn.textContent = 'Subiendo...';
        try {
            // 1. Signature for a direct-to-Cloudinary upload (avatars folder).
            const sigRes = await authFetch('/api/users/me/avatar-signature', { method: 'POST' });
            if (!sigRes.ok) throw new Error('No se pudo preparar la subida.');
            const sig = await sigRes.json();

            // 2. Upload straight to Cloudinary.
            const data = new FormData();
            data.append('file', file);
            data.append('api_key', sig.apiKey);
            data.append('timestamp', sig.timestamp);
            data.append('signature', sig.signature);
            if (sig.folder) data.append('folder', sig.folder);
            const cldRes = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`, {
                method: 'POST', body: data,
            });
            const payload = await cldRes.json().catch(() => ({}));
            if (!cldRes.ok || !payload.secure_url) {
                throw new Error((payload.error && payload.error.message) || 'No se pudo subir la imagen.');
            }

            // 3. Persist the URL on the profile.
            const saveRes = await authFetch('/api/users/me/photo', {
                method: 'PUT',
                body: JSON.stringify({ photoURL: payload.secure_url }),
            });
            if (!saveRes.ok) throw new Error('No se pudo guardar la foto.');
            const saved = await saveRes.json();

            UserStore.invalidate();
            renderAvatar(saved.photoURL, profileForm['nombre'].value);
            showStatus(avatarStatus, 'Foto actualizada.', 'success');
        } catch (err) {
            console.error('[settings] avatar upload failed:', err);
            showStatus(avatarStatus, err.message || 'Error al subir la foto.', 'error');
        } finally {
            avatarUploadBtn.disabled = false;
            avatarUploadBtn.textContent = original;
        }
    }

    async function removeAvatar() {
        avatarRemoveBtn.disabled = true;
        try {
            const res = await authFetch('/api/users/me/photo', {
                method: 'PUT',
                body: JSON.stringify({ photoURL: '' }),
            });
            if (!res.ok) throw new Error('No se pudo quitar la foto.');
            UserStore.invalidate();
            renderAvatar('', profileForm['nombre'].value);
            showStatus(avatarStatus, 'Foto eliminada.', 'success');
        } catch (err) {
            showStatus(avatarStatus, err.message || 'Error al quitar la foto.', 'error');
        } finally {
            avatarRemoveBtn.disabled = false;
        }
    }

    if (avatarUploadBtn) avatarUploadBtn.addEventListener('click', () => avatarInput && avatarInput.click());
    if (avatarInput) avatarInput.addEventListener('change', () => {
        const file = avatarInput.files && avatarInput.files[0];
        if (file) uploadAvatar(file);
        avatarInput.value = ''; // allow re-selecting the same file
    });
    if (avatarRemoveBtn) avatarRemoveBtn.addEventListener('click', removeAvatar);

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
            note.innerHTML = 'Para cambiar tu número escríbenos a <a href="mailto:soporte@mercaticocr.com" style="color:#e8c97a;">soporte@mercaticocr.com</a>.';
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

            renderAvatar(profile.photoURL || '', nombre || user.email);

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
