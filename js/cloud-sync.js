/**
 * Cloud Sync Module — Pothole Reporting Application
 *
 * Optional real-time shared database (Firebase Firestore) sitting on top
 * of the existing localStorage layer in storage.js.
 *
 * Design goal: app.js and admin.js don't need to change how they call
 * Storage.* — those calls stay synchronous and keep working off the
 * localStorage cache. This module's job is just to keep that cache in
 * sync with a shared Firestore collection so that citizen submissions and
 * admin actions are visible across devices/browsers, not just one.
 *
 * If js/firebase-config.js still has placeholder values (i.e. no one has
 * set up a Firebase project), this module quietly does nothing and the
 * app behaves exactly like the original localStorage-only prototype.
 */

const CloudSync = (() => {
  const REPORTS_KEY = 'pothole_reports_v2';
  const NOTIF_KEY = 'pothole_notifications';
  let db = null;
  let enabled = false;

  function isConfigured() {
    const c = window.FIREBASE_CONFIG;
    return !!(c && c.apiKey && c.projectId && c.apiKey !== 'YOUR_API_KEY');
  }

  function isEnabled() {
    return enabled;
  }

  /**
   * Initializes Firebase + Firestore and starts a live listener that
   * mirrors the "reports" collection into localStorage, then notifies
   * the rest of the app via a 'cloud-reports-updated' window event so
   * app.js / admin.js can re-render.
   */
  function init() {
    if (!isConfigured()) {
      console.log('[CloudSync] Firebase not configured — running in local-only (per-browser) mode. See js/firebase-config.js to enable a shared database.');
      return false;
    }
    if (typeof firebase === 'undefined') {
      console.warn('[CloudSync] Firebase SDK did not load (offline, or CDN blocked) — falling back to local-only mode.');
      return false;
    }

    try {
      if (!firebase.apps.length) firebase.initializeApp(window.FIREBASE_CONFIG);
      db = firebase.firestore();
      enabled = true;

      db.collection('reports').onSnapshot(
        (snapshot) => {
          const reports = snapshot.docs
            .map(d => d.data())
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          localStorage.setItem(REPORTS_KEY, JSON.stringify(reports));
          window.dispatchEvent(new CustomEvent('cloud-reports-updated', { detail: reports }));
        },
        (err) => {
          console.error('[CloudSync] Firestore listener error — staying on local cache:', err);
        }
      );

      console.log('[CloudSync] Connected — reports now sync live across all devices.');
      return true;
    } catch (err) {
      console.error('[CloudSync] Failed to initialize Firebase — falling back to local-only mode:', err);
      enabled = false;
      return false;
    }
  }

  /* ── Fire-and-forget write-through helpers, called from storage.js ── */

  async function pushReport(report) {
    if (!enabled) return;
    try {
      await db.collection('reports').doc(report.id).set(report);
    } catch (err) {
      console.error('[CloudSync] pushReport failed (saved locally only):', err);
    }
  }

  async function updateReport(id, updates) {
    if (!enabled) return;
    try {
      await db.collection('reports').doc(id).set(updates, { merge: true });
    } catch (err) {
      console.error('[CloudSync] updateReport failed (saved locally only):', err);
    }
  }

  async function deleteReport(id) {
    if (!enabled) return;
    try {
      await db.collection('reports').doc(id).delete();
    } catch (err) {
      console.error('[CloudSync] deleteReport failed (removed locally only):', err);
    }
  }

  /* ── Notifications ──────────────────────────────────────────────
   * Admin actions (status changes, escalation) call Storage.addNotification
   * for the reporting citizen's userId. Without a shared store that
   * notification only ever lived in the admin's own browser and the
   * citizen — on a different device — would never see it. This mirrors
   * per-user notifications through Firestore the same way reports are
   * mirrored, so the loop actually closes across devices.
   */

  function initNotifications(userId) {
    if (!enabled || !userId) return;
    try {
      db.collection('notifications')
        .where('userId', '==', userId)
        .onSnapshot(
          (snapshot) => {
            const notifs = snapshot.docs
              .map(d => d.data())
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
              .slice(0, 20);
            let all = {};
            try { all = JSON.parse(localStorage.getItem(NOTIF_KEY)) || {}; } catch {}
            all[userId] = notifs;
            localStorage.setItem(NOTIF_KEY, JSON.stringify(all));
            window.dispatchEvent(new CustomEvent('cloud-notifications-updated'));
          },
          (err) => console.error('[CloudSync] notifications listener error:', err)
        );
    } catch (err) {
      console.error('[CloudSync] initNotifications failed:', err);
    }
  }

  async function pushNotification(userId, notification) {
    if (!enabled) return;
    try {
      await db.collection('notifications').doc(String(notification.id)).set({ userId, ...notification });
    } catch (err) {
      console.error('[CloudSync] pushNotification failed (saved locally only):', err);
    }
  }

  async function markNotificationsRead(userId) {
    if (!enabled) return;
    try {
      const snap = await db.collection('notifications').where('userId', '==', userId).where('read', '==', false).get();
      if (snap.empty) return;
      const batch = db.batch();
      snap.forEach(doc => batch.update(doc.ref, { read: true }));
      await batch.commit();
    } catch (err) {
      console.error('[CloudSync] markNotificationsRead failed (saved locally only):', err);
    }
  }

  /* ── Live capture feed (admin "someone just took a photo" flash) ──
   * A tiny, ephemeral ping — not a full report — fired the instant a
   * citizen captures/uploads a photo via Quick Report, so the admin
   * dashboard can flash "new photo captured from this location" in real
   * time, independent of (and typically a beat faster than) the full
   * report write. Firestore's TTL isn't relied on here; documents are
   * cheap and small, and the admin listener only reacts to genuinely new
   * ones — old ones are harmless if they accumulate.
   */

  async function pushLiveCapture({ lat, lng, capturedAt }) {
    if (!enabled) return;
    try {
      await db.collection('live_captures').add({
        lat, lng, capturedAt: capturedAt || new Date().toISOString(), ts: Date.now()
      });
    } catch (err) {
      console.error('[CloudSync] pushLiveCapture failed:', err);
    }
  }

  /**
   * Subscribes to newly-added live-capture pings only (ignores whatever
   * already existed when the dashboard opened) and invokes onCapture for
   * each one with { lat, lng, capturedAt }.
   */
  function initLiveCaptureFeed(onCapture) {
    if (!enabled) return;
    const startedAt = Date.now();
    try {
      db.collection('live_captures')
        .orderBy('ts', 'desc')
        .limit(5)
        .onSnapshot(
          (snapshot) => {
            snapshot.docChanges().forEach((change) => {
              if (change.type !== 'added') return;
              const data = change.doc.data();
              // Skip historical pings from before this dashboard session started.
              if (typeof data.ts === 'number' && data.ts < startedAt - 5000) return;
              if (typeof onCapture === 'function') onCapture(data);
            });
          },
          (err) => console.error('[CloudSync] live capture feed error:', err)
        );
    } catch (err) {
      console.error('[CloudSync] initLiveCaptureFeed failed:', err);
    }
  }

  return {
    init, isEnabled, isConfigured, pushReport, updateReport, deleteReport,
    initNotifications, pushNotification, markNotificationsRead,
    pushLiveCapture, initLiveCaptureFeed
  };
})();
