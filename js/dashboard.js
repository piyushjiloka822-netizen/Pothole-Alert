/**
 * Dashboard.js — Unified Dashboard Navigation Controller
 * Manages sidebar navigation, view switching, and admin gate for the
 * combined Citizen + Admin single-page dashboard.
 */

const Dashboard = {
  currentView: 'citizen-home',
  adminAuthenticated: false,
  sidebarCollapsed: false,

  /* ── Init ─────────────────────────────────────────────────── */
  init() {
    this.initSidebarNav();
    this.initSidebarToggle();
    this.initAdminGate();
    this.checkAdminSession();
    this.showView('citizen-home');

    // Check URL params for direct view
    const params = new URLSearchParams(window.location.search);
    const view = params.get('view');
    if (params.get('login') === 'citizen' && typeof openLoginModal === 'function') {
      openLoginModal();
    }
    if (view === 'admin') {
      this.toggleAdminLoginForm();
    }
  },

  /* ── Sidebar Navigation ──────────────────────────────────── */
  initSidebarNav() {
    document.querySelectorAll('.sidebar-nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => {
        const view = item.dataset.view;

        // Check if it's an admin view and user isn't authenticated
        if (item.dataset.role === 'admin' && !this.adminAuthenticated) {
          this.toggleAdminLoginForm();
          return;
        }

        this.showView(view);

        // Update active state
        document.querySelectorAll('.sidebar-nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');

        // Close mobile sidebar
        this.closeMobileSidebar();
      });
    });
  },

  /* ── Show View ───────────────────────────────────────────── */
  showView(viewId) {
    this.currentView = viewId;

    // Hide all views
    document.querySelectorAll('.dashboard-view').forEach(v => v.classList.remove('active'));

    // Show target view
    const target = document.getElementById('view-' + viewId);
    if (target) {
      target.classList.add('active');
    }

    // Special handling for citizen home: invalidate map size
    if (viewId === 'citizen-home') {
      setTimeout(() => {
        if (typeof App !== 'undefined' && App.map) {
          App.map.invalidateSize();
        }
      }, 100);
    }

    // Special handling for admin views
    if (viewId.startsWith('admin-')) {
      this.onAdminViewSwitch(viewId);
    }

    // Scroll to top of the view
    if (target) target.scrollTop = 0;
  },

  /* ── Admin View Switch ───────────────────────────────────── */
  onAdminViewSwitch(viewId) {
    const adminView = viewId.replace('admin-', '');
    if (typeof AdminApp !== 'undefined') AdminApp.currentView = adminView;

    // Update admin topbar title
    const titleMap = {
      'kanban': '📋 Complaint Board',
      'workers': '👷 Workers & Assign',
      'verification': '📸 Photo Verification',
      'analytics': '📊 Analytics',
      'escalated': '⚠️ Escalated',
      'errors': '🐛 Error Logs',
      'audit': '📜 Audit Trail'
    };
    const titleEl = document.getElementById('unified-topbar-title');
    if (titleEl) titleEl.textContent = titleMap[adminView] || 'Dashboard';

    // Trigger admin view renders
    if (typeof AdminApp !== 'undefined') {
      if (adminView === 'analytics') AdminApp.renderAnalytics();
      if (adminView === 'errors') AdminApp.renderErrorLog();
      if (adminView === 'audit') AdminApp.renderAuditLog();
      if (adminView === 'workers') AdminApp.renderWorkers();
      if (adminView === 'verification') AdminApp.renderVerification();
      if (adminView === 'kanban') { AdminApp.renderKanban(); AdminApp.updateStatCards(); }
      if (adminView === 'escalated') this.loadEscalated();
    }
  },

  /* ── Load Escalated ──────────────────────────────────────── */
  loadEscalated() {
    if (typeof Escalation === 'undefined') return;
    const escalated = Escalation.getEscalated();
    const container = document.getElementById('escalated-list');
    if (!container) return;

    if (escalated.length === 0) {
      container.innerHTML = `
        <div style="text-align:center;padding:60px 20px;color:var(--text-muted)">
          <div style="font-size:40px;margin-bottom:12px">✅</div>
          <div style="font-size:14px;color:var(--gov-green);font-weight:600">No escalated reports.</div>
          <div style="font-size:12.5px;margin-top:6px">All complaints are within the 30-day threshold.</div>
        </div>`;
      return;
    }

    container.innerHTML = escalated.map(r => `
      <div class="escalated-card">
        <div class="escalated-header">
          <span class="esc-ticket">${Security.sanitizeHTML(r.id)}</span>
          <span class="esc-badge">⚠️ ESCALATED</span>
          <span class="esc-days">${Escalation.getAgeDays(r)} days old</span>
        </div>
        <div class="esc-desc">${Security.sanitizeHTML(r.description)}</div>
        <div class="esc-meta">📍 ${Security.sanitizeHTML(r.address)} &nbsp;|&nbsp; 👍 ${r.upvotes} upvotes &nbsp;|&nbsp; ⚠️ ${Security.sanitizeHTML(r.severity)}</div>
      </div>`).join('');
  },

  /* ── Admin Gate ──────────────────────────────────────────── */
  initAdminGate() {
    // Toggle admin login form
    document.getElementById('admin-gate-btn')?.addEventListener('click', () => {
      this.toggleAdminLoginForm();
    });

    // Admin login form submit
    document.getElementById('sidebar-admin-login-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      await this.handleAdminLogin();
    });

    // Admin logout
    document.getElementById('admin-logout-btn')?.addEventListener('click', () => {
      this.handleAdminLogout();
    });
  },

  toggleAdminLoginForm() {
    const form = document.getElementById('sidebar-admin-login-form');
    if (form) {
      form.classList.toggle('visible');
      if (form.classList.contains('visible')) {
        form.querySelector('input')?.focus();
      }
    }
  },

  async handleAdminLogin() {
    const loginCheck = Security.checkLoginAllowed();
    if (!loginCheck.allowed) {
      this.showAdminError(loginCheck.message);
      return;
    }

    const pw = document.getElementById('sidebar-admin-password')?.value;
    const isValid = await Storage.verifyAdmin(pw);

    if (isValid) {
      Security.clearLoginAttempts();
      Security.createAdminSession();
      this.adminAuthenticated = true;
      this.onAdminAuthenticated();

      if (typeof ErrorTracker !== 'undefined') {
        ErrorTracker.logAudit('admin_login', 'N/A', { action: 'login_success' });
      }
    } else {
      const result = Security.recordFailedLogin();
      if (result.locked) {
        this.showAdminError('Account locked for 15 minutes due to too many failed attempts.');
      } else {
        this.showAdminError(`Invalid password. ${result.attemptsLeft} attempt(s) remaining.`);
      }
      document.getElementById('sidebar-admin-password').value = '';
    }
  },

  showAdminError(msg) {
    const errEl = document.getElementById('sidebar-admin-error');
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.add('visible');
      setTimeout(() => errEl.classList.remove('visible'), 5000);
    }
  },

  onAdminAuthenticated() {
    // Hide login form, show admin nav items
    document.getElementById('sidebar-admin-login-form')?.classList.remove('visible');
    document.getElementById('admin-gate-btn')?.style.setProperty('display', 'none');
    document.querySelectorAll('.sidebar-nav-item[data-role="admin"]').forEach(el => {
      el.style.display = 'flex';
    });
    document.getElementById('admin-section-title')?.style.setProperty('display', 'block');
    document.getElementById('admin-alerts-title')?.style.setProperty('display', 'block');
    document.getElementById('admin-system-title')?.style.setProperty('display', 'block');
    document.getElementById('admin-logout-btn')?.style.setProperty('display', 'block');

    // Update user area
    const avatarEl = document.querySelector('.sidebar-user-avatar');
    const nameEl = document.querySelector('.sidebar-user-name');
    const roleEl = document.querySelector('.sidebar-user-role');
    if (avatarEl) avatarEl.textContent = 'O';
    if (nameEl) nameEl.textContent = 'Officer';
    if (roleEl) roleEl.textContent = 'Roads Dept., MCL';

    // Init admin dashboard
    if (typeof AdminApp !== 'undefined') {
      AdminApp.initDashboardUnified();
    }

    // Show the admin kanban view
    this.showView('admin-kanban');
    document.querySelectorAll('.sidebar-nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.sidebar-nav-item[data-view="admin-kanban"]')?.classList.add('active');

    // Start session timer
    this.startSessionTimer();
  },

  handleAdminLogout() {
    Security.destroyAdminSession();
    this.adminAuthenticated = false;

    if (typeof ErrorTracker !== 'undefined') {
      ErrorTracker.logAudit('admin_logout', 'N/A', { action: 'logout' });
    }

    if (typeof AdminApp !== 'undefined' && AdminApp.sseSource) {
      AdminApp.sseSource.close();
    }

    // Hide admin nav items
    document.querySelectorAll('.sidebar-nav-item[data-role="admin"]').forEach(el => {
      el.style.display = 'none';
    });
    document.getElementById('admin-section-title')?.style.setProperty('display', 'none');
    document.getElementById('admin-alerts-title')?.style.setProperty('display', 'none');
    document.getElementById('admin-system-title')?.style.setProperty('display', 'none');
    document.getElementById('admin-logout-btn')?.style.setProperty('display', 'none');
    document.getElementById('admin-gate-btn')?.style.setProperty('display', 'flex');

    // Update user area
    const nameEl = document.querySelector('.sidebar-user-name');
    const roleEl = document.querySelector('.sidebar-user-role');
    const avatarEl = document.querySelector('.sidebar-user-avatar');
    if (avatarEl) avatarEl.textContent = 'C';
    if (nameEl) nameEl.textContent = 'Citizen';
    if (roleEl) roleEl.textContent = 'Public Portal';

    // Switch to citizen home
    this.showView('citizen-home');
    document.querySelectorAll('.sidebar-nav-item').forEach(n => n.classList.remove('active'));
    document.querySelector('.sidebar-nav-item[data-view="citizen-home"]')?.classList.add('active');

    // Stop session timer
    if (this._sessionInterval) clearInterval(this._sessionInterval);

    if (typeof Toast !== 'undefined') {
      Toast.show('Logged out from Officer Portal.', 'info');
    }
  },

  checkAdminSession() {
    if (Security.isAdminSessionValid()) {
      this.adminAuthenticated = true;
      this.onAdminAuthenticated();
    }
  },

  startSessionTimer() {
    if (this._sessionInterval) clearInterval(this._sessionInterval);
    this._sessionInterval = setInterval(() => {
      if (!Security.isAdminSessionValid()) {
        clearInterval(this._sessionInterval);
        if (typeof Toast !== 'undefined') {
          Toast.show('⏱️ Session expired — please log in again.', 'warning');
        }
        this.handleAdminLogout();
      }
      const remaining = Security.getSessionTimeRemaining();
      const timerEl = document.getElementById('session-timer');
      if (timerEl) timerEl.textContent = `Session: ${remaining}m`;
    }, 30000);

    const timerEl = document.getElementById('session-timer');
    if (timerEl) timerEl.textContent = `Session: ${Security.getSessionTimeRemaining()}m`;
  },

  /* ── Sidebar Toggle ──────────────────────────────────────── */
  initSidebarToggle() {
    document.getElementById('sidebar-collapse-btn')?.addEventListener('click', () => {
      const sidebar = document.querySelector('.dashboard-sidebar');
      sidebar?.classList.toggle('collapsed');
      this.sidebarCollapsed = sidebar?.classList.contains('collapsed');

      // Invalidate map size after sidebar animation
      setTimeout(() => {
        if (typeof App !== 'undefined' && App.map) {
          App.map.invalidateSize();
        }
      }, 350);
    });

    // Mobile hamburger
    document.getElementById('mobile-sidebar-btn')?.addEventListener('click', () => {
      this.openMobileSidebar();
    });
  },

  openMobileSidebar() {
    document.querySelector('.dashboard-sidebar')?.classList.add('mobile-open');
    document.getElementById('mobile-sidebar-overlay')?.classList.add('active');
  },

  closeMobileSidebar() {
    document.querySelector('.dashboard-sidebar')?.classList.remove('mobile-open');
    document.getElementById('mobile-sidebar-overlay')?.classList.remove('active');
  }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  Dashboard.init();
});
