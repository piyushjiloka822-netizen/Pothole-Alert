/**
 * Security Module — Pothole Reporting Application
 * XSS protection, input validation, rate limiting, image compression,
 * session management, and login throttling.
 */

const Security = {

  /* ═══════════════════════════════════════════════════════════════
     1. XSS Protection
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Sanitize a string for safe HTML insertion.
   * Converts special chars to HTML entities to prevent XSS.
   */
  sanitizeHTML(str) {
    if (typeof str !== 'string') return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  /**
   * Strip all HTML tags from a string (returns plain text).
   */
  stripTags(str) {
    if (typeof str !== 'string') return '';
    return str.replace(/<[^>]*>/g, '');
  },

  /* ═══════════════════════════════════════════════════════════════
     2. Input Validation
     ═══════════════════════════════════════════════════════════════ */

  RULES: {
    description: { maxLength: 500, label: 'Description' },
    reporterName: { maxLength: 100, label: 'Reporter name', pattern: /^[a-zA-Z0-9\s\.\-']+$/ },
    address: { maxLength: 200, label: 'Address' },
    crew: { maxLength: 100, label: 'Crew name', pattern: /^[a-zA-Z0-9\s\.\-'#]+$/ },
  },

  // India geographic bounds (approximate)
  INDIA_BOUNDS: {
    latMin: 6.0, latMax: 37.5,
    lngMin: 68.0, lngMax: 97.5,
  },

  MAX_PHOTO_SIZE_MB: 5,

  /**
   * Validate a text field against defined rules.
   * Returns { valid: true } or { valid: false, message: '...' }
   */
  validateField(fieldName, value) {
    const rule = this.RULES[fieldName];
    if (!rule) return { valid: true };

    const cleaned = this.stripTags(String(value || '').trim());

    if (cleaned.length === 0) {
      return { valid: false, message: `${rule.label} is required.` };
    }

    if (cleaned.length > rule.maxLength) {
      return { valid: false, message: `${rule.label} must be under ${rule.maxLength} characters (currently ${cleaned.length}).` };
    }

    if (rule.pattern && !rule.pattern.test(cleaned)) {
      return { valid: false, message: `${rule.label} contains invalid characters.` };
    }

    return { valid: true, cleaned };
  },

  /**
   * Validate latitude/longitude against India bounds.
   */
  validateCoordinates(lat, lng) {
    const b = this.INDIA_BOUNDS;
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return { valid: false, message: 'Invalid coordinates.' };
    }
    if (lat < b.latMin || lat > b.latMax || lng < b.lngMin || lng > b.lngMax) {
      return { valid: false, message: 'Coordinates are outside India boundaries.' };
    }
    return { valid: true };
  },

  /**
   * Validate a photo file (type and size).
   */
  validatePhoto(file) {
    if (!file) return { valid: true }; // optional

    const validTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!validTypes.includes(file.type)) {
      return { valid: false, message: 'Please upload a valid image (JPEG, PNG, WebP, or GIF).' };
    }

    const sizeMB = file.size / (1024 * 1024);
    if (sizeMB > this.MAX_PHOTO_SIZE_MB) {
      return { valid: false, message: `Photo must be under ${this.MAX_PHOTO_SIZE_MB} MB (yours: ${sizeMB.toFixed(1)} MB).` };
    }

    return { valid: true };
  },

  /* ═══════════════════════════════════════════════════════════════
     3. Rate Limiting
     ═══════════════════════════════════════════════════════════════ */

  RATE_LIMIT_KEY: 'pothole_rate_limit',
  MAX_REPORTS_PER_HOUR: 3,

  /**
   * Check if a user can submit a new report.
   * Returns { allowed: true, remaining: N } or { allowed: false, retryAfterMs: N }
   */
  canSubmitReport(userId) {
    const key = `${this.RATE_LIMIT_KEY}_${userId}`;
    const oneHourAgo = Date.now() - 3600000;

    try {
      let timestamps = JSON.parse(localStorage.getItem(key) || '[]');
      timestamps = timestamps.filter(t => t > oneHourAgo);

      if (timestamps.length >= this.MAX_REPORTS_PER_HOUR) {
        const oldest = Math.min(...timestamps);
        const retryAfterMs = oldest + 3600000 - Date.now();
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs,
          message: `Rate limit reached (${this.MAX_REPORTS_PER_HOUR}/hour). Try again in ${Math.ceil(retryAfterMs / 60000)} minute(s).`
        };
      }

      return { allowed: true, remaining: this.MAX_REPORTS_PER_HOUR - timestamps.length };
    } catch {
      return { allowed: true, remaining: this.MAX_REPORTS_PER_HOUR };
    }
  },

  /**
   * Record a successful submission for rate-limit tracking.
   */
  recordSubmission(userId) {
    const key = `${this.RATE_LIMIT_KEY}_${userId}`;
    const oneHourAgo = Date.now() - 3600000;
    try {
      let timestamps = JSON.parse(localStorage.getItem(key) || '[]');
      timestamps = timestamps.filter(t => t > oneHourAgo);
      timestamps.push(Date.now());
      localStorage.setItem(key, JSON.stringify(timestamps));
    } catch {}
  },

  /* ═══════════════════════════════════════════════════════════════
     4. Image Compression
     ═══════════════════════════════════════════════════════════════ */

  /**
   * Compress a base64 image to reduce storage usage.
   * @param {string} dataUrl - The base64 data URL
   * @param {number} maxWidth - Max width in pixels (default 800)
   * @param {number} quality - JPEG quality 0-1 (default 0.6)
   * @returns {Promise<string>} Compressed base64 data URL
   */
  compressImage(dataUrl, maxWidth = 800, quality = 0.6) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          const ratio = Math.min(maxWidth / img.width, 1);
          canvas.width = Math.round(img.width * ratio);
          canvas.height = Math.round(img.height * ratio);
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          const compressed = canvas.toDataURL('image/jpeg', quality);
          resolve(compressed);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error('Failed to load image for compression'));
      img.src = dataUrl;
    });
  },

  /**
   * Get approximate localStorage usage in bytes and percentage.
   */
  getStorageUsage() {
    let totalBytes = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        totalBytes += (key.length + (localStorage.getItem(key) || '').length) * 2; // UTF-16
      }
    } catch {}
    const maxBytes = 5 * 1024 * 1024; // 5 MB typical limit
    return {
      usedBytes: totalBytes,
      usedMB: (totalBytes / (1024 * 1024)).toFixed(2),
      maxMB: 5,
      percentage: Math.round((totalBytes / maxBytes) * 100),
    };
  },

  /* ═══════════════════════════════════════════════════════════════
     5. Admin Password Hashing (SHA-256)
     ═══════════════════════════════════════════════════════════════ */

  // SHA-256 hash of 'admin123'
  ADMIN_PASSWORD_HASH: '240be518fabd2724ddb6f04eeb1da5967448d7e831c08c8fa822809f74c720a9',

  /**
   * Hash a string using SHA-256.
   * @returns {Promise<string>} Hex-encoded hash
   */
  async hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  },

  /**
   * Verify admin password against stored hash.
   * @returns {Promise<boolean>}
   */
  async verifyAdminPassword(password) {
    const hash = await this.hashPassword(password);
    return hash === this.ADMIN_PASSWORD_HASH;
  },

  /* ═══════════════════════════════════════════════════════════════
     6. Session Management
     ═══════════════════════════════════════════════════════════════ */

  SESSION_KEY: 'pothole_admin_session',
  SESSION_TIMEOUT_MS: 30 * 60 * 1000, // 30 minutes

  /**
   * Create an admin session token.
   */
  createAdminSession() {
    const session = {
      token: 'sess_' + crypto.randomUUID(),
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
    localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
    return session;
  },

  /**
   * Check if current admin session is valid.
   * Also updates lastActivity timestamp.
   */
  isAdminSessionValid() {
    try {
      const session = JSON.parse(localStorage.getItem(this.SESSION_KEY));
      if (!session || !session.token) return false;
      if (Date.now() - session.lastActivity > this.SESSION_TIMEOUT_MS) {
        this.destroyAdminSession();
        return false;
      }
      // Refresh activity timestamp
      session.lastActivity = Date.now();
      localStorage.setItem(this.SESSION_KEY, JSON.stringify(session));
      return true;
    } catch {
      return false;
    }
  },

  /**
   * Destroy the admin session (logout).
   */
  destroyAdminSession() {
    localStorage.removeItem(this.SESSION_KEY);
  },

  /**
   * Get remaining session time in minutes.
   */
  getSessionTimeRemaining() {
    try {
      const session = JSON.parse(localStorage.getItem(this.SESSION_KEY));
      if (!session) return 0;
      const remaining = this.SESSION_TIMEOUT_MS - (Date.now() - session.lastActivity);
      return Math.max(0, Math.ceil(remaining / 60000));
    } catch {
      return 0;
    }
  },

  /* ═══════════════════════════════════════════════════════════════
     7. Login Attempt Throttling
     ═══════════════════════════════════════════════════════════════ */

  LOGIN_ATTEMPTS_KEY: 'pothole_login_attempts',
  MAX_LOGIN_ATTEMPTS: 5,
  LOCKOUT_DURATION_MS: 15 * 60 * 1000, // 15 minutes

  /**
   * Check if login attempts are allowed.
   * Returns { allowed, attemptsLeft, lockoutRemainingMs }
   */
  checkLoginAllowed() {
    try {
      const data = JSON.parse(localStorage.getItem(this.LOGIN_ATTEMPTS_KEY) || '{}');

      // Check if currently locked out
      if (data.lockedUntil && Date.now() < data.lockedUntil) {
        const remainingMs = data.lockedUntil - Date.now();
        return {
          allowed: false,
          attemptsLeft: 0,
          lockoutRemainingMs: remainingMs,
          message: `Account locked. Try again in ${Math.ceil(remainingMs / 60000)} minute(s).`
        };
      }

      // Reset if lockout has expired
      if (data.lockedUntil && Date.now() >= data.lockedUntil) {
        localStorage.removeItem(this.LOGIN_ATTEMPTS_KEY);
        return { allowed: true, attemptsLeft: this.MAX_LOGIN_ATTEMPTS };
      }

      const attempts = data.attempts || 0;
      return {
        allowed: attempts < this.MAX_LOGIN_ATTEMPTS,
        attemptsLeft: this.MAX_LOGIN_ATTEMPTS - attempts,
      };
    } catch {
      return { allowed: true, attemptsLeft: this.MAX_LOGIN_ATTEMPTS };
    }
  },

  /**
   * Record a failed login attempt.
   */
  recordFailedLogin() {
    try {
      const data = JSON.parse(localStorage.getItem(this.LOGIN_ATTEMPTS_KEY) || '{}');
      data.attempts = (data.attempts || 0) + 1;
      data.lastAttempt = Date.now();

      if (data.attempts >= this.MAX_LOGIN_ATTEMPTS) {
        data.lockedUntil = Date.now() + this.LOCKOUT_DURATION_MS;
      }

      localStorage.setItem(this.LOGIN_ATTEMPTS_KEY, JSON.stringify(data));
      return {
        attemptsLeft: Math.max(0, this.MAX_LOGIN_ATTEMPTS - data.attempts),
        locked: data.attempts >= this.MAX_LOGIN_ATTEMPTS,
      };
    } catch {
      return { attemptsLeft: 0, locked: false };
    }
  },

  /**
   * Clear login attempts (after successful login).
   */
  clearLoginAttempts() {
    localStorage.removeItem(this.LOGIN_ATTEMPTS_KEY);
  },
};
