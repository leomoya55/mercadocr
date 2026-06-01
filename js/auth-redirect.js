document.addEventListener('DOMContentLoaded', () => {
    // ─── Mobile menu toggle ───────────────────────────────────────────────────
    // Inject a hamburger/account button into the nav (kept out of the HTML so it
    // stays consistent across every page). On mobile it sits top-right; tapping
    // it opens the nav links panel. Its label shows the user's name when logged in.
    const navEl = document.querySelector('header nav');
    const navUl = navEl ? navEl.querySelector('ul') : null;
    if (navEl && navUl && !document.getElementById('nav-toggle')) {
        const toggle = document.createElement('button');
        toggle.id = 'nav-toggle';
        toggle.className = 'nav-toggle';
        toggle.type = 'button';
        toggle.setAttribute('aria-label', 'Abrir menú');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = '<span class="nav-toggle-label">Menú</span>' +
                           '<span class="nav-toggle-icon" aria-hidden="true">☰</span>';
        navEl.insertBefore(toggle, navUl);
        toggle.addEventListener('click', () => {
            const open = navUl.classList.toggle('nav-open');
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
        });
        // Close the panel after tapping a link.
        navUl.addEventListener('click', (e) => {
            if (e.target.closest('a')) navUl.classList.remove('nav-open');
        });
    }

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

        const toggleLabel = document.querySelector('#nav-toggle .nav-toggle-label');
        if (user) {
            const name = user.displayName || user.email.split('@')[0];
            const btn = document.getElementById('nav-user-btn');
            if (btn) btn.textContent = name;
            if (toggleLabel) toggleLabel.textContent = name; // show name top-right on mobile
        } else if (toggleLabel) {
            toggleLabel.textContent = 'Menú';
        }
    });
});
