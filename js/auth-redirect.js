document.addEventListener('DOMContentLoaded', () => {
    // Publish CTA: redirect to login if not authenticated
    document.querySelectorAll('[data-publish-cta]').forEach(link => {
        link.addEventListener('click', event => {
            if (!auth.currentUser) {
                event.preventDefault();
                window.location.href = '/login';
            }
        });
    });

    // Dropdown toggle
    const userMenu = document.getElementById('nav-user-menu');
    const dropdown = userMenu?.querySelector('.nav-dropdown');
    document.getElementById('nav-user-btn')?.addEventListener('click', () => {
        dropdown?.classList.toggle('open');
    });
    document.addEventListener('click', e => {
        if (userMenu && !userMenu.contains(e.target)) {
            dropdown?.classList.remove('open');
        }
    });

    // Logout
    document.getElementById('nav-logout')?.addEventListener('click', () => {
        auth.signOut().then(() => { window.location.href = '/'; });
    });

    // Show/hide nav items based on auth state
    auth.onAuthStateChanged(user => {
        document.querySelectorAll('[data-auth-only]').forEach(el => {
            el.classList.toggle('nav-hidden', !user);
        });
        document.querySelectorAll('[data-guest-only]').forEach(el => {
            el.classList.toggle('nav-hidden', !!user);
        });

        if (user) {
            const name = user.displayName || user.email.split('@')[0];
            const btn = document.getElementById('nav-user-btn');
            if (btn) btn.textContent = name;
        }
    });
});
