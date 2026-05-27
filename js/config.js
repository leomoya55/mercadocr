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
