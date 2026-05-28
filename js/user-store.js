/**
 * UserStore — centralized user profile cache.
 *
 * Responsibilities:
 *  - Fetch GET /api/users/me (with retries for cold-start)
 *  - Forward sessionStorage.mcr_reg data on first login after registration
 *  - Always override plan to 'pro' for the owner account
 *  - Cache result for 2 minutes (invalidated by UserStore.invalidate())
 *  - Deduplicate concurrent getProfile() calls with a single in-flight promise
 *
 * Must load AFTER: firebase-config.js, config.js (provides authFetch, API_BASE_URL)
 * Must load BEFORE: dashboard.js, publish.js, settings.js
 *
 * Cache shape: { user, listingCount, remaining, maxListings, credits, _ts }
 *   remaining   — number of slots left (null = unlimited, e.g. Pro)
 *   maxListings — plan cap (null = unlimited)
 *   credits     — singlePostCredits for free users who bought extra posts
 */
(function () {
  'use strict';

  const CACHE_MS    = 120_000; // 2 minutes
  const OWNER_EMAIL = 'leomoyawr300@gmail.com';
  const MAX_RETRIES = 3;
  const RETRY_BASE  = 800; // ms — multiplied by attempt number

  let _cache    = null; // { user, listingCount, _ts }
  let _inflight = null; // deduplicates concurrent calls

  // ── Core fetch (retries for cold-start DB reconnects) ──────────────────────
  async function _fetchMe() {
    for (let i = 1; i <= MAX_RETRIES; i++) {
      try {
        const res = await authFetch('/api/users/me');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json && json.user) return json;
        throw new Error('No user in response');
      } catch (err) {
        console.warn(`[UserStore] fetch attempt ${i}/${MAX_RETRIES} failed:`, err.message);
        if (i < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_BASE * i));
      }
    }
    throw new Error('Profile unavailable after retries');
  }

  // ── Forward registration data saved by register.js ─────────────────────────
  // On the first login after registration, sessionStorage.mcr_reg holds
  // { nombre, apellido, phone, provincia }. We PUT those to /me/profile so they
  // are stored permanently, then re-fetch the updated profile.
  async function _forwardRegData(data) {
    const raw = sessionStorage.getItem('mcr_reg');
    if (!raw) return data;
    sessionStorage.removeItem('mcr_reg');

    let reg;
    try { reg = JSON.parse(raw); } catch { return data; }

    // Only send if the profile is still missing key registration fields
    if (data.user.nombre && data.user.phone) return data;

    try {
      await authFetch('/api/users/me/profile', {
        method: 'PUT',
        body: JSON.stringify({
          nombre:    reg.nombre    || '',
          apellido:  reg.apellido  || '',
          phone:     reg.phone     || '',
          provincia: reg.provincia || '',
        }),
      });

      // Re-fetch to return the updated profile
      const res2 = await authFetch('/api/users/me');
      if (res2.ok) {
        const j2 = await res2.json();
        if (j2 && j2.user) return j2;
      }
    } catch (e) {
      console.warn('[UserStore] mcr_reg forward failed:', e.message);
    }

    return data;
  }

  // ── Main fetch pipeline ─────────────────────────────────────────────────────
  async function _doFetch(firebaseUser) {
    let data = await _fetchMe();
    data     = await _forwardRegData(data);

    // Owner always gets Pro — regardless of what the DB says
    if (firebaseUser.email === OWNER_EMAIL) data.user.plan = 'pro';

    return data;
  }

  // ── Public API ──────────────────────────────────────────────────────────────
  window.UserStore = {
    /**
     * Get the user's profile.
     * Returns cached data if it's still fresh; fetches otherwise.
     * Concurrent calls share the same in-flight request.
     *
     * @param {firebase.User} firebaseUser
     * @param {boolean}       forceRefresh  — bypass cache (e.g. after payment)
     * @returns {Promise<{ user, listingCount, _ts }>}
     */
    async getProfile(firebaseUser, forceRefresh = false) {
      if (!forceRefresh && _cache && (Date.now() - _cache._ts) < CACHE_MS) {
        return _cache;
      }

      // Return the existing in-flight promise to avoid duplicate requests
      if (_inflight) return _inflight;

      _inflight = _doFetch(firebaseUser)
        .then(data => {
          _cache = { ...data, _ts: Date.now() };
          window.userProfile = _cache;
          return _cache;
        })
        .finally(() => { _inflight = null; });

      return _inflight;
    },

    /**
     * Invalidate the cache.
     * Call this after publishing a listing, upgrading a plan, or saving profile.
     */
    invalidate() {
      _cache = null;
      window.userProfile = null;
    },

    /** Current cached profile (null before first successful fetch) */
    get current() { return _cache; },
  };
})();
