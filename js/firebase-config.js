const firebaseConfig = {
  apiKey: "AIzaSyChuCElA-Z_poVADqoPb6bzWrfMJNcOEMk",
  authDomain: "mercadotico-1ff96.firebaseapp.com",
  projectId: "mercadotico-1ff96",
  storageBucket: "mercadotico-1ff96.firebasestorage.app",
  messagingSenderId: "1019885037657",
  appId: "1:1019885037657:web:f54fb2054ada3374d92948",
  measurementId: "G-WB7S46Z797"
};
firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();

// Keep the user signed in across page navigations and reloads. LOCAL is the SDK
// default, but we set it EXPLICITLY so the session is never silently downgraded
// to in-memory (which would log the user out on every full-page navigation —
// a behavior seen on iOS Safari). Best-effort: if the browser blocks persistent
// storage we keep whatever the SDK falls back to instead of throwing.
try {
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .catch(function (e) { console.warn('[auth] persistence:', e && e.message); });
} catch (e) { /* older SDK — ignore */ }
