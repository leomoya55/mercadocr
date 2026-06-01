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

    const OWNER_EMAIL = 'leomoyawr300@gmail.com';

    // Show/hide nav items based on auth state
    auth.onAuthStateChanged(async user => {
        const isVerified = user && user.emailVerified;

        // Redirect unverified users from protected pages
        const protectedPaths = ['/dashboard.html', '/publish.html', '/settings.html', '/admin.html', '/listings.html'];
        if (user && !isVerified && protectedPaths.includes(window.location.pathname)) {
            window.location.href = '/verify-email.html';
            return;
        }

        document.querySelectorAll('[data-auth-only]').forEach(el => {
            el.classList.toggle('nav-hidden', !user);
        });
        document.querySelectorAll('[data-guest-only]').forEach(el => {
            el.classList.toggle('nav-hidden', !!user);
        });

        // Admin link — only visible to the owner account
        document.querySelectorAll('[data-admin-only]').forEach(el => {
            const isOwner = user && user.email === OWNER_EMAIL;
            el.classList.toggle('nav-hidden', !isOwner);
        });

        if (user) {
            const name = user.displayName || user.email.split('@')[0];
            const btn = document.getElementById('nav-user-btn');
            if (btn) btn.textContent = name;
        }
    });
});
