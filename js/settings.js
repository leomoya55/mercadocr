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
            const res = await authFetch(`/api/users/${user.uid}`);
            const { user: profile } = await res.json();

            profileForm['nombre'].value    = profile.nombre    || '';
            profileForm['apellido'].value  = profile.apellido  || '';
            profileForm['phone'].value     = profile.phone     || '';
            profileForm['provincia'].value = profile.provincia || '';

            // Lock name fields if already set
            if (profile.nombre && profile.apellido) {
                lockNameFields();
            }
        } catch (err) {
            console.error(err);
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
            await authFetch(`/api/users/${user.uid}/profile`, {
                method: 'PUT',
                body: JSON.stringify({ nombre, apellido, phone, provincia }),
            });

            // Update Firebase display name
            await user.updateProfile({ displayName: `${nombre} ${apellido}` });
            const navBtn = document.getElementById('nav-user-btn');
            if (navBtn) navBtn.textContent = `${nombre} ${apellido}`;

            // Lock name fields now that they're set
            lockNameFields();

            showStatus(profileStatus, 'Perfil actualizado con éxito.', 'success');
        } catch {
            showStatus(profileStatus, 'Error al guardar el perfil.', 'error');
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
