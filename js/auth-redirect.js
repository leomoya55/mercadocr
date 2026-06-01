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

        // Redirect unverified users away from protected pages (panel, publishing,
        // settings, admin). Public pages (home, listings, product) stay open.
        // The site uses CLEAN urls (/dashboard, not /dashboard.html), so normalize.
        const path = (window.location.pathname || '/').replace(/\.html$/, '');
        const PROTECTED = ['/dashboard', '/publish', '/settings', '/admin'];
        const onProtected = PROTECTED.some(p => path === p || path.indexOf(p + '/') === 0);
        if (user && onProtected && !user.emailVerified) {
            // The cached token can lag after a user verifies — refresh once before
            // deciding, so we never bounce someone who already verified.
            try { await user.reload(); } catch (e) {}
            if (!auth.currentUser || !auth.currentUser.emailVerified) {
                try { sessionStorage.setItem('verificationEmail', user.email || ''); } catch (e) {}
                window.location.replace('/verify-email');
                return;
            }
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
