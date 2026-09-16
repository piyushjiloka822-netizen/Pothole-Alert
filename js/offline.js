/**
 * Offline Support Module — Pothole Reporting Application
 * Queues reports when offline and auto-flushes on reconnection.
 */

const Offline = {
  _initialized: false,

  init(onFlush) {
    if (this._initialized) return;
    this._initialized = true;
    this._onFlush = onFlush;

    // Listen for reconnection
    window.addEventListener('online', () => {
      this._showBanner('online');
      setTimeout(() => this.flush(), 800);
    });

    window.addEventListener('offline', () => {
      this._showBanner('offline');
    });

    // Check immediately on load
    if (!navigator.onLine) {
      this._showBanner('offline');
    }

    // Try to flush any queued reports on load (if we're online)
    if (navigator.onLine) {
      const queue = Storage.getOfflineQueue();
      if (queue.length > 0) {
        setTimeout(() => this.flush(), 1500);
      }
    }
  },

  isOnline() {
    return navigator.onLine;
  },

  /**
   * Queue a report to be submitted when connectivity is restored.
   */
  queueReport(report) {
    Storage.addToOfflineQueue(report);
    this._updateBadge();
    this._showToast(`📶 No connection — report saved locally (${Storage.getOfflineQueue().length} queued)`, 'warning');
  },

  /**
   * Flush the offline queue — submit all queued reports.
   * In a real app this would call an API; here we commit to localStorage.
   */
  flush() {
    const queue = Storage.getOfflineQueue();
    if (queue.length === 0) return;

    queue.forEach(report => {
      // Mark as synced and save to main storage
      report.synced = true;
      Storage.saveReport(report);
    });

    Storage.clearOfflineQueue();
    this._updateBadge();

    const msg = `✅ ${queue.length} offline report${queue.length > 1 ? 's' : ''} synced successfully!`;
    this._showToast(msg, 'success');

    if (typeof this._onFlush === 'function') {
      this._onFlush(queue);
    }
  },

  getPendingCount() {
    return Storage.getOfflineQueue().length;
  },

  _showBanner(state) {
    let banner = document.getElementById('offline-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'offline-banner';
      document.body.appendChild(banner);
    }

    if (state === 'offline') {
      banner.className = 'offline-banner offline-banner--offline';
      banner.innerHTML = `
        <span class="offline-icon">📶</span>
        <span>You're offline — reports will be saved and synced when you reconnect.</span>
      `;
      banner.style.transform = 'translateY(0)';
    } else {
      banner.className = 'offline-banner offline-banner--online';
      banner.innerHTML = `
        <span class="offline-icon">✅</span>
        <span>Back online! Syncing queued reports…</span>
      `;
      banner.style.transform = 'translateY(0)';
      setTimeout(() => { banner.style.transform = 'translateY(-100%)'; }, 3000);
    }
  },

  _updateBadge() {
    const badge = document.getElementById('offline-badge');
    if (!badge) return;
    const count = this.getPendingCount();
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  },

  _showToast(message, type) {
    if (typeof Toast !== 'undefined') {
      Toast.show(message, type);
    }
  }
};
