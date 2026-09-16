/**
 * App.js — Citizen Portal Core Logic
 * Pothole Reporting Application
 */

/* ── Toast Helper ─────────────────────────────────────────────── */
const Toast = {
  container: null,
  init() {
    this.container = document.getElementById('toast-container');
  },
  show(message, type = 'info', duration = 3500) {
    if (!this.container) return;
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    this.container.appendChild(el);
    setTimeout(async () => {
      el.classList.add('removing');
      setTimeout(() => el.remove(), 350);
    }, duration);
  }
};

/* ── App State ────────────────────────────────────────────────── */
const App = {
  map: null,
  markers: {},
  selectedLat: null,
  selectedLng: null,
  selectedPhoto: null,
  selectedSeverity: 'medium',
  currentFilter: 'all',
  currentTab: 'feed',
  pendingDuplicate: null,
  userId: null,

  /* ── Init ─────────────────────────────────────────────────── */
  init() {
    CloudSync.init();
    Storage.clearDemoData(); // wipe old demo data — start fresh
    this.userId = Storage.getUserId();
    Toast.init();

    // Init error tracking (global error handlers)
    ErrorTracker.init();
    ErrorTracker.perfStart('app-init');

    // Run escalation check
    Escalation.runCheck();

    // Init offline support
    Offline.init((syncedReports) => {
      syncedReports.forEach(r => this.addMarker(r));
      this.renderFeed();
    });

    this.initMap();
    this.initDrawer();
    this.initSeverityPicker();
    this.initPhotoUpload();
    this.initNotifications();
    this.initServerEvents();
    this.updateStats();
    this.renderFeed();
    this.renderGallery();
    this.loadAllMarkers();

    // Side panel toggle
    document.getElementById('panel-toggle')?.addEventListener('click', () => {
      document.getElementById('side-panel').classList.toggle('collapsed');
      document.getElementById('panel-toggle').innerHTML =
        document.getElementById('side-panel').classList.contains('collapsed') ? '‹' : '›';
    });

    // Tab switching
    document.querySelectorAll('.panel-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.panel-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentTab = tab.dataset.tab;
        document.querySelectorAll('.panel-content').forEach(c => c.classList.add('hidden'));
        document.getElementById(`tab-${this.currentTab}`)?.classList.remove('hidden');
      });
    });

    // Filter chips
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        this.currentFilter = chip.dataset.filter;
        this.renderFeed();
      });
    });

    // Notification bell
    document.getElementById('notif-btn')?.addEventListener('click', (e) => {
      e.stopPropagation();
      const panel = document.getElementById('notif-panel');
      panel.classList.toggle('open');
      if (panel.classList.contains('open')) {
        Storage.markNotificationsRead(this.userId);
        this.renderNotifications();
        this.updateNotifBadge();
      }
    });

    document.addEventListener('click', () => {
      document.getElementById('notif-panel')?.classList.remove('open');
    });

    // Re-render live when reports change in the shared database (e.g. an
    // admin updates a status, or another citizen submits/upvotes a report).
    window.addEventListener('cloud-reports-updated', () => this.refreshFromCloud());

    // Log app init performance
    const initTime = ErrorTracker.perfEnd('app-init');
    if (initTime) console.log(`[App] Initialized in ${initTime}ms`);
  },

  /* ── Full re-render after a cloud sync push ─────────────────── */
  refreshFromCloud() {
    Object.values(this.markers).forEach(m => this.map.removeLayer(m));
    this.markers = {};
    this.loadAllMarkers();
    if (this.showingHeatmap) this.refreshHeatmap();
    this.updateStats();
    this.renderFeed();
    this.renderGallery();
  },

  initServerEvents() {
    if (!window.EventSource) return;
    try {
      const source = new EventSource('/api/events');
      const refresh = () => {
        Storage.fetchAllReports().then(() => {
          this.updateStats();
          this.renderFeed();
          this.renderGallery();
          Storage.fetchNotifications(this.userId).then(() => {
            this.updateNotifBadge();
            this.renderNotifications();
          });
        });
      };
      source.addEventListener('report_updated', refresh);
      source.addEventListener('report_resolved', refresh);
      window.addEventListener('beforeunload', () => source.close(), { once: true });
    } catch (err) {
      console.warn('[App] Server event stream unavailable:', err);
    }
  },

  /* ── Map ──────────────────────────────────────────────────── */
  initMap() {
    this.map = L.map('map', {
      center: [26.8467, 80.9462],  // Lucknow, Uttar Pradesh
      zoom: 12,
      zoomControl: false,
    });

    // Tile layer - OpenStreetMap
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19,
    }).addTo(this.map);

    // Custom zoom control
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // Click on map to set location
    this.map.on('click', (e) => {
      if (document.getElementById('report-drawer').classList.contains('open')) {
        this.setLocation(e.latlng.lat, e.latlng.lng, 'Map pin');
        Toast.show('📍 Location pinned on map', 'info', 2000);
      }
    });

    this.initHeatmapToggle();
  },

  /* ── Heatmap ──────────────────────────────────────────────── */
  heatLayer: null,
  showingHeatmap: false,

  initHeatmapToggle() {
    if (typeof L.heatLayer !== 'function') return; // plugin failed to load — skip silently

    const HeatControl = L.Control.extend({
      options: { position: 'topright' },
      onAdd: () => {
        const btn = L.DomUtil.create('button', 'leaflet-heat-toggle');
        btn.type = 'button';
        btn.title = 'Toggle pothole density heatmap';
        btn.innerHTML = '🔥 Heatmap';
        L.DomEvent.disableClickPropagation(btn);
        L.DomEvent.on(btn, 'click', () => this.toggleHeatmap(btn));
        return btn;
      }
    });
    this.map.addControl(new HeatControl());
  },

  toggleHeatmap(btn) {
    this.showingHeatmap = !this.showingHeatmap;

    if (this.showingHeatmap) {
      const weight = { low: 0.35, medium: 0.6, high: 0.85, critical: 1 };
      const points = Storage.getAllReports()
        .filter(r => r.status !== 'resolved')
        .map(r => [r.lat, r.lng, weight[r.severity] || 0.5]);

      this.heatLayer = L.heatLayer(points, { radius: 28, blur: 22, maxZoom: 17 }).addTo(this.map);
      Object.values(this.markers).forEach(m => this.map.removeLayer(m));
      if (btn) { btn.classList.add('active'); btn.innerHTML = '📍 Pins'; }
    } else {
      if (this.heatLayer) { this.map.removeLayer(this.heatLayer); this.heatLayer = null; }
      Object.values(this.markers).forEach(m => m.addTo(this.map));
      if (btn) { btn.classList.remove('active'); btn.innerHTML = '🔥 Heatmap'; }
    }
  },

  loadAllMarkers() {
    const reports = Storage.getAllReports();
    reports.forEach(r => this.addMarker(r));
  },

  addMarker(report) {
    // Remove existing marker if updating
    if (this.markers[report.id]) {
      this.map.removeLayer(this.markers[report.id]);
    }

    const icon = this.createPinIcon(report.status, report.severity);
    const marker = L.marker([report.lat, report.lng], { icon });
    if (!this.showingHeatmap) marker.addTo(this.map);
    marker.bindPopup(this.buildPopupHtml(report), {
        maxWidth: 320,
        className: 'custom-popup'
      });

    marker.on('click', () => {
      this.map.setView([report.lat, report.lng], Math.max(this.map.getZoom(), 15), { animate: true, duration: 0.5 });
    });

    marker.on('popupopen', () => {
      // Upvote button in popup
      const upvoteBtn = document.getElementById(`upvote-${report.id}`);
      if (upvoteBtn) {
        upvoteBtn.addEventListener('click', () => this.upvoteFromPopup(report.id));
      }

      // View details button
      const viewBtn = document.getElementById(`view-${report.id}`);
      if (viewBtn) {
        viewBtn.addEventListener('click', () => {
          marker.closePopup();
          this.scrollToCard(report.id);
        });
      }
    });

    this.markers[report.id] = marker;

    if (this.showingHeatmap) this.refreshHeatmap();
  },

  refreshHeatmap() {
    if (!this.showingHeatmap || typeof L.heatLayer !== 'function') return;
    if (this.heatLayer) this.map.removeLayer(this.heatLayer);
    const weight = { low: 0.35, medium: 0.6, high: 0.85, critical: 1 };
    const points = Storage.getAllReports()
      .filter(r => r.status !== 'resolved')
      .map(r => [r.lat, r.lng, weight[r.severity] || 0.5]);
    this.heatLayer = L.heatLayer(points, { radius: 28, blur: 22, maxZoom: 17 }).addTo(this.map);
  },

  createPinIcon(status, severity) {
    const colors = {
      pending: '#EF4444',
      scheduled: '#F59E0B',
      'in-progress': '#F97316',
      resolved: '#10B981'
    };
    const sizes = { critical: 36, high: 30, medium: 25, low: 20 };
    const icons = { pending: '⚠', scheduled: '🔧', 'in-progress': '🚧', resolved: '✓' };

    const color = colors[status] || '#EF4444';
    const size = sizes[severity] || 25;
    const icon = icons[status] || '⚠';
    const pulse = (status === 'pending' && severity === 'critical') ? 'animation:pin-pulse 2s ease-in-out infinite;' : '';

    return L.divIcon({
      className: '',
      html: `<div style="
        display:flex;flex-direction:column;align-items:center;
        filter:drop-shadow(0 4px 8px rgba(0,0,0,0.5));
        cursor:pointer;
      ">
        <div style="
          width:${size}px;height:${size}px;
          background:${color};
          border-radius:50% 50% 50% 0;
          transform:rotate(-45deg);
          border:2.5px solid rgba(255,255,255,0.95);
          display:flex;align-items:center;justify-content:center;
          box-shadow:0 0 12px ${color}66;
          ${pulse}
        ">
          <span style="transform:rotate(45deg);font-size:${Math.floor(size * 0.38)}px;line-height:1;">${icon}</span>
        </div>
        <div style="width:2px;height:6px;background:${color};margin-top:-1px;opacity:0.7;"></div>
      </div>`,
      iconSize: [size, size + 8],
      iconAnchor: [size / 2, size + 6],
      popupAnchor: [0, -(size + 8)]
    });
  },

  buildPopupHtml(report) {
    const voted = Storage.hasUserUpvoted(report.id);
    const escInfo = Escalation.formatBadge(report);
    const age = Escalation.formatAge(report);
    const statusLabel = { pending: 'Pending', scheduled: 'Scheduled', 'in-progress': 'In Progress', resolved: 'Resolved' };
    const roadLabels = { highway: 'Highway', 'city-road': 'City Road', lane: 'Lane', bridge: 'Bridge' };

    return `<div class="popup-content">
      <div class="popup-header">
        <span class="popup-ticket">${Security.sanitizeHTML(report.id)}</span>
        <span class="popup-status-badge ${report.status}">${statusLabel[report.status] || Security.sanitizeHTML(report.status)}</span>
      </div>
      ${escInfo.show ? `<div class="popup-escalated">⚠️ ${Security.sanitizeHTML(escInfo.tooltip)}</div>` : ''}
      <div class="popup-desc">${Security.sanitizeHTML(report.description)}</div>
      <div class="popup-meta">
        <span class="popup-tag sev-${report.severity}">⚡ ${Security.sanitizeHTML(report.severity.charAt(0).toUpperCase() + report.severity.slice(1))}</span>
        <span class="popup-tag">🛣️ ${roadLabels[report.roadType] || Security.sanitizeHTML(report.roadType)}</span>
        <span class="popup-tag">📅 ${Security.sanitizeHTML(age)}</span>
        ${report.crew ? `<span class="popup-tag">👷 ${Security.sanitizeHTML(report.crew)}</span>` : ''}
      </div>
      <div class="popup-actions">
        <button id="upvote-${report.id}" class="popup-btn upvote-btn ${voted ? 'voted' : ''}">
          ${voted ? '✅' : '👍'} ${report.upvotes || 0} ${voted ? 'Voted' : 'Upvote'}
        </button>
        <button id="view-${report.id}" class="popup-btn">📋 Details</button>
      </div>
    </div>`;
  },

  upvoteFromPopup(reportId) {
    const result = Storage.upvoteReport(reportId);
    if (!result) return;

    if (result.alreadyVoted) {
      Toast.show('You already upvoted this report!', 'warning', 2000);
      return;
    }

    Toast.show(`👍 Upvoted ${reportId}! (${result.report.upvotes} votes)`, 'success', 2000);
    this.addMarker(result.report); // refresh marker
    this.renderFeed();

    // Close and reopen popup to refresh content
    if (this.markers[reportId]) {
      this.markers[reportId].closePopup();
      this.markers[reportId].setPopupContent(this.buildPopupHtml(result.report));
      this.markers[reportId].openPopup();
    }
  },

  /* ── Quick Report: photo-only, one-tap flow ──────────────────
   * Citizen taps once, captures/uploads a photo, and we auto-attach their
   * live GPS location — no form fields required. Used for the "⚡ Quick
   * Report" entry point instead of the full complaint form.
   */
  quickReport() {
    if (!navigator.geolocation) {
      Toast.show('❌ Quick Report needs GPS location, which isn\'t supported on this browser. Use the full "Report a Pothole" form instead.', 'error');
      return;
    }

    Camera.open(async (dataUrl) => {
      Toast.show('📸 Photo captured — getting your live location…', 'info', 2500);
      const compressed = await Security.compressImage(dataUrl, 800, 0.6).catch(() => dataUrl);
      this.selectedPhoto = compressed;
      this.runAIPhotoCheck(compressed); // stores result on this._lastAICheck for the report

      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude: lat, longitude: lng } = pos.coords;
          const coordCheck = Security.validateCoordinates(lat, lng);
          if (!coordCheck.valid) {
            Toast.show(`📍 ${coordCheck.message}`, 'warning');
            return;
          }
          this._quickSubmit(lat, lng);
        },
        (err) => {
          ErrorTracker.logGPSError(err.code, err.message);
          Toast.show(`📍 Could not get your live location: ${err.message}. Use the full form to pin it on the map instead.`, 'error');
        },
        { enableHighAccuracy: true, timeout: 10000 }
      );
    });
  },

  _quickSubmit(lat, lng) {
    this.selectedLat = lat;
    this.selectedLng = lng;
    this.selectedSeverity = this.selectedSeverity || 'medium';

    const allReports = Storage.getAllReports();
    const duplicate = Duplicate.checkDuplicate(lat, lng, allReports);
    if (duplicate) {
      this.pendingDuplicate = duplicate;
      this.showDuplicateModal(duplicate);
      return;
    }

    this.commitSubmit({
      desc: 'Reported via Quick Report — photo and live GPS location only.',
      roadType: 'city-road',
      reporterName: 'Anonymous',
      address: `Live GPS location (${lat.toFixed(5)}, ${lng.toFixed(5)})`,
      zone: 'Other'
    });

    // Ping the admin dashboard's live feed — shows a brief "new photo
    // captured from this location" flash that disappears after 2 seconds.
    if (typeof CloudSync !== 'undefined') {
      CloudSync.pushLiveCapture({ lat, lng, capturedAt: new Date().toISOString() });
    }
  },

  /* ── Report Drawer ────────────────────────────────────────── */
  initDrawer() {
    const drawer = document.getElementById('report-drawer');
    const overlay = document.getElementById('drawer-overlay');
    const closeBtn = document.getElementById('drawer-close');
    const form = document.getElementById('report-form');

    // FAB removed — nav button handled in index.html via openReportDrawer()
    closeBtn?.addEventListener('click', () => this.closeDrawer());
    overlay?.addEventListener('click', () => this.closeDrawer());

    // GPS button
    document.getElementById('btn-gps')?.addEventListener('click', () => this.getGPS());

    // Road type
    document.getElementById('road-type')?.addEventListener('change', () => {});

    // Form submit
    form?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.submitReport();
    });
  },

  openDrawer() {
    document.getElementById('report-drawer').classList.add('open');
    document.getElementById('drawer-overlay').classList.add('active');
    document.body.style.overflow = 'hidden';
  },

  closeDrawer() {
    document.getElementById('report-drawer').classList.remove('open');
    document.getElementById('drawer-overlay').classList.remove('active');
    document.body.style.overflow = '';
  },

  /* ── GPS ──────────────────────────────────────────────────── */
  getGPS() {
    const btn = document.getElementById('btn-gps');
    btn.innerHTML = '⟳ Locating…';
    btn.disabled = true;

    if (!navigator.geolocation) {
      Toast.show('❌ Geolocation not supported by your browser', 'error');
      btn.innerHTML = '📡 GPS';
      btn.disabled = false;
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude: lat, longitude: lng } = pos.coords;
        // Validate coordinates
        const coordCheck = Security.validateCoordinates(lat, lng);
        if (!coordCheck.valid) {
          Toast.show(`📍 ${coordCheck.message}`, 'warning');
          ErrorTracker.logGPSError('BOUNDS', coordCheck.message);
          btn.innerHTML = '📡 GPS';
          btn.disabled = false;
          return;
        }
        this.setLocation(lat, lng, 'GPS location');
        this.map.setView([lat, lng], 16, { animate: true });
        Toast.show('📍 GPS location detected!', 'success', 2000);
        btn.innerHTML = '✅ Located';
        setTimeout(() => { btn.innerHTML = '📡 GPS'; btn.disabled = false; }, 2000);
      },
      (err) => {
        ErrorTracker.logGPSError(err.code, err.message);
        Toast.show(`📍 GPS error: ${err.message}. Tap map to pin location.`, 'warning');
        btn.innerHTML = '📡 GPS';
        btn.disabled = false;
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  },

  setLocation(lat, lng, label) {
    this.selectedLat = lat;
    this.selectedLng = lng;
    const display = document.getElementById('location-display');
    display.innerHTML = `📍 ${label} (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
    display.classList.add('has-location');

    // Show a temp marker on map
    if (this._tempMarker) this.map.removeLayer(this._tempMarker);
    this._tempMarker = L.circleMarker([lat, lng], {
      radius: 10, color: '#004080', fillColor: '#2980b9',
      fillOpacity: 0.7, weight: 2
    }).addTo(this.map);
  },

  /* ── Severity Picker ──────────────────────────────────────── */
  initSeverityPicker() {
    document.querySelectorAll('.severity-option').forEach(opt => {
      opt.addEventListener('click', () => {
        document.querySelectorAll('.severity-option').forEach(o => o.classList.remove('selected'));
        opt.classList.add('selected');
        this.selectedSeverity = opt.dataset.sev;
      });
    });
    // Default: medium selected
    document.querySelector('.severity-option[data-sev="medium"]')?.classList.add('selected');
  },

  /* ── Photo Upload ─────────────────────────────────────────── */
  initPhotoUpload() {
    const area = document.getElementById('photo-upload-area');
    const input = document.getElementById('photo-input');
    const preview = document.getElementById('photo-preview');

    area?.addEventListener('click', () => input.click());

    area?.addEventListener('dragover', (e) => {
      e.preventDefault();
      area.classList.add('dragover');
    });

    area?.addEventListener('dragleave', () => area.classList.remove('dragover'));

    area?.addEventListener('drop', (e) => {
      e.preventDefault();
      area.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) this.loadPhoto(file);
    });

    input?.addEventListener('change', () => {
      if (input.files[0]) this.loadPhoto(input.files[0]);
    });

    document.getElementById('photo-remove')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.selectedPhoto = null;
      preview.style.display = 'none';
      preview.querySelector('img').src = '';
      input.value = '';
      const aiBox = document.getElementById('ai-check-box');
      if (aiBox) { aiBox.style.display = 'none'; aiBox.innerHTML = ''; }
    });

    // Live camera capture button
    document.getElementById('btn-open-camera')?.addEventListener('click', () => {
      Camera.open((dataUrl) => this.setPhotoFromDataUrl(dataUrl));
    });
  },

  loadPhoto(file) {
    // Validate file type and size
    const validation = Security.validatePhoto(file);
    if (!validation.valid) {
      Toast.show(validation.message, 'error');
      ErrorTracker.logPhotoError(validation.message, { fileName: file.name, fileSize: file.size });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => this.setPhotoFromDataUrl(e.target.result);
    reader.readAsDataURL(file);
  },

  /**
   * Shared path for both file-upload and live-camera-capture photos:
   * compress, preview, and run the (non-blocking) AI/heuristic photo check.
   */
  async setPhotoFromDataUrl(rawDataUrl) {
    const preview = document.getElementById('photo-preview');
    let finalDataUrl = rawDataUrl;

    try {
      finalDataUrl = await Security.compressImage(rawDataUrl, 800, 0.6);
      const originalSize = Math.round(rawDataUrl.length / 1024);
      const compressedSize = Math.round(finalDataUrl.length / 1024);
      const saved = Math.round((1 - compressedSize / originalSize) * 100);
      if (saved > 5) Toast.show(`🖼️ Photo compressed (${saved}% smaller)`, 'info', 2000);
    } catch (err) {
      ErrorTracker.logPhotoError('Image compression failed', { error: err.message });
      // fall back to the raw data URL
    }

    this.selectedPhoto = finalDataUrl;
    preview.querySelector('img').src = finalDataUrl;
    preview.style.display = 'block';

    this.runAIPhotoCheck(finalDataUrl);
  },

  /**
   * Non-blocking AI/heuristic check on the selected photo. Never prevents
   * submission — it just surfaces a helpful signal to the citizen (and the
   * same result is stored on the report for the reviewing officer).
   */
  async runAIPhotoCheck(dataUrl) {
    const box = document.getElementById('ai-check-box');
    if (!box || typeof AIVerify === 'undefined') return;

    box.style.display = 'block';
    box.innerHTML = `<div class="ai-check-row">🤖 Checking photo…</div>`;

    try {
      const result = await AIVerify.analyze(dataUrl);
      this._lastAICheck = result;
      AIVerify.renderResult(box, result);
    } catch (err) {
      box.style.display = 'none';
      ErrorTracker.logPhotoError?.('AI photo check failed', { error: err.message });
    }
  },

  /* ── Submit Report ────────────────────────────────────────── */
  async submitReport() {
    // Validate location
    if (!this.selectedLat || !this.selectedLng) {
      Toast.show('📍 Please set a location (GPS or tap map)', 'error');
      return;
    }

    // Validate coordinates are in India
    const coordCheck = Security.validateCoordinates(this.selectedLat, this.selectedLng);
    if (!coordCheck.valid) {
      Toast.show(`📍 ${coordCheck.message}`, 'error');
      return;
    }

    const desc = document.getElementById('report-desc').value.trim();

    // Validate description
    const descCheck = Security.validateField('description', desc);
    if (!descCheck.valid) {
      Toast.show(`📝 ${descCheck.message}`, 'error');
      return;
    }

    // CAPTCHA check
    const captcha = document.getElementById('captcha-check');
    if (captcha && !captcha.checked) {
      Toast.show('⚠️ Please complete the CAPTCHA verification', 'error');
      return;
    }

    // Rate limit check
    const rateCheck = Security.canSubmitReport(this.userId);
    if (!rateCheck.allowed) {
      Toast.show(`⚠️ ${rateCheck.message}`, 'error');
      return;
    }

    const roadType = document.getElementById('road-type').value;
    const reporterName = document.getElementById('reporter-name').value.trim() || 'Anonymous';
    const address = document.getElementById('report-address').value.trim() || 'Unknown location';
    const zone = document.getElementById('report-zone').value;

    // Validate reporter name
    if (reporterName !== 'Anonymous') {
      const nameCheck = Security.validateField('reporterName', reporterName);
      if (!nameCheck.valid) {
        Toast.show(nameCheck.message, 'error');
        return;
      }
    }

    // Validate address
    if (address !== 'Unknown location') {
      const addrCheck = Security.validateField('address', address);
      if (!addrCheck.valid) {
        Toast.show(addrCheck.message, 'error');
        return;
      }
    }

    // Check for duplicates
    const allReports = Storage.getAllReports();
    const duplicate = Duplicate.checkDuplicate(this.selectedLat, this.selectedLng, allReports);

    if (duplicate) {
      this.pendingDuplicate = duplicate;
      this.showDuplicateModal(duplicate);
      return;
    }

    this.commitSubmit({ desc: Security.stripTags(desc), roadType, reporterName: Security.stripTags(reporterName), address: Security.stripTags(address), zone });
  },

  showDuplicateModal(dup) {
    const { report, distance } = dup;
    document.getElementById('dup-ticket').textContent = report.id;
    document.getElementById('dup-addr').textContent = `📍 ${report.address}`;
    document.getElementById('dup-votes').textContent = `👍 ${report.upvotes} upvotes`;
    document.getElementById('dup-distance').textContent = `📏 ${Duplicate.formatDistance(distance)}`;

    document.getElementById('dup-modal').classList.add('open');

    document.getElementById('dup-upvote-btn').onclick = () => {
      this.upvoteFromPopup(report.id);
      document.getElementById('dup-modal').classList.remove('open');
      this.closeDrawer();
      this.resetForm();
      Toast.show(`✅ Upvoted existing report ${report.id}!`, 'success');
    };

    document.getElementById('dup-submit-anyway').onclick = () => {
      document.getElementById('dup-modal').classList.remove('open');
      const desc = document.getElementById('report-desc').value.trim();
      const roadType = document.getElementById('road-type').value;
      const reporterName = document.getElementById('reporter-name').value.trim() || 'Anonymous';
      const address = document.getElementById('report-address').value.trim() || 'Unknown location';
      const zone = document.getElementById('report-zone').value;
      this.commitSubmit({ desc, roadType, reporterName, address, zone });
    };

    document.getElementById('dup-cancel').onclick = () => {
      document.getElementById('dup-modal').classList.remove('open');
    };
  },

  commitSubmit({ desc, roadType, reporterName, address, zone }) {
    const submitBtn = document.getElementById('submit-btn');
    submitBtn.classList.add('loading');
    submitBtn.disabled = true;

    setTimeout(async () => {
      const ticketId = Storage.generateTicketId();
      const report = {
        id: ticketId, ticketId,
        lat: this.selectedLat, lng: this.selectedLng,
        description: desc,
        severity: this.selectedSeverity,
        roadType, address, zone,
        reporterName,
        reporterId: this.userId,
        status: 'pending',
        upvotes: 0, voters: [],
        photo: this.selectedPhoto,
        afterPhoto: null,
        aiCheck: this._lastAICheck ? {
          heuristicLevel: this._lastAICheck.heuristics?.level || 'unknown',
          heuristicMessages: this._lastAICheck.heuristics?.messages || [],
          aiAvailable: !!this._lastAICheck.server?.available,
          aiIsPothole: this._lastAICheck.server?.isPothole ?? null,
          aiConfidence: this._lastAICheck.server?.confidence ?? null,
          aiDepth: this._lastAICheck.server?.depth ?? null,
          aiSeverity: this._lastAICheck.server?.severity ?? null,
        } : null,
        depthEstimate: this._lastAICheck?.server?.depth || '',
        crew: null, escalated: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      if (Offline.isOnline()) {
        const savedReport = await Storage.saveReport(report);
        // Record rate limit
        Security.recordSubmission(this.userId);
        // Audit trail
        ErrorTracker.logAudit('report_submitted', ticketId, {
          severity: this.selectedSeverity,
          zone,
          reporterName,
        });
        this.addMarker(savedReport || report);
        this.renderFeed();
        this.updateStats();
        this.closeDrawer();
        this.resetForm();
        this.showTicketSuccess(savedReport?.id || ticketId);
      } else {
        Offline.queueReport(report);
        this.closeDrawer();
        this.resetForm();
      }

      submitBtn.classList.remove('loading');
      submitBtn.disabled = false;
    }, 800);
  },

  showTicketSuccess(ticketId) {
    document.getElementById('success-ticket-id').textContent = ticketId;
    document.getElementById('ticket-modal').classList.add('open');
    document.getElementById('ticket-modal-close').onclick = () => {
      document.getElementById('ticket-modal').classList.remove('open');
    };
  },

  resetForm() {
    document.getElementById('report-form')?.reset();
    const locDisplay = document.getElementById('location-display');
    if (locDisplay) locDisplay.innerHTML = 'Not set — use GPS or tap map below';
    document.getElementById('location-display').classList.remove('has-location', 'set');
    const preview = document.getElementById('photo-preview');
    if (preview) preview.style.display = 'none';
    this.selectedLat = null;
    this.selectedLng = null;
    this.selectedPhoto = null;
    this._lastAICheck = null;
    const aiBox = document.getElementById('ai-check-box');
    if (aiBox) { aiBox.style.display = 'none'; aiBox.innerHTML = ''; }
    this.selectedSeverity = 'medium';
    document.querySelectorAll('.severity-option').forEach(o => o.classList.remove('selected'));
    document.querySelector('.severity-option[data-sev="medium"]')?.classList.add('selected');
    const captcha = document.getElementById('captcha-check');
    if (captcha) captcha.checked = false;
    if (this._tempMarker) { this.map.removeLayer(this._tempMarker); this._tempMarker = null; }
  },

  /* ── Feed ─────────────────────────────────────────────────── */
  renderFeed() {
    let reports = Storage.getAllReports();

    // Filter
    if (this.currentFilter !== 'all') {
      reports = reports.filter(r => r.status === this.currentFilter);
    }

    // Sort by recency (newest first)
    reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const container = document.getElementById('feed-list');
    const countEl = document.getElementById('feed-count');
    if (countEl) countEl.textContent = reports.length;

    if (!container) return;

    if (reports.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📋</div>
          <div class="empty-state-text">
            <strong>No complaints registered yet.</strong><br>
            Click <em>"📍 Report a Pothole"</em> above to submit the first complaint.<br>
            <small style="color:var(--gov-blue-mid);margin-top:6px;display:block;">All submitted reports will appear here with their status.</small>
          </div>
        </div>`;
      return;
    }

    container.innerHTML = reports.map(r => this.buildCardHtml(r)).join('');

    // Bind upvote buttons
    container.querySelectorAll('.card-upvote-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        this.upvoteCard(btn.dataset.id);
      });
    });

    // Card click → fly to marker
    container.querySelectorAll('.report-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = card.dataset.id;
        const report = Storage.getReport(id);
        if (report && this.markers[id]) {
          this.map.setView([report.lat, report.lng], 16, { animate: true, duration: 0.6 });
          setTimeout(() => this.markers[id].openPopup(), 700);
        }
      });
    });
  },

  buildCardHtml(report) {
    const voted = Storage.hasUserUpvoted(report.id);
    const escInfo = Escalation.formatBadge(report);
    const age = Escalation.formatAge(report);

    return `
      <div class="report-card status-${report.status}" data-id="${report.id}" id="card-${report.id}">
        <div class="card-header">
          <span class="card-ticket">${Security.sanitizeHTML(report.id)}</span>
          ${escInfo.show ? `<span class="card-escalated-tag">ESCALATED</span>` : ''}
          <span class="card-badge ${report.status}">${this.statusLabel(report.status)}</span>
        </div>
        <div class="card-desc">${Security.sanitizeHTML(report.description)}</div>
        <div class="card-meta">
          <span class="card-sev ${report.severity}">${Security.sanitizeHTML(report.severity.toUpperCase())}</span>
          <span>📍 ${Security.sanitizeHTML(report.address)}</span>
          <button class="card-upvote ${voted ? 'voted' : ''} card-upvote-btn" data-id="${report.id}">
            ${voted ? '✅ Voted' : '👍 Upvote'} ${report.upvotes}
          </button>
        </div>
      </div>`;
  },

  statusLabel(status) {
    const labels = { pending: 'Pending', scheduled: 'Scheduled', 'in-progress': 'In Progress', resolved: 'Resolved' };
    return labels[status] || status;
  },

  upvoteCard(id) {
    const result = Storage.upvoteReport(id);
    if (!result) return;
    if (result.alreadyVoted) { Toast.show('You already upvoted this!', 'warning', 2000); return; }
    Toast.show(`👍 Upvoted! (${result.report.upvotes} total)`, 'success', 2000);
    this.renderFeed();
    if (this.markers[id]) {
      this.markers[id].setPopupContent(this.buildPopupHtml(result.report));
    }
  },

  scrollToCard(id) {
    const card = document.getElementById(`card-${id}`);
    if (card) {
      document.querySelector('.panel-tab[data-tab="feed"]')?.click();
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid var(--gov-blue)';
      setTimeout(() => card.style.outline = '', 2000);
    }
  },

  /* ── Gallery ──────────────────────────────────────────────── */
  renderGallery() {
    const resolved = Storage.getAllReports().filter(r => r.status === 'resolved');
    const container = document.getElementById('gallery-grid');
    if (!container) return;

    if (resolved.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="grid-column:1/-1">
          <div class="empty-state-icon">🎉</div>
          <div class="empty-state-text">No resolved reports yet.<br>Fixed potholes will appear here!</div>
        </div>`;
      return;
    }

    container.innerHTML = resolved.map(r => `
      <div class="gallery-card">
        <div class="gallery-before-after">
          <div class="gallery-img-slot">
            ${r.photo ? `<img src="${r.photo}" alt="Before" />` : '<span style="font-size:24px;opacity:0.3">📷</span>'}
          </div>
          <div class="gallery-img-slot">
            ${r.afterPhoto ? `<img src="${r.afterPhoto}" alt="After" />` : '<span style="font-size:24px;opacity:0.3">✅</span>'}
          </div>
          <div class="gallery-divider">→</div>
        </div>
        <div class="gallery-info">
          <div class="gallery-ticket">${Security.sanitizeHTML(r.id)}</div>
          <div class="gallery-addr">📍 ${Security.sanitizeHTML(r.address)}</div>
          <div class="gallery-resolved-date">✅ ${Escalation.formatAge({ ...r, createdAt: r.updatedAt })}</div>
        </div>
      </div>`).join('');
  },

  /* ── Stats ────────────────────────────────────────────────── */
  updateStats() {
    const stats = Storage.getStats();
    const el = id => document.getElementById(id);
    if (el('stat-pending'))  el('stat-pending').textContent  = stats.pending;
    if (el('stat-progress')) el('stat-progress').textContent = stats.inProgress;
    if (el('stat-resolved')) el('stat-resolved').textContent = stats.resolved;
  },

  /* ── Notifications ────────────────────────────────────────── */
  initNotifications() {
    this.updateNotifBadge();
    Storage.fetchNotifications(this.userId).then(() => {
      this.updateNotifBadge();
      this.renderNotifications();
    });
    if (typeof CloudSync !== 'undefined' && CloudSync.isEnabled()) {
      CloudSync.initNotifications(this.userId);
    }
    window.addEventListener('cloud-notifications-updated', () => {
      this.updateNotifBadge();
      if (document.getElementById('notif-panel')?.classList.contains('open')) {
        this.renderNotifications();
      }
    });
  },

  updateNotifBadge() {
    const count = Storage.getUnreadCount(this.userId);
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    badge.textContent = count;
    badge.style.display = count > 0 ? 'flex' : 'none';
  },

  renderNotifications() {
    const notifications = Storage.getNotifications(this.userId);
    const container = document.getElementById('notif-list');
    if (!container) return;

    if (notifications.length === 0) {
      container.innerHTML = '<div class="notif-empty">🔔 No notifications yet</div>';
      return;
    }

    container.innerHTML = notifications.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}">
        ${n.message}
        <div class="notif-item-time">${new Date(n.createdAt).toLocaleDateString()}</div>
      </div>`).join('');
  }
};

/* ── Boot ─────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => App.init());
