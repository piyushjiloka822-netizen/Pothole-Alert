/**
 * Firebase Config — OPTIONAL, enables a real shared database.
 *
 * Without this filled in, the app works exactly as before: each browser
 * keeps its own localStorage copy of reports, and citizen/admin only see
 * the same data if used in two tabs of the SAME browser.
 *
 * To turn on a real shared database (citizen reports visible to admin,
 * and vice versa, across any device):
 *
 *   1. Go to https://console.firebase.google.com/ → Add project (free
 *      "Spark" plan is enough).
 *   2. In the project, go to Build → Firestore Database → Create database
 *      (start in "test mode" for a prototype, or use the rules below).
 *   3. Go to Project settings (gear icon) → General → "Your apps" → Add
 *      app → Web (</>) → register it → copy the firebaseConfig object it
 *      shows you.
 *   4. Paste those values below, replacing the placeholders.
 *   5. Recommended Firestore security rules for a public-write prototype
 *      like this one (Firestore → Rules tab):
 *
 *        rules_version = '2';
 *        service cloud.firestore {
 *          match /databases/{database}/documents {
 *            match /reports/{reportId} {
 *              allow read: if true;
 *              allow create: if true;
 *              allow update: if true; // needed for upvotes from any citizen
 *              allow delete: if false; // only remove via Firebase console
 *            }
 *            match /notifications/{notifId} {
 *              allow read: if true;   // filtered client-side by userId
 *              allow create: if true;
 *              allow update: if true; // needed to mark notifications read
 *              allow delete: if false;
 *            }
 *          }
 *        }
 *
 *      This keeps it a true zero-backend static site (no server code to
 *      write or host) while giving you a real shared database. For a
 *      production deployment you'd want proper auth-gated rules instead.
 *
 * That's the only file you need to touch — js/cloud-sync.js and
 * js/storage.js already know how to use it once it's filled in.
 */

window.FIREBASE_CONFIG = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT_ID.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT_ID.appspot.com',
  messagingSenderId: 'YOUR_SENDER_ID',
  appId: 'YOUR_APP_ID',
};
