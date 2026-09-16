/**
 * Camera Module — Pothole Reporting Application
 * Live in-app camera capture (getUserMedia) so a report photo can be a
 * fresh, on-the-spot shot rather than any file picked from the gallery.
 * Falls back gracefully wherever the camera API/permission isn't available.
 */

const Camera = {
  _stream: null,
  _onCapture: null,

  isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  },

  /**
   * Ensure the camera modal DOM exists (injected once, reused after).
   */
  _ensureModal() {
    if (document.getElementById('camera-modal-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'camera-modal-overlay';
    overlay.className = 'camera-modal-overlay';
    overlay.innerHTML = `
      <div class="camera-modal">
        <div class="camera-modal-header">
          <span>📸 Capture Pothole Photo</span>
          <button type="button" class="camera-close-btn" id="camera-close-btn" aria-label="Close camera">✕</button>
        </div>
        <div class="camera-viewport">
          <video id="camera-video" autoplay playsinline muted></video>
          <div class="camera-error" id="camera-error" style="display:none"></div>
        </div>
        <canvas id="camera-canvas" style="display:none"></canvas>
        <div class="camera-modal-actions">
          <button type="button" class="btn-modal btn-modal-secondary" id="camera-cancel-btn">Cancel</button>
          <button type="button" class="btn-modal btn-modal-primary" id="camera-shutter-btn">⚪ Capture</button>
          <button type="button" class="btn-modal btn-modal-secondary" id="camera-switch-btn" title="Switch camera">🔄</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById('camera-close-btn').addEventListener('click', () => this.close());
    document.getElementById('camera-cancel-btn').addEventListener('click', () => this.close());
    document.getElementById('camera-shutter-btn').addEventListener('click', () => this._capture());
    document.getElementById('camera-switch-btn').addEventListener('click', () => this._switchFacing());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });
  },

  _facingMode: 'environment',

  async _switchFacing() {
    this._facingMode = this._facingMode === 'environment' ? 'user' : 'environment';
    await this._startStream();
  },

  async _startStream() {
    const video = document.getElementById('camera-video');
    const errorBox = document.getElementById('camera-error');
    this._stopStream();
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: this._facingMode, width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false
      });
      video.srcObject = this._stream;
      video.style.display = 'block';
      errorBox.style.display = 'none';
    } catch (err) {
      video.style.display = 'none';
      errorBox.style.display = 'flex';
      errorBox.textContent = err.name === 'NotAllowedError'
        ? '🚫 Camera permission denied. Allow camera access, or use "Upload from device" instead.'
        : '⚠️ Could not access camera on this device. Use "Upload from device" instead.';
    }
  },

  _stopStream() {
    if (this._stream) {
      this._stream.getTracks().forEach(t => t.stop());
      this._stream = null;
    }
  },

  /**
   * Open the camera modal. onCapture receives a JPEG data-URL string.
   */
  async open(onCapture) {
    if (!this.isSupported()) {
      if (typeof Toast !== 'undefined') {
        Toast.show('📵 Live camera isn\'t supported on this browser/device — please upload a photo instead.', 'warning');
      }
      return;
    }
    this._onCapture = onCapture;
    this._ensureModal();
    document.getElementById('camera-modal-overlay').classList.add('open');
    await this._startStream();
  },

  close() {
    this._stopStream();
    const overlay = document.getElementById('camera-modal-overlay');
    if (overlay) overlay.classList.remove('open');
  },

  _capture() {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    if (!video || !video.videoWidth) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

    if (typeof this._onCapture === 'function') this._onCapture(dataUrl);
    this.close();
  }
};
