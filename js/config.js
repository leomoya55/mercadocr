// If served through Express (port 5000) or in production, use relative paths.
// If served through VS Code Live Server (any other port), point to Express directly.
const API_BASE_URL = (
  window.location.hostname !== 'localhost' &&
  window.location.hostname !== '127.0.0.1'
) ? '' : (window.location.port === '5000' ? '' : 'http://localhost:5000');

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}

/**
 * Make a Cloudinary image URL browser-friendly and optimized by injecting
 * f_auto,q_auto. This converts already-stored HEIC images (from older iPhone
 * uploads) to a format every browser can render, and serves WebP/AVIF where
 * supported. Safe/idempotent on non-Cloudinary URLs and URLs that already have it.
 */
function cldAuto(url) {
  if (typeof url !== 'string' || !url) return url || '';
  if (url.indexOf('res.cloudinary.com') === -1 || url.indexOf('/upload/') === -1) return url;
  if (/\/upload\/[^/]*f_auto/.test(url)) return url; // already optimized
  return url.replace('/upload/', '/upload/f_auto,q_auto/');
}

/**
 * Build a square, face-cropped, optimized avatar URL from a stored Cloudinary
 * secure_url. Falls back to the original string for non-Cloudinary URLs. Size is
 * the rendered pixel box (defaults to 200).
 */
function cldAvatar(url, size) {
  if (typeof url !== 'string' || !url) return '';
  var s = size || 200;
  if (url.indexOf('res.cloudinary.com') === -1 || url.indexOf('/upload/') === -1) return url;
  if (/\/upload\/[^/]*c_fill/.test(url)) return url; // already transformed
  return url.replace('/upload/', '/upload/c_fill,g_face,w_' + s + ',h_' + s + ',f_auto,q_auto/');
}

async function authFetch(url, options = {}) {
  const user = firebase.auth().currentUser;
  const token = user ? await user.getIdToken() : null;
  const headers = { ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!(options.body instanceof FormData)) {
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
  }
  return fetch(API_BASE_URL + url, { ...options, headers });
}
