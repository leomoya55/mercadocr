document.addEventListener('DOMContentLoaded', () => {
    const profileForm  = document.getElementById('profile-form');
    const passwordForm = document.getElementById('password-form');
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
        // Add note below the name row
        const existingNote = document.getElementById('name-lock-note');
        if (!existingNote) {
            const note = document.createElement('p');
            note.id = 'name-lock-note';
            note.style.cssText = 'font-size:0.82rem;color:#888;margin-top:-0.5rem;';
            note.textContent = 'El nombre no puede modificarse una vez registrado.';
            nombreInput.closest('.form-row').after(note);
        }
    }

    auth.onAuthStateChanged(async (user) => {
        if (!user) {
            window.location.href = '/login';
            return;
        }

        try {
            let res = await authFetch(`/api/users/${user.uid}`);

            // Profile may not exist yet for brand-new users — create it then retry
            if (res.status === 404) {
                await authFetch('/api/users/ensure', {
                    method: 'POST',
                    body: JSON.stringify({ email: user.email }),
                });
                res = await authFetch(`/api/users/${user.uid}`);
            }

            const data = await res.json();
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
        } catch (err) {
            console.error(err);
            // Fallback to Firebase displayName even if API fails
            if (user.displayName) {
                const parts = user.displayName.trim().split(' ');
                profileForm['nombre'].value   = parts[0] || '';
                profileForm['apellido'].value = parts.slice(1).join(' ') || '';
                if (profileForm['nombre'].value && profileForm['apellido'].value) lockNameFields();
            }
        }
    });

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
            const saveRes = await authFetch(`/api/users/${user.uid}/profile`, {
                method: 'PUT',
                body: JSON.stringify({ nombre, apellido, phone, provincia }),
            });

            if (!saveRes.ok) {
                const errText = await saveRes.text().catch(() => saveRes.status);
                throw new Error(`Server error: ${errText}`);
            }

            // Update Firebase display name
            await user.updateProfile({ displayName: `${nombre} ${apellido}` });
            const navBtn = document.getElementById('nav-user-btn');
            if (navBtn) navBtn.textContent = `${nombre} ${apellido}`;

            // Lock name fields now that they're set
            lockNameFields();

            showStatus(profileStatus, 'Perfil actualizado con éxito.', 'success');
        } catch (err) {
            console.error('Profile save failed:', err.message);
            showStatus(profileStatus, 'Error al guardar el perfil. Intenta de nuevo.', 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = 'Guardar cambios';
        }
    });

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
