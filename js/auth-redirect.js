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

        // Redirect unverified users away from actions that REQUIRE a verified
        // email (publishing, admin). The dashboard and settings stay OPEN to
        // unverified users so a delivery hiccup never hard-locks them out — the
        // dashboard shows a "verify to publish" banner with a resend button
        // instead. The server still enforces verification on publish/upload.
        // The site uses CLEAN urls (/dashboard, not /dashboard.html), so normalize.
        const path = (window.location.pathname || '/').replace(/\.html$/, '');
        const PROTECTED = ['/publish', '/admin'];
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

            // Point "Mi perfil público" at the user's own public seller page so
            // they can open it, copy the URL, and share it. The username is
            // resolved from the public profile endpoint and cached in
            // sessionStorage to avoid refetching on every page. Until resolved,
            // the link falls back to the generic /perfil directory.
            const profileLink = document.querySelector('[data-profile-link]');
            if (profileLink) {
                const cacheKey = 'mcr_username_' + user.uid;
                const cached = sessionStorage.getItem(cacheKey);
                if (cached) {
                    profileLink.href = '/perfil?u=' + encodeURIComponent(cached);
                } else if (typeof API_BASE_URL !== 'undefined') {
                    fetch(API_BASE_URL + '/api/users/public/' + encodeURIComponent(user.uid))
                        .then(r => (r.ok ? r.json() : null))
                        .then(d => {
                            if (d && d.username) {
                                try { sessionStorage.setItem(cacheKey, d.username); } catch (e) {}
                                profileLink.href = '/perfil?u=' + encodeURIComponent(d.username);
                            }
                        })
                        .catch(() => {});
                }
            }
        }
    });
});
