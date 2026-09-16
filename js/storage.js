/**
 * Storage Module — Pothole Reporting Application
 * API-backed storage with localStorage as read-through cache.
 * All CRUD operations call the REST API, with localStorage as fallback.
 */

const API_BASE = window.location.origin + '/api';
const STORAGE_KEY = 'pothole_reports_v2';
const OFFLINE_QUEUE_KEY = 'pothole_offline_queue';
const USER_ID_KEY = 'pothole_user_id';
const NOTIF_KEY = 'pothole_notifications';

const Storage = {
  /* ─── User Identity ─────────────────────────────────────────── */
  getUserId() {
    let id = localStorage.getItem(USER_ID_KEY);
    if (!id) {
      id = 'user_' + Math.random().toString(36).slice(2, 10);
      localStorage.setItem(USER_ID_KEY, id);
    }
    return id;
  },

  /* ─── Report CRUD (API-backed) ───────────────────────────────── */

  // Cache for fast synchronous reads
  _cache: null,
  _cacheTime: 0,

  _updateCache(reports) {
    this._cache = reports;
    this._cacheTime = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(reports));
  },

  getAllReports() {
    // Return cache if fresh (< 2s old)
    if (this._cache && (Date.now() - this._cacheTime) < 2000) {
      return this._cache;
    }
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch { return []; }
  },

  async fetchAllReports(filters = {}) {
    try {
      const params = new URLSearchParams(filters).toString();
      const resp = await fetch(`${API_BASE}/reports${params ? '?' + params : ''}`);
      if (!resp.ok) throw new Error('API error');
      const reports = await resp.json();
      this._updateCache(reports);
      return reports;
    } catch (err) {
      console.warn('[Storage] API fetch failed, using local cache:', err);
      return this.getAllReports();
    }
  },

  getReport(id) {
    return this.getAllReports().find(r => r.id === id) || null;
  },

  async fetchReport(id) {
    try {
      const resp = await fetch(`${API_BASE}/reports/${id}`);
      if (!resp.ok) return null;
      return await resp.json();
    } catch { return this.getReport(id); }
  },

  async saveReport(report) {
    try {
      const resp = await fetch(`${API_BASE}/reports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report)
      });
      if (!resp.ok) throw new Error('API error');
      const saved = await resp.json();
      // Update local cache
      const reports = this.getAllReports();
      reports.unshift(saved);
      this._updateCache(reports);
      return saved;
    } catch (err) {
      console.warn('[Storage] API save failed, saving locally:', err);
      const reports = this.getAllReports();
      reports.unshift(report);
      this._updateCache(reports);
      return report;
    }
  },

  async updateReport(id, updates) {
    try {
      const resp = await fetch(`${API_BASE}/reports/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (!resp.ok) throw new Error('API error');
      const updated = await resp.json();
      // Update local cache
      const reports = this.getAllReports();
      const idx = reports.findIndex(r => r.id === id);
      if (idx !== -1) reports[idx] = updated;
      this._updateCache(reports);
      return updated;
    } catch (err) {
      console.warn('[Storage] API update failed, updating locally:', err);
      const reports = this.getAllReports();
      const idx = reports.findIndex(r => r.id === id);
      if (idx === -1) return null;
      reports[idx] = { ...reports[idx], ...updates, updatedAt: new Date().toISOString() };
      this._updateCache(reports);
      return reports[idx];
    }
  },

  deleteReport(id) {
    fetch(`${API_BASE}/reports/${id}`, { method: 'DELETE' }).catch(() => {});
    const reports = this.getAllReports().filter(r => r.id !== id);
    this._updateCache(reports);
  },

  async upvoteReport(id) {
    const userId = this.getUserId();
    try {
      const resp = await fetch(`${API_BASE}/reports/${id}/upvote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      if (!resp.ok) throw new Error('API error');
      const result = await resp.json();
      // Update local cache
      if (result.report) {
        const reports = this.getAllReports();
        const idx = reports.findIndex(r => r.id === id);
        if (idx !== -1) reports[idx] = result.report;
        this._updateCache(reports);
      }
      return result;
    } catch (err) {
      // Fallback to local
      const report = this.getReport(id);
      if (!report) return null;
      const voters = report.voters || [];
      if (voters.includes(userId)) return { report, alreadyVoted: true };
      report.upvotes = (report.upvotes || 0) + 1;
      report.voters = [...voters, userId];
      const reports = this.getAllReports();
      const idx = reports.findIndex(r => r.id === id);
      if (idx !== -1) reports[idx] = report;
      this._updateCache(reports);
      return { report, alreadyVoted: false };
    }
  },

  hasUserUpvoted(id) {
    const userId = this.getUserId();
    const report = this.getReport(id);
    return report ? (report.voters || []).includes(userId) : false;
  },

  /* ─── Stats (API-backed) ─────────────────────────────────────── */
  getStats() {
    const reports = this.getAllReports();
    return {
      total: reports.length,
      pending: reports.filter(r => r.status === 'pending').length,
      scheduled: reports.filter(r => r.status === 'scheduled').length,
      inProgress: reports.filter(r => r.status === 'in-progress').length,
      resolved: reports.filter(r => r.status === 'resolved').length,
    };
  },

  async fetchStats() {
    try {
      const resp = await fetch(`${API_BASE}/stats`);
      if (!resp.ok) throw new Error('API error');
      return await resp.json();
    } catch { return this.getStats(); }
  },

  getAnalytics() {
    const reports = this.getAllReports();
    const now = Date.now();
    const zoneCounts = {};
    reports.forEach(r => { const z = r.zone || 'Unknown'; zoneCounts[z] = (zoneCounts[z] || 0) + 1; });
    const severityCounts = { low: 0, medium: 0, high: 0, critical: 0 };
    reports.forEach(r => { if (severityCounts[r.severity] !== undefined) severityCounts[r.severity]++; });
    const monthlyCounts = {};
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now); d.setMonth(d.getMonth() - i);
      const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
      monthlyCounts[key] = 0;
    }
    reports.forEach(r => {
      const d = new Date(r.createdAt);
      const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
      if (monthlyCounts[key] !== undefined) monthlyCounts[key]++;
    });
    const resolved = reports.filter(r => r.status === 'resolved');
    let avgResolution = 0;
    if (resolved.length > 0) {
      const totalDays = resolved.reduce((sum, r) => {
        return sum + (new Date(r.updatedAt) - new Date(r.createdAt)) / 86400000;
      }, 0);
      avgResolution = Math.round(totalDays / resolved.length);
    }
    const roadTypeCounts = { highway: 0, 'city-road': 0, lane: 0, bridge: 0 };
    reports.forEach(r => { if (roadTypeCounts[r.roadType] !== undefined) roadTypeCounts[r.roadType]++; });
    return { zoneCounts, severityCounts, monthlyCounts, avgResolution, roadTypeCounts, totalResolved: resolved.length };
  },

  async fetchAnalytics() {
    try {
      const resp = await fetch(`${API_BASE}/analytics`);
      if (!resp.ok) throw new Error('API error');
      return await resp.json();
    } catch { return this.getAnalytics(); }
  },

  /* ─── Offline Queue ──────────────────────────────────────────── */
  getOfflineQueue() {
    try { return JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY)) || []; }
    catch { return []; }
  },
  addToOfflineQueue(report) {
    const queue = this.getOfflineQueue();
    queue.push(report);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  },
  clearOfflineQueue() { localStorage.removeItem(OFFLINE_QUEUE_KEY); },

  /* ─── Notifications (API-backed) ─────────────────────────────── */
  getNotifications(userId) {
    try {
      const all = JSON.parse(localStorage.getItem(NOTIF_KEY)) || {};
      return all[userId] || [];
    } catch { return []; }
  },

  async fetchNotifications(userId) {
    try {
      const resp = await fetch(`${API_BASE}/notifications/${userId}`);
      if (!resp.ok) throw new Error('API error');
      const data = await resp.json();
      // Update local cache
      try {
        const all = JSON.parse(localStorage.getItem(NOTIF_KEY)) || {};
        all[userId] = data.notifications;
        localStorage.setItem(NOTIF_KEY, JSON.stringify(all));
      } catch {}
      return data;
    } catch {
      return { notifications: this.getNotifications(userId), unread: 0 };
    }
  },

  addNotification(userId, message, type = 'info') {
    try {
      const all = JSON.parse(localStorage.getItem(NOTIF_KEY)) || {};
      if (!all[userId]) all[userId] = [];
      const notif = { id: Date.now(), message, type, read: false, createdAt: new Date().toISOString() };
      all[userId].unshift(notif);
      all[userId] = all[userId].slice(0, 20);
      localStorage.setItem(NOTIF_KEY, JSON.stringify(all));
    } catch {}
  },

  markNotificationsRead(userId) {
    fetch(`${API_BASE}/notifications/${userId}/read`, { method: 'PUT' }).catch(() => {});
    try {
      const all = JSON.parse(localStorage.getItem(NOTIF_KEY)) || {};
      if (all[userId]) all[userId].forEach(n => n.read = true);
      localStorage.setItem(NOTIF_KEY, JSON.stringify(all));
    } catch {}
  },

  getUnreadCount(userId) {
    return this.getNotifications(userId).filter(n => !n.read).length;
  },

  /* ─── Auth ───────────────────────────────────────────────────── */
  async verifyAdmin(password) {
    return await Security.verifyAdminPassword(password);
  },

  /* ─── Ticket ID Generator (now server-side, but keep for compat) ── */
  generateTicketId() {
    const existing = this.getAllReports().map(r => r.id);
    let id;
    do {
      id = 'POT-' + String(Math.floor(1000 + Math.random() * 9000));
    } while (existing.includes(id));
    return id;
  },

  /* ─── Clear old demo data ─────────────────────────────────────── */
  clearDemoData() {
    // No longer needed with backend DB, but keep for backward compat
  }
};
