/**
 * Escalation Module — Pothole Reporting Application
 * Automatically flags reports that are >30 days old and still unresolved.
 */

const Escalation = {
  THRESHOLD_DAYS: 30,

  /**
   * Check if a report should be escalated.
   */
  shouldEscalate(report) {
    if (report.status === 'resolved') return false;
    const ageMs = Date.now() - new Date(report.createdAt).getTime();
    const ageDays = ageMs / 86400000;
    return ageDays >= this.THRESHOLD_DAYS;
  },

  /**
   * Get age of report in days.
   */
  getAgeDays(report) {
    return Math.floor((Date.now() - new Date(report.createdAt).getTime()) / 86400000);
  },

  /**
   * Run escalation check on all reports in storage.
   * Marks qualifying reports and optionally notifies reporters.
   */
  runCheck() {
    const reports = Storage.getAllReports();
    let escalatedCount = 0;
    let newlyEscalated = [];

    reports.forEach(report => {
      if (this.shouldEscalate(report) && !report.escalated) {
        Storage.updateReport(report.id, { escalated: true });
        newlyEscalated.push(report);
        escalatedCount++;

        // Notify the reporter
        Storage.addNotification(
          report.reporterId,
          `⚠️ Your report ${report.id} has been pending for over 30 days and escalated to senior admin.`,
          'warning'
        );
      }
    });

    return { escalatedCount, newlyEscalated };
  },

  /**
   * Get all currently escalated reports.
   */
  getEscalated() {
    return Storage.getAllReports().filter(r => r.escalated && r.status !== 'resolved');
  },

  /**
   * Format the escalation badge for UI display.
   */
  formatBadge(report) {
    const days = this.getAgeDays(report);
    return {
      show: report.escalated && report.status !== 'resolved',
      label: `⚠️ Escalated`,
      tooltip: `${days} days old — escalated to senior admin`,
      days
    };
  },

  /**
   * Get a human-readable age string.
   */
  formatAge(report) {
    const days = this.getAgeDays(report);
    if (days === 0) return 'Today';
    if (days === 1) return '1 day ago';
    if (days < 30) return `${days} days ago`;
    const months = Math.floor(days / 30);
    return months === 1 ? '1 month ago' : `${months} months ago`;
  }
};
