/**
 * Admin Dashboard Logic — Pothole Management System
 * Kanban board, worker management, photo verification, analytics,
 * SSE real-time updates, and status management.
 */

const ADMIN_API_BASE = window.location.origin + '/api';

/* ── Toast ────────────────────────────────────────────────────── */
const AdminToast = {
  show(message, type = 'info', duration = 3500) {
    const container = document.getElementById('admin-toast-container');
    if (!container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 350);
    }, duration);
  }
};

/* ── Admin App ────────────────────────────────────────────────── */
const AdminApp = {
  currentView: 'kanban',
  sortBy: 'upvotes',
  charts: {},
  workers: [],
  sseSource: null,

  /* ── Init ─────────────────────────────────────────────────── */
  init() {
    Storage.clearDemoData();
    Escalation.runCheck();
    ErrorTracker.init();
    // Only run standalone login if we're on admin.html (not unified dashboard)
    if (document.getElementById('login-screen')) {
      this.initLogin();
    }
  },

  /* ── Unified Dashboard Init (called by Dashboard.js) ─────── */
  async initDashboardUnified() {
    await Storage.fetchAllReports();
    await this.fetchWorkers();

    this.updateStatCards();
    this.renderKanban();
    this.initTopbarActionsUnified();
    this.renderAnalytics();
    this.updateNavBadges();
    this.initSSE();
    this.initWorkerPanel();
    this.initPhotoVerification();

    // Sort change
    document.getElementById('sort-select')?.addEventListener('change', (e) => {
      this.sortBy = e.target.value;
      this.renderKanban();
    });

    // Resolve modal
    document.getElementById('resolve-modal-cancel')?.addEventListener('click', () => {
      document.getElementById('resolve-modal').classList.remove('open');
    });

    document.getElementById('after-photo-area')?.addEventListener('click', () => {
      document.getElementById('after-photo-input').click();
    });

    document.getElementById('after-photo-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingAfterPhoto = ev.target.result;
        document.getElementById('after-photo-area').innerHTML = `
          <div class="modal-upload-icon">✅</div>
          <div class="modal-upload-text">Photo selected — ready to resolve!</div>`;
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('resolve-confirm-btn')?.addEventListener('click', async () => {
      const id = this._pendingResolveId;
      if (!id) return;
      try {
        await fetch(`${ADMIN_API_BASE}/reports/${id}/resolve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ afterPhoto: this._pendingAfterPhoto || null })
        });
      } catch (err) {
        Storage.updateReport(id, { status: 'resolved', afterPhoto: this._pendingAfterPhoto || null });
      }
      ErrorTracker.logAudit('report_resolved', id, { hadAfterPhoto: !!this._pendingAfterPhoto });
      document.getElementById('resolve-modal').classList.remove('open');
      this._pendingAfterPhoto = null;
      AdminToast.show(`✅ Report ${id} marked as resolved!`, 'success');
      this.refreshDashboard();
    });
  },

  initTopbarActionsUnified() {
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
      Escalation.runCheck();
      this.refreshDashboard();
      AdminToast.show('🔄 Dashboard refreshed', 'info', 2000);
    });
    document.getElementById('btn-print')?.addEventListener('click', () => window.print());
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportCSV());
  },

  /* ── SSE — Real-time Connection ───────────────────────────── */
  initSSE() {
    try {
      this.sseSource = new EventSource(`${ADMIN_API_BASE}/events`);
      const statusEl = document.getElementById('sse-status');

      this.sseSource.addEventListener('connected', () => {
        if (statusEl) { statusEl.textContent = '● Live'; statusEl.style.color = '#10B981'; }
      });

      this.sseSource.addEventListener('new_report', (e) => {
        const data = JSON.parse(e.data);
        AdminToast.show(`📋 New complaint: ${data.id} — ${data.address}`, 'info', 4000);
        this.refreshDashboard();
      });

      this.sseSource.addEventListener('report_updated', (e) => {
        const data = JSON.parse(e.data);
        AdminToast.show(`🔄 Report ${data.id} updated — Status: ${data.status}`, 'info', 3000);
        this.refreshDashboard();
      });

      this.sseSource.addEventListener('worker_photo_uploaded', (e) => {
        const data = JSON.parse(e.data);
        AdminToast.show(`📸 Worker uploaded repair photo for ${data.id} — Review needed!`, 'warning', 5000);
        this.refreshDashboard();
      });

      this.sseSource.addEventListener('report_resolved', (e) => {
        const data = JSON.parse(e.data);
        AdminToast.show(`✅ Report ${data.id} resolved!`, 'success', 3000);
        this.refreshDashboard();
      });

      this.sseSource.onerror = () => {
        if (statusEl) { statusEl.textContent = '○ Reconnecting…'; statusEl.style.color = '#F59E0B'; }
      };
    } catch (err) {
      console.warn('[SSE] Failed to connect:', err);
    }
  },

  refreshDashboard() {
    Storage.fetchAllReports().then(() => {
      this.updateStatCards();
      this.renderKanban();
      this.updateNavBadges();
      if (this.currentView === 'analytics') this.renderAnalytics();
      if (this.currentView === 'workers') this.renderWorkers();
      if (this.currentView === 'verification') this.renderVerification();
    });
  },

  /* ── Login ──────────────────────────────────────────────── */
  initLogin() {
    if (Security.isAdminSessionValid()) {
      document.getElementById('login-screen').style.display = 'none';
      document.getElementById('admin-layout').classList.add('active');
      this.initDashboard();
      return;
    }

    const loginForm = document.getElementById('login-form');
    loginForm?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const loginCheck = Security.checkLoginAllowed();
      if (!loginCheck.allowed) {
        const errEl = document.getElementById('login-error');
        errEl.textContent = loginCheck.message;
        errEl.classList.add('visible');
        return;
      }

      const pw = document.getElementById('login-password').value;
      const isValid = await Storage.verifyAdmin(pw);

      if (isValid) {
        Security.clearLoginAttempts();
        Security.createAdminSession();
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('admin-layout').classList.add('active');
        ErrorTracker.logAudit('admin_login', 'N/A', { action: 'login_success' });
        this.initDashboard();
      } else {
        const result = Security.recordFailedLogin();
        const errEl = document.getElementById('login-error');
        if (result.locked) {
          errEl.textContent = 'Account locked for 15 minutes due to too many failed attempts.';
        } else {
          errEl.textContent = `Invalid password. ${result.attemptsLeft} attempt(s) remaining.`;
        }
        errEl.classList.add('visible');
        document.getElementById('login-password').value = '';
        setTimeout(() => errEl.classList.remove('visible'), 5000);
      }
    });

    document.getElementById('login-password')?.addEventListener('keydown', () => {
      document.getElementById('login-error').classList.remove('visible');
    });
  },

  /* ── Dashboard Init ────────────────────────────────────────── */
  async initDashboard() {
    // Fetch data from API
    await Storage.fetchAllReports();
    await this.fetchWorkers();

    this.updateStatCards();
    this.renderKanban();
    this.initNav();
    this.initTopbarActions();
    this.renderAnalytics();
    this.updateNavBadges();
    this.initSSE();
    this.initWorkerPanel();
    this.initPhotoVerification();

    // Sort change
    document.getElementById('sort-select')?.addEventListener('change', (e) => {
      this.sortBy = e.target.value;
      this.renderKanban();
    });

    // Resolve modal
    document.getElementById('resolve-modal-cancel')?.addEventListener('click', () => {
      document.getElementById('resolve-modal').classList.remove('open');
    });

    document.getElementById('after-photo-area')?.addEventListener('click', () => {
      document.getElementById('after-photo-input').click();
    });

    document.getElementById('after-photo-input')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        this._pendingAfterPhoto = ev.target.result;
        document.getElementById('after-photo-area').innerHTML = `
          <div class="modal-upload-icon">✅</div>
          <div class="modal-upload-text">Photo selected — ready to resolve!</div>`;
      };
      reader.readAsDataURL(file);
    });

    document.getElementById('resolve-confirm-btn')?.addEventListener('click', async () => {
      const id = this._pendingResolveId;
      if (!id) return;

      try {
        await fetch(`${ADMIN_API_BASE}/reports/${id}/resolve`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ afterPhoto: this._pendingAfterPhoto || null })
        });
      } catch (err) {
        Storage.updateReport(id, { status: 'resolved', afterPhoto: this._pendingAfterPhoto || null });
      }

      ErrorTracker.logAudit('report_resolved', id, { hadAfterPhoto: !!this._pendingAfterPhoto });

      document.getElementById('resolve-modal').classList.remove('open');
      this._pendingAfterPhoto = null;
      AdminToast.show(`✅ Report ${id} marked as resolved!`, 'success');
      this.refreshDashboard();
    });

    // Session auto-logout check
    this._sessionInterval = setInterval(() => {
      if (!Security.isAdminSessionValid()) {
        clearInterval(this._sessionInterval);
        AdminToast.show('⏱️ Session expired — please log in again.', 'warning');
        setTimeout(() => {
          document.getElementById('login-screen').style.display = 'flex';
          document.getElementById('admin-layout').classList.remove('active');
          document.getElementById('login-password').value = '';
        }, 1500);
      }
      const remaining = Security.getSessionTimeRemaining();
      const timerEl = document.getElementById('session-timer');
      if (timerEl) timerEl.textContent = `Session: ${remaining}m`;
    }, 30000);

    const timerEl = document.getElementById('session-timer');
    if (timerEl) timerEl.textContent = `Session: ${Security.getSessionTimeRemaining()}m`;
  },

  /* ── Workers Fetch ────────────────────────────────────────── */
  async fetchWorkers() {
    try {
      const resp = await fetch(`${ADMIN_API_BASE}/workers`);
      if (resp.ok) this.workers = await resp.json();
    } catch { this.workers = []; }
  },

  /* ── Nav ──────────────────────────────────────────────────── */
  initNav() {
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        this.currentView = item.dataset.view;
        document.querySelectorAll('.admin-content').forEach(c => c.classList.add('hidden'));
        document.getElementById(`view-${this.currentView}`)?.classList.remove('hidden');
        document.getElementById('topbar-title').textContent = item.querySelector('span:nth-child(2)')?.textContent || 'Dashboard';
        if (this.currentView === 'analytics') this.renderAnalytics();
        if (this.currentView === 'errors') this.renderErrorLog();
        if (this.currentView === 'audit') this.renderAuditLog();
        if (this.currentView === 'workers') this.renderWorkers();
        if (this.currentView === 'verification') this.renderVerification();
      });
    });

    document.getElementById('btn-logout')?.addEventListener('click', () => {
      Security.destroyAdminSession();
      ErrorTracker.logAudit('admin_logout', 'N/A', { action: 'logout' });
      if (this._sessionInterval) clearInterval(this._sessionInterval);
      if (this.sseSource) this.sseSource.close();
      document.getElementById('login-screen').style.display = 'flex';
      document.getElementById('admin-layout').classList.remove('active');
      document.getElementById('login-password').value = '';
    });
  },

  initTopbarActions() {
    document.getElementById('btn-refresh')?.addEventListener('click', () => {
      Escalation.runCheck();
      this.refreshDashboard();
      AdminToast.show('🔄 Dashboard refreshed', 'info', 2000);
    });
    document.getElementById('btn-print')?.addEventListener('click', () => window.print());
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportCSV());
  },

  /* ── Stat Cards ───────────────────────────────────────────── */
  updateStatCards() {
    const stats = Storage.getStats();
    const escalated = Escalation.getEscalated().length;
    const el = id => document.getElementById(id);
    if (el('sc-total'))     el('sc-total').textContent     = stats.total;
    if (el('sc-pending'))   el('sc-pending').textContent   = stats.pending;
    if (el('sc-progress'))  el('sc-progress').textContent  = stats.inProgress;
    if (el('sc-resolved'))  el('sc-resolved').textContent  = stats.resolved;
    if (el('sc-escalated')) el('sc-escalated').textContent = escalated;
    if (el('sc-scheduled')) el('sc-scheduled').textContent = stats.scheduled;
  },

  /* ── Nav Badges ───────────────────────────────────────────── */
  updateNavBadges() {
    const stats = Storage.getStats();
    const escalated = Escalation.getEscalated().length;
    const el = id => document.getElementById(id);
    if (el('badge-pending'))   { el('badge-pending').textContent = stats.pending; el('badge-pending').style.display = stats.pending > 0 ? 'flex' : 'none'; }
    if (el('badge-escalated')) { el('badge-escalated').textContent = escalated; el('badge-escalated').style.display = escalated > 0 ? 'flex' : 'none'; }
    if (el('badge-workers'))   el('badge-workers').textContent = this.workers.length;

    // Count reports with worker photos waiting for verification
    const awaitingVerification = Storage.getAllReports().filter(r => r.workerPhoto && r.status !== 'resolved').length;
    if (el('badge-verification')) {
      el('badge-verification').textContent = awaitingVerification;
      el('badge-verification').style.display = awaitingVerification > 0 ? 'flex' : 'none';
    }
  },

  /* ── Kanban ───────────────────────────────────────────────── */
  renderKanban() {
    let reports = Storage.getAllReports();

    if (this.sortBy === 'upvotes') reports.sort((a, b) => (b.upvotes || 0) - (a.upvotes || 0));
    else if (this.sortBy === 'severity') {
      const order = { critical: 4, high: 3, medium: 2, low: 1 };
      reports.sort((a, b) => (order[b.severity] || 0) - (order[a.severity] || 0));
    } else if (this.sortBy === 'date') reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    else if (this.sortBy === 'escalated') reports.sort((a, b) => (b.escalated ? 1 : 0) - (a.escalated ? 1 : 0));

    const columns = { pending: [], scheduled: [], 'in-progress': [], resolved: [] };
    reports.forEach(r => { if (columns[r.status] !== undefined) columns[r.status].push(r); });

    const renderCol = (status, reports) => {
      const colBody = document.getElementById(`col-${status}`);
      const colCount = document.getElementById(`count-${status}`);
      if (!colBody) return;
      if (colCount) colCount.textContent = reports.length;
      colBody.innerHTML = reports.length === 0
        ? `<div style="text-align:center;padding:20px;font-size:11px;color:var(--text-muted)">No reports</div>`
        : reports.map(r => this.buildKanbanCard(r)).join('');

      colBody.querySelectorAll('.kanban-save-btn').forEach(btn => {
        btn.addEventListener('click', () => this.saveCardChanges(btn.dataset.id));
      });
      colBody.querySelectorAll('.kanban-resolve-btn').forEach(btn => {
        btn.addEventListener('click', () => this.openResolveModal(btn.dataset.id));
      });
    };

    renderCol('pending', columns['pending']);
    renderCol('scheduled', columns['scheduled']);
    renderCol('in-progress', columns['in-progress']);
    renderCol('resolved', columns['resolved']);
  },

  buildKanbanCard(report) {
    const escInfo = Escalation.formatBadge(report);
    const age = Escalation.formatAge(report);
    const slaInfo = ErrorTracker.getSLAInfo(report);
    const roadLabels = { highway: 'Highway', 'city-road': 'City Road', lane: 'Lane', bridge: 'Bridge' };
    const isResolved = report.status === 'resolved';

    const slaColors = { 'on-track': 'rgba(16,185,129,0.15)', 'at-risk': 'rgba(245,158,11,0.15)', 'breached': 'rgba(239,68,68,0.15)', 'met': 'rgba(16,185,129,0.15)' };
    const slaBorderColors = { 'on-track': 'rgba(16,185,129,0.3)', 'at-risk': 'rgba(245,158,11,0.3)', 'breached': 'rgba(239,68,68,0.3)', 'met': 'rgba(16,185,129,0.3)' };

    // Worker dropdown options
    const workerOptions = this.workers
      .filter(w => w.status === 'available' || w.id === report.assignedWorkerId)
      .map(w => `<option value="${w.id}" ${w.id === report.assignedWorkerId ? 'selected' : ''}>${w.name} (${w.specialization})</option>`)
      .join('');

    return `
      <div class="kanban-card" id="kcard-${report.id}">
        <div class="kanban-card-top">
          <span class="kanban-ticket">${Security.sanitizeHTML(report.id)}</span>
          <span class="kanban-sev ${report.severity}">${Security.sanitizeHTML(report.severity.toUpperCase())}</span>
        </div>
        <div class="kanban-desc">${Security.sanitizeHTML(report.description)}</div>
        <div class="kanban-addr">📍 ${Security.sanitizeHTML(report.address)}</div>
        <div class="kanban-meta">
          <span class="kanban-tag">🛣️ ${roadLabels[report.roadType] || Security.sanitizeHTML(report.roadType)}</span>
          <span class="kanban-tag">📅 ${Security.sanitizeHTML(age)}</span>
          <span class="kanban-tag">👍 ${report.upvotes || 0}</span>
          ${report.assignedWorkerName ? `<span class="kanban-tag" style="color:#3B82F6">👷 ${Security.sanitizeHTML(report.assignedWorkerName)}</span>` : ''}
          ${report.depthEstimate ? `<span class="kanban-tag" style="color:#7C3AED">📏 ${Security.sanitizeHTML(report.depthEstimate)} depth</span>` : ''}
        </div>
        ${report.workerPhoto ? `<div style="padding:4px 8px;margin-top:4px;border-radius:4px;font-size:10px;background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.3);color:#F59E0B">📸 Worker photo uploaded — awaiting verification</div>` : ''}
        <div style="padding:4px 8px;margin-top:4px;border-radius:4px;font-size:10px;background:${slaColors[slaInfo.status] || 'transparent'};border:1px solid ${slaBorderColors[slaInfo.status] || 'transparent'};color:var(--text-secondary)">
          ${Security.sanitizeHTML(slaInfo.label)}
        </div>
        ${escInfo.show ? `<div class="kanban-escalated">⚠️ ${Security.sanitizeHTML(escInfo.tooltip)}</div>` : ''}
        ${!isResolved ? `
        <div class="kanban-actions">
          <select class="kanban-status-select" id="worker-${report.id}" title="Assign worker">
            <option value="">👷 Assign Worker…</option>
            ${workerOptions}
          </select>
          <input class="kanban-crew-input" id="resources-${report.id}" placeholder="Resources (asphalt, JCB…)" value="${Security.sanitizeHTML(report.resources || '')}" />
          <select class="kanban-status-select" id="status-${report.id}">
            <option value="pending" ${report.status === 'pending' ? 'selected' : ''}>🔴 Pending</option>
            <option value="scheduled" ${report.status === 'scheduled' ? 'selected' : ''}>🟡 Scheduled</option>
            <option value="in-progress" ${report.status === 'in-progress' ? 'selected' : ''}>🟠 In Progress</option>
          </select>
          <div class="kanban-card-btns">
            <button class="kanban-btn save kanban-save-btn" data-id="${report.id}">💾 Save</button>
            <button class="kanban-btn resolve kanban-resolve-btn" data-id="${report.id}">✅ Resolve</button>
          </div>
        </div>` : `
        <div style="padding:8px;text-align:center;font-size:11px;color:var(--resolved);background:rgba(16,185,129,0.1);border-radius:6px;border:1px solid rgba(16,185,129,0.2);margin-top:8px;">
          ✅ Repaired by ${Security.sanitizeHTML(report.assignedWorkerName || report.crew || 'Municipal Crew')}
        </div>`}
      </div>`;
  },

  async saveCardChanges(id) {
    const workerSelect = document.getElementById(`worker-${id}`);
    const statusSelect = document.getElementById(`status-${id}`);
    const resourcesInput = document.getElementById(`resources-${id}`);
    if (!statusSelect) return;

    const workerId = workerSelect?.value || '';
    const status = statusSelect.value;
    const resources = resourcesInput?.value?.trim() || '';

    const worker = workerId ? this.workers.find(w => w.id === workerId) : null;

    const updates = {
      status,
      resources,
      assignedWorkerId: workerId || undefined,
      assignedWorkerName: worker ? worker.name : undefined,
      crew: worker ? worker.name : undefined
    };

    await Storage.updateReport(id, updates);

    ErrorTracker.logAudit('status_change', id, {
      newStatus: status,
      assignedWorker: worker?.name || null,
      resources: resources || null,
    });

    AdminToast.show(`✅ ${id} updated — Status: ${status}${worker ? ', Worker: ' + worker.name : ''}`, 'success');
    this.refreshDashboard();
  },

  openResolveModal(id) {
    this._pendingResolveId = id;
    this._pendingAfterPhoto = null;
    const report = Storage.getReport(id);
    document.getElementById('resolve-modal-ticket').textContent = id;
    document.getElementById('resolve-modal-addr').textContent = report?.address || '';
    document.getElementById('after-photo-area').innerHTML = `
      <div class="modal-upload-icon">📷</div>
      <div class="modal-upload-text">Click to upload after-repair photo (optional)</div>`;
    document.getElementById('resolve-modal').classList.add('open');
  },

  /* ══════════════════════════════════════════════════════════════
     WORKER MANAGEMENT PANEL
  ══════════════════════════════════════════════════════════════ */
  initWorkerPanel() {
    // Add Worker Modal
    document.getElementById('btn-add-worker')?.addEventListener('click', () => {
      document.getElementById('add-worker-modal').classList.add('open');
    });
    document.getElementById('add-worker-cancel')?.addEventListener('click', () => {
      document.getElementById('add-worker-modal').classList.remove('open');
    });
    document.getElementById('add-worker-confirm')?.addEventListener('click', async () => {
      const name = document.getElementById('new-worker-name').value.trim();
      const phone = document.getElementById('new-worker-phone').value.trim();
      const specialization = document.getElementById('new-worker-spec').value;
      if (!name) { AdminToast.show('Worker name is required', 'error'); return; }

      try {
        await fetch(`${ADMIN_API_BASE}/workers`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, phone, specialization })
        });
        await this.fetchWorkers();
        this.renderWorkers();
        this.updateNavBadges();
        document.getElementById('add-worker-modal').classList.remove('open');
        document.getElementById('new-worker-name').value = '';
        document.getElementById('new-worker-phone').value = '';
        AdminToast.show(`👷 Worker "${name}" added!`, 'success');
      } catch (err) {
        AdminToast.show('Failed to add worker', 'error');
      }
    });

    // Quick Assign
    document.getElementById('btn-quick-assign')?.addEventListener('click', async () => {
      const reportId = document.getElementById('qa-report-select').value;
      const workerId = document.getElementById('qa-worker-select').value;
      const resources = document.getElementById('qa-resources').value.trim();
      if (!reportId || !workerId) { AdminToast.show('Select both complaint and worker', 'error'); return; }

      const worker = this.workers.find(w => w.id === workerId);
      await Storage.updateReport(reportId, {
        status: 'in-progress',
        assignedWorkerId: workerId,
        assignedWorkerName: worker?.name || '',
        crew: worker?.name || '',
        resources
      });

      AdminToast.show(`🔗 Assigned ${worker?.name} to ${reportId}!`, 'success');
      this.refreshDashboard();
    });

    document.getElementById('btn-worker-photo')?.addEventListener('click', async () => {
      const reportId = document.getElementById('photo-report-select').value;
      const file = document.getElementById('worker-photo-input').files[0];
      if (!reportId || !file) {
        AdminToast.show('Select a complaint and repair photo', 'error');
        return;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const response = await fetch(`${ADMIN_API_BASE}/reports/${reportId}/worker-photo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ photo: reader.result })
          });
          if (!response.ok) throw new Error('Upload failed');
          document.getElementById('worker-photo-input').value = '';
          AdminToast.show(`📸 Repair photo uploaded for ${reportId}`, 'success');
          await Storage.fetchAllReports();
          this.renderWorkers();
          this.updateNavBadges();
        } catch (err) {
          AdminToast.show('Repair photo upload failed', 'error');
        }
      };
      reader.readAsDataURL(file);
    });
  },

  renderWorkers() {
    const tbody = document.getElementById('workers-tbody');
    if (!tbody) return;

    // Stats
    const el = id => document.getElementById(id);
    if (el('ws-total'))     el('ws-total').textContent = this.workers.length;
    if (el('ws-available')) el('ws-available').textContent = this.workers.filter(w => w.status === 'available').length;
    if (el('ws-busy'))      el('ws-busy').textContent = this.workers.filter(w => w.status === 'busy').length;
    if (el('ws-completed')) el('ws-completed').textContent = this.workers.reduce((s, w) => s + (w.completedJobs || 0), 0);

    tbody.innerHTML = this.workers.map(w => `
      <tr>
        <td style="font-weight:600;color:var(--text-primary)">${Security.sanitizeHTML(w.id)}</td>
        <td>${Security.sanitizeHTML(w.name)}</td>
        <td>${Security.sanitizeHTML(w.phone)}</td>
        <td><span class="worker-spec-badge">${Security.sanitizeHTML(w.specialization)}</span></td>
        <td><span class="worker-status-badge ${w.status}">${w.status === 'available' ? '✅ Available' : '🔧 On Job'}</span></td>
        <td>${w.currentAssignment ? `<a href="#" onclick="AdminApp.scrollToKanbanCard('${w.currentAssignment}')" style="color:#3B82F6">${Security.sanitizeHTML(w.currentAssignment)}</a>` : '—'}</td>
        <td style="text-align:center">${w.completedJobs || 0}</td>
        <td>
          <button class="worker-action-btn delete" onclick="AdminApp.deleteWorker('${w.id}')" title="Remove worker">🗑️</button>
        </td>
      </tr>
    `).join('');

    // Populate Quick Assign dropdowns
    const reportSelect = document.getElementById('qa-report-select');
    const workerSelect = document.getElementById('qa-worker-select');
    if (reportSelect) {
      const unresolvedReports = Storage.getAllReports().filter(r => r.status !== 'resolved');
      reportSelect.innerHTML = `<option value="">Select Complaint…</option>` +
        unresolvedReports.map(r => `<option value="${r.id}">${r.id} — ${Security.sanitizeHTML(r.address?.substring(0, 40) || 'Unknown')}</option>`).join('');
    }
    if (workerSelect) {
      const availableWorkers = this.workers.filter(w => w.status === 'available');
      workerSelect.innerHTML = `<option value="">Select Worker…</option>` +
        availableWorkers.map(w => `<option value="${w.id}">${w.name} (${w.specialization})</option>`).join('');
    }
    const photoReportSelect = document.getElementById('photo-report-select');
    if (photoReportSelect) {
      const assignedReports = Storage.getAllReports().filter(r => r.status !== 'resolved' && r.assignedWorkerId);
      photoReportSelect.innerHTML = `<option value="">Select Assigned Complaint…</option>` +
        assignedReports.map(r => `<option value="${r.id}">${r.id} — ${Security.sanitizeHTML(r.assignedWorkerName || 'Assigned worker')}</option>`).join('');
    }
  },

  async deleteWorker(id) {
    if (!confirm('Are you sure you want to remove this worker?')) return;
    try {
      await fetch(`${ADMIN_API_BASE}/workers/${id}`, { method: 'DELETE' });
      await this.fetchWorkers();
      this.renderWorkers();
      this.updateNavBadges();
      AdminToast.show('Worker removed', 'info');
    } catch { AdminToast.show('Failed to remove worker', 'error'); }
  },

  scrollToKanbanCard(id) {
    // Switch to kanban view and scroll to card
    document.querySelector('[data-view="admin-kanban"]')?.click();
    setTimeout(() => {
      const card = document.getElementById(`kcard-${id}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  },

  /* ══════════════════════════════════════════════════════════════
     PHOTO VERIFICATION PANEL
  ══════════════════════════════════════════════════════════════ */
  initPhotoVerification() {
    document.getElementById('compare-close')?.addEventListener('click', () => {
      document.getElementById('photo-compare-modal').classList.remove('open');
    });

    document.getElementById('compare-approve')?.addEventListener('click', async () => {
      const id = this._compareTicketId;
      if (!id) return;
      await fetch(`${ADMIN_API_BASE}/reports/${id}/resolve`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ afterPhoto: Storage.getReport(id)?.workerPhoto || null })
      }).catch(() => {});
      document.getElementById('photo-compare-modal').classList.remove('open');
      AdminToast.show(`✅ ${id} verified and marked as RESOLVED!`, 'success');
      this.refreshDashboard();
    });

    document.getElementById('compare-reject')?.addEventListener('click', async () => {
      const id = this._compareTicketId;
      if (!id) return;
      await Storage.updateReport(id, { status: 'pending', workerPhoto: null, workerPhotoUploadedAt: null });
      document.getElementById('photo-compare-modal').classList.remove('open');
      AdminToast.show(`❌ ${id} marked as UNRESOLVED — sent back to pending`, 'warning');
      this.refreshDashboard();
    });

    document.getElementById('compare-progress')?.addEventListener('click', async () => {
      const id = this._compareTicketId;
      if (!id) return;
      await Storage.updateReport(id, { status: 'in-progress', workerPhoto: null, workerPhotoUploadedAt: null });
      document.getElementById('photo-compare-modal').classList.remove('open');
      AdminToast.show(`🚧 ${id} needs more work — kept in progress`, 'info');
      this.refreshDashboard();
    });
  },

  renderVerification() {
    const container = document.getElementById('verification-list');
    if (!container) return;

    const reports = Storage.getAllReports().filter(r => r.workerPhoto && r.status !== 'resolved');

    if (reports.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--text-muted)">
          <div style="font-size:40px;margin-bottom:12px">📸</div>
          <div style="font-size:14px;font-weight:600">No photos awaiting verification.</div>
          <div style="font-size:12.5px;margin-top:6px">Worker photos will appear here when uploaded.</div>
        </div>`;
      return;
    }

    container.innerHTML = reports.map(r => `
      <div class="verification-card">
        <div class="verification-header">
          <span class="esc-ticket">${Security.sanitizeHTML(r.id)}</span>
          <span style="font-size:11px;color:#F59E0B;font-weight:600">📸 AWAITING VERIFICATION</span>
          <span style="font-size:10px;color:var(--text-muted)">Uploaded: ${r.workerPhotoUploadedAt ? new Date(r.workerPhotoUploadedAt).toLocaleString() : 'Unknown'}</span>
        </div>
        <div class="esc-desc">${Security.sanitizeHTML(r.description)}</div>
        <div class="esc-meta">
          📍 ${Security.sanitizeHTML(r.address)}
          ${r.assignedWorkerName ? ` | 👷 ${Security.sanitizeHTML(r.assignedWorkerName)}` : ''}
          | ⚠️ ${Security.sanitizeHTML(r.severity)}
        </div>
        <button class="btn-action primary" style="margin-top:8px" onclick="AdminApp.openPhotoCompare('${r.id}')">
          📸 Compare & Verify Photos
        </button>
      </div>
    `).join('');
  },

  openPhotoCompare(id) {
    this._compareTicketId = id;
    const report = Storage.getReport(id);
    if (!report) return;

    document.getElementById('compare-ticket-id').textContent = id;

    const beforeEl = document.getElementById('compare-before-img');
    const afterEl = document.getElementById('compare-after-img');
    const detailsEl = document.getElementById('compare-details');

    beforeEl.innerHTML = report.photo
      ? `<img src="${report.photo}" alt="Before photo" style="max-width:100%;max-height:250px;border-radius:6px" />`
      : '<div style="padding:40px;text-align:center;color:var(--text-muted)">No complaint photo</div>';

    afterEl.innerHTML = report.workerPhoto
      ? `<img src="${report.workerPhoto}" alt="Worker repair photo" style="max-width:100%;max-height:250px;border-radius:6px" />`
      : '<div style="padding:40px;text-align:center;color:var(--text-muted)">No worker photo</div>';

    detailsEl.innerHTML = `
      <strong>Location:</strong> ${Security.sanitizeHTML(report.address)} |
      <strong>Severity:</strong> ${Security.sanitizeHTML(report.severity)} |
      <strong>Worker:</strong> ${Security.sanitizeHTML(report.assignedWorkerName || 'N/A')} |
      <strong>Filed:</strong> ${new Date(report.createdAt).toLocaleDateString()}
    `;

    document.getElementById('photo-compare-modal').classList.add('open');
  },

  /* ── Analytics ────────────────────────────────────────────── */
  renderAnalytics() {
    const data = Storage.getAnalytics();
    this.renderZoneChart(data);
    this.renderSeverityChart(data);
    this.renderMonthlyChart(data);
    this.renderRoadTypeChart(data);
    this.updateKPIs(data);
    this.renderZonesTable(data);
  },

  destroyChart(name) {
    if (this.charts[name]) { this.charts[name].destroy(); delete this.charts[name]; }
  },

  renderZoneChart(data) {
    this.destroyChart('zone');
    const ctx = document.getElementById('zone-chart')?.getContext('2d');
    if (!ctx) return;
    const labels = Object.keys(data.zoneCounts);
    const values = Object.values(data.zoneCounts);
    this.charts.zone = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          label: 'Reports', data: values,
          backgroundColor: labels.map((_, i) => {
            const colors = ['rgba(124,58,237,0.7)', 'rgba(6,182,212,0.7)', 'rgba(249,115,22,0.7)', 'rgba(239,68,68,0.7)', 'rgba(16,185,129,0.7)', 'rgba(245,158,11,0.7)'];
            return colors[i % colors.length];
          }),
          borderRadius: 6, borderSkipped: false,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8892B0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#8892B0', stepSize: 1, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  },

  renderSeverityChart(data) {
    this.destroyChart('severity');
    const ctx = document.getElementById('severity-chart')?.getContext('2d');
    if (!ctx) return;
    this.charts.severity = new Chart(ctx, {
      type: 'doughnut',
      data: {
        labels: ['Low', 'Medium', 'High', 'Critical'],
        datasets: [{
          data: [data.severityCounts.low, data.severityCounts.medium, data.severityCounts.high, data.severityCounts.critical],
          backgroundColor: ['rgba(110,231,183,0.8)', 'rgba(252,211,77,0.8)', 'rgba(249,115,22,0.8)', 'rgba(239,68,68,0.8)'],
          borderWidth: 2, borderColor: '#0d1121', hoverOffset: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '65%',
        plugins: { legend: { position: 'bottom', labels: { color: '#8892B0', font: { size: 10 }, padding: 12, boxWidth: 10 } } }
      }
    });
  },

  renderMonthlyChart(data) {
    this.destroyChart('monthly');
    const ctx = document.getElementById('monthly-chart')?.getContext('2d');
    if (!ctx) return;
    this.charts.monthly = new Chart(ctx, {
      type: 'line',
      data: {
        labels: Object.keys(data.monthlyCounts),
        datasets: [{
          label: 'Reports', data: Object.values(data.monthlyCounts),
          borderColor: '#A78BFA', backgroundColor: 'rgba(124,58,237,0.1)', fill: true, tension: 0.4,
          pointBackgroundColor: '#A78BFA', pointRadius: 4, pointHoverRadius: 6,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8892B0', font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#8892B0', stepSize: 1, font: { size: 10 } }, grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  },

  renderRoadTypeChart(data) {
    this.destroyChart('roadtype');
    const ctx = document.getElementById('roadtype-chart')?.getContext('2d');
    if (!ctx) return;
    this.charts.roadtype = new Chart(ctx, {
      type: 'polarArea',
      data: {
        labels: ['Highway', 'City Road', 'Lane', 'Bridge'],
        datasets: [{
          data: [data.roadTypeCounts.highway, data.roadTypeCounts['city-road'], data.roadTypeCounts.lane, data.roadTypeCounts.bridge],
          backgroundColor: ['rgba(6,182,212,0.65)', 'rgba(124,58,237,0.65)', 'rgba(245,158,11,0.65)', 'rgba(16,185,129,0.65)'],
          borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)',
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { color: '#8892B0', font: { size: 10 }, padding: 10, boxWidth: 10 } } },
        scales: { r: { ticks: { color: '#8892B0', backdropColor: 'transparent', font: { size: 9 } }, grid: { color: 'rgba(255,255,255,0.06)' } } }
      }
    });
  },

  updateKPIs(data) {
    const el = id => document.getElementById(id);
    if (el('kpi-total'))   el('kpi-total').textContent   = Storage.getStats().total;
    if (el('kpi-resolved')) el('kpi-resolved').textContent = data.totalResolved;
    if (el('kpi-avgdays')) el('kpi-avgdays').textContent  = data.avgResolution > 0 ? `${data.avgResolution}d` : '—';
    const rate = data.totalResolved > 0 ? Math.round((data.totalResolved / Math.max(Storage.getStats().total, 1)) * 100) : 0;
    if (el('kpi-rate'))    el('kpi-rate').textContent    = `${rate}%`;
  },

  renderZonesTable(data) {
    const tbody = document.getElementById('zones-tbody');
    if (!tbody) return;
    const sorted = Object.entries(data.zoneCounts).sort((a, b) => b[1] - a[1]);
    const max = sorted[0]?.[1] || 1;
    const total = Math.max(Storage.getStats().total, 1);
    tbody.innerHTML = sorted.map(([zone, count]) => `
      <tr>
        <td>${zone}</td>
        <td>${count}</td>
        <td>
          <div class="zone-bar-row">
            <div class="zone-bar-bg"><div class="zone-bar-fill" style="width:${Math.round((count / max) * 100)}%"></div></div>
            <span style="font-size:10px;color:var(--text-muted);white-space:nowrap">${Math.round((count / total) * 100)}%</span>
          </div>
        </td>
      </tr>`).join('');
  },

  /* ── CSV Export ────────────────────────────────────────────── */
  exportCSV() {
    const reports = Storage.getAllReports();
    const headers = ['Ticket ID', 'Status', 'Severity', 'Road Type', 'Address', 'Zone', 'Reporter', 'Upvotes', 'Worker', 'Resources', 'Escalated', 'Created', 'Updated'];
    const rows = reports.map(r => [
      r.id, r.status, r.severity, r.roadType,
      `"${Security.stripTags(r.address || '')}"`, r.zone || '', `"${Security.stripTags(r.reporterName || '')}"`,
      r.upvotes || 0, r.assignedWorkerName || r.crew || '', r.resources || '', r.escalated ? 'Yes' : 'No',
      new Date(r.createdAt).toLocaleDateString(), new Date(r.updatedAt).toLocaleDateString()
    ]);
    const csv = [headers, ...rows].map(row => row.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = `pothole-reports-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click(); URL.revokeObjectURL(url);
    AdminToast.show('📊 CSV exported successfully!', 'success');
  },

  /* ── Error Log Viewer ─────────────────────────────────────── */
  renderErrorLog() {
    const container = document.getElementById('error-log-list');
    if (!container) return;
    const errors = ErrorTracker.getErrors();
    document.getElementById('error-count').textContent = errors.length;
    if (errors.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:8px">✅</div>No errors logged.</div>`;
      return;
    }
    const typeIcons = { uncaught_error: '💥', unhandled_promise: '⚡', gps_error: '📍', storage_error: '💾', photo_error: '📷' };
    const sevColors = { error: '#EF4444', warning: '#F59E0B', info: '#06B6D4' };
    container.innerHTML = errors.map(err => `
      <div style="padding:12px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:8px;background:rgba(255,255,255,0.02);border-left:3px solid ${sevColors[err.severity] || '#8892B0'}">
        <div style="display:flex;justify-content:space-between"><span style="font-size:12px;font-weight:600;color:${sevColors[err.severity] || '#8892B0'}">${typeIcons[err.type] || '❓'} ${Security.sanitizeHTML(err.type.replace(/_/g, ' ').toUpperCase())}</span><span style="font-size:10px;color:var(--text-muted)">${new Date(err.timestamp).toLocaleString()}</span></div>
        <div style="font-size:12px;color:var(--text-primary);margin-top:4px">${Security.sanitizeHTML(err.message)}</div>
      </div>`).join('');
  },

  /* ── Audit Log Viewer ─────────────────────────────────────── */
  renderAuditLog() {
    const container = document.getElementById('audit-log-list');
    if (!container) return;
    const entries = ErrorTracker.getAuditLog();
    document.getElementById('audit-count').textContent = entries.length;
    if (entries.length === 0) {
      container.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted)"><div style="font-size:32px;margin-bottom:8px">📋</div>No audit entries yet.</div>`;
      return;
    }
    const actionIcons = { report_submitted: '📝', status_change: '🔄', report_resolved: '✅', admin_login: '🔑', admin_logout: '🚪', csv_export: '📊', crew_assign: '👷' };
    container.innerHTML = entries.map(entry => `
      <div style="padding:10px 12px;border:1px solid rgba(255,255,255,0.06);border-radius:8px;margin-bottom:6px;background:rgba(255,255,255,0.02);display:flex;gap:10px">
        <span style="font-size:18px">${actionIcons[entry.action] || '📌'}</span>
        <div style="flex:1"><div style="font-size:12px;font-weight:600;color:var(--text-primary)">${Security.sanitizeHTML(entry.action.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()))}</div>
        <div style="font-size:11px;color:var(--text-secondary);margin-top:2px">${entry.reportId !== 'N/A' ? `Ticket: <strong>${Security.sanitizeHTML(entry.reportId)}</strong>` : ''}${entry.oldStatus ? ` — ${entry.oldStatus} → ${entry.newStatus}` : ''}</div></div>
        <span style="font-size:10px;color:var(--text-muted)">${new Date(entry.timestamp).toLocaleString()}</span>
      </div>`).join('');
  },
};

/* ── Boot ─────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => AdminApp.init());
