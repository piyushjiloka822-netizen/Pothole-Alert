/**
 * Error Tracker Module — Pothole Reporting Application
 * Catches and logs all JavaScript errors, promise rejections,
 * and application-level issues for debugging and admin review.
 */

const ErrorTracker = {
  MAX_STORED_ERRORS: 50,
  STORAGE_KEY: 'pothole_errors',
  AUDIT_KEY: 'pothole_audit_log',
  MAX_AUDIT_ENTRIES: 200,

  /* ═══════════════════════════════════════════════════════════════
     1. Global Error Catching
     ═══════════════════════════════════════════════════════════════ */

  init() {
    // Catch uncaught errors
    window.onerror = (message, source, lineno, colno, error) => {
      this.logError({
        type: 'uncaught_error',
        severity: 'error',
        message: String(message),
        source: source || 'unknown',
        line: lineno,
        column: colno,
        stack: error?.stack || null,
      });
    };

    // Catch unhandled promise rejections
    window.addEventListener('unhandledrejection', (event) => {
      this.logError({
        type: 'unhandled_promise',
        severity: 'error',
        message: event.reason?.message || String(event.reason),
        stack: event.reason?.stack || null,
      });
    });

    // Catch resource load failures (images, scripts, etc.)
    window.addEventListener('error', (event) => {
      if (event.target && event.target !== window) {
        this.logError({
          type: 'resource_error',
          severity: 'warning',
          message: `Failed to load: ${event.target.src || event.target.href || 'unknown resource'}`,
          element: event.target.tagName,
        });
      }
    }, true); // capture phase to catch resource errors

    console.log('[ErrorTracker] Initialized — global error handlers active');
  },

  /* ═══════════════════════════════════════════════════════════════
     2. Error Logging
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Log an error to localStorage.
   * @param {Object} errorInfo - Error details
   */
  logError(errorInfo) {
    const entry = {
      id: 'err_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
      online: navigator.onLine,
      ...errorInfo,
    };

    try {
      const errors = this.getErrors();
      errors.unshift(entry);
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(errors.slice(0, this.MAX_STORED_ERRORS)));
    } catch (e) {
      // localStorage might be full — silently fail
      console.warn('[ErrorTracker] Could not persist error:', e);
    }

    // Also log to console for dev visibility
    console.error(`[ErrorTracker] [${entry.type}] ${entry.message}`);
  },

  /**
   * Log a specific application operation error (non-fatal).
   */
  logOperationError(operation, message, details = {}) {
    this.logError({
      type: 'operation_error',
      severity: 'warning',
      operation,
      message,
      ...details,
    });
  },

  /**
   * Log a GPS error.
   */
  logGPSError(code, message) {
    this.logError({
      type: 'gps_error',
      severity: 'warning',
      message: `GPS Error (${code}): ${message}`,
      gpsErrorCode: code,
    });
  },

  /**
   * Log a storage error (localStorage issues).
   */
  logStorageError(operation, message) {
    this.logError({
      type: 'storage_error',
      severity: 'error',
      message: `Storage ${operation}: ${message}`,
    });
  },

  /**
   * Log a photo upload/processing error.
   */
  logPhotoError(message, details = {}) {
    this.logError({
      type: 'photo_error',
      severity: 'warning',
      message,
      ...details,
    });
  },

  /* ═══════════════════════════════════════════════════════════════
     3. Error Retrieval
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Get all stored errors.
   */
  getErrors() {
    try {
      return JSON.parse(localStorage.getItem(this.STORAGE_KEY)) || [];
    } catch {
      return [];
    }
  },

  /**
   * Get error count.
   */
  getErrorCount() {
    return this.getErrors().length;
  },

  /**
   * Get errors filtered by type.
   */
  getErrorsByType(type) {
    return this.getErrors().filter(e => e.type === type);
  },

  /**
   * Get errors from the last N hours.
   */
  getRecentErrors(hours = 24) {
    const cutoff = Date.now() - (hours * 3600000);
    return this.getErrors().filter(e => new Date(e.timestamp).getTime() > cutoff);
  },

  /**
   * Clear all stored errors.
   */
  clearErrors() {
    localStorage.removeItem(this.STORAGE_KEY);
  },

  /**
   * Export errors as JSON string (for download).
   */
  exportErrors() {
    return JSON.stringify(this.getErrors(), null, 2);
  },

  /* ═══════════════════════════════════════════════════════════════
     4. Audit Trail (Admin Actions)
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Log an admin action for the audit trail.
   * @param {string} action - e.g., 'status_change', 'crew_assign', 'resolve', 'delete'
   * @param {string} reportId - Ticket ID affected
   * @param {Object} details - Additional context
   */
  logAudit(action, reportId, details = {}) {
    const entry = {
      id: 'aud_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      timestamp: new Date().toISOString(),
      action,
      reportId,
      ...details,
    };

    try {
      const log = this.getAuditLog();
      log.unshift(entry);
      localStorage.setItem(this.AUDIT_KEY, JSON.stringify(log.slice(0, this.MAX_AUDIT_ENTRIES)));
    } catch {}
  },

  /**
   * Get audit trail entries.
   */
  getAuditLog() {
    try {
      return JSON.parse(localStorage.getItem(this.AUDIT_KEY)) || [];
    } catch {
      return [];
    }
  },

  /**
   * Get audit entries for a specific report.
   */
  getAuditForReport(reportId) {
    return this.getAuditLog().filter(e => e.reportId === reportId);
  },

  /**
   * Clear audit log.
   */
  clearAuditLog() {
    localStorage.removeItem(this.AUDIT_KEY);
  },

  /**
   * Export audit log as JSON.
   */
  exportAuditLog() {
    return JSON.stringify(this.getAuditLog(), null, 2);
  },

  /* ═══════════════════════════════════════════════════════════════
     5. Performance Monitoring
     ═══════════════════════════════════════════════════════════════ */

  _perfMarks: {},

  /**
   * Start timing an operation.
   */
  perfStart(label) {
    this._perfMarks[label] = performance.now();
  },

  /**
   * End timing and return duration in ms.
   */
  perfEnd(label) {
    if (!this._perfMarks[label]) return null;
    const duration = Math.round(performance.now() - this._perfMarks[label]);
    delete this._perfMarks[label];
    return duration;
  },

  /* ═══════════════════════════════════════════════════════════════
     6. SLA (Service Level Agreement) Tracking
     ═══════════════════════════════════════════════════════════════ */

  SLA_TARGETS_DAYS: {
    critical: 3,
    high: 7,
    medium: 14,
    low: 30,
  },

  /**
   * Get SLA info for a report.
   * Returns { targetDays, elapsedDays, remainingDays, breached, percentage, status }
   */
  getSLAInfo(report) {
    if (report.status === 'resolved') {
      const resolvedDays = Math.floor(
        (new Date(report.updatedAt) - new Date(report.createdAt)) / 86400000
      );
      const target = this.SLA_TARGETS_DAYS[report.severity] || 14;
      return {
        targetDays: target,
        elapsedDays: resolvedDays,
        remainingDays: 0,
        breached: resolvedDays > target,
        percentage: 100,
        status: resolvedDays <= target ? 'met' : 'breached',
        label: resolvedDays <= target ? `✅ Resolved in ${resolvedDays}d (SLA: ${target}d)` : `⚠️ Resolved in ${resolvedDays}d (SLA breached: ${target}d)`,
      };
    }

    const target = this.SLA_TARGETS_DAYS[report.severity] || 14;
    const elapsed = Math.floor((Date.now() - new Date(report.createdAt).getTime()) / 86400000);
    const remaining = target - elapsed;
    const percentage = Math.min(100, Math.round((elapsed / target) * 100));

    let status = 'on-track';
    if (remaining <= 0) status = 'breached';
    else if (remaining <= Math.ceil(target * 0.25)) status = 'at-risk';

    const statusLabels = {
      'on-track': `🟢 ${remaining}d remaining (SLA: ${target}d)`,
      'at-risk': `🟡 ${remaining}d remaining — at risk! (SLA: ${target}d)`,
      'breached': `🔴 SLA breached by ${Math.abs(remaining)}d (target: ${target}d)`,
    };

    return {
      targetDays: target,
      elapsedDays: elapsed,
      remainingDays: Math.max(0, remaining),
      breached: remaining <= 0,
      percentage,
      status,
      label: statusLabels[status],
    };
  },

  /**
   * Get overall SLA compliance stats.
   */
  getSLAStats(reports) {
    const resolved = reports.filter(r => r.status === 'resolved');
    if (resolved.length === 0) return { compliance: 0, met: 0, breached: 0, total: 0 };

    let met = 0, breached = 0;
    resolved.forEach(r => {
      const info = this.getSLAInfo(r);
      if (info.status === 'met') met++;
      else breached++;
    });

    return {
      compliance: Math.round((met / resolved.length) * 100),
      met,
      breached,
      total: resolved.length,
    };
  },

  /**
   * Get active SLA breaches (unresolved reports past SLA).
   */
  getActiveBreaches(reports) {
    return reports
      .filter(r => r.status !== 'resolved')
      .map(r => ({ report: r, sla: this.getSLAInfo(r) }))
      .filter(item => item.sla.breached)
      .sort((a, b) => b.sla.elapsedDays - a.sla.elapsedDays);
  },
};
