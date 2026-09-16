/**
 * AI Verify Module — Pothole Reporting Application
 *
 * Two tiers of photo verification, both non-blocking (they inform the
 * citizen and the reviewing officer, they never silently reject a report
 * a person genuinely wants to file):
 *
 *  1. Instant client-side heuristics (always runs, no network, no cost):
 *     brightness, blur/flatness, and color-variance checks that catch the
 *     obvious junk cases — a blank/black photo, an accidental screenshot
 *     of a single-color surface, an extremely over/under-exposed shot.
 *
 *  2. Optional server-side AI check via /api/verify-pothole (a Vercel
 *     serverless function). If the site owner has configured an
 *     OPENAI_API_KEY (see .env.example), this asks a vision model whether
 *     the photo actually shows a pothole/road damage, and returns a
 *     confidence + short reason. If the endpoint isn't deployed/configured
 *     (e.g. running the static files with no serverless backend), this
 *     tier is skipped silently and only tier 1 is shown.
 */

const AIVerify = {
  ENDPOINT: '/api/verify-pothole',
  TIMEOUT_MS: 9000,

  /* ── Tier 1: client-side heuristics ─────────────────────────── */
  async runHeuristics(dataUrl) {
    const img = await this._loadImage(dataUrl);
    const w = 160, h = Math.round((img.height / img.width) * 160) || 120;

    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    let pixels;
    try {
      pixels = ctx.getImageData(0, 0, w, h).data;
    } catch {
      // Canvas got tainted (cross-origin) or another read error — skip heuristics.
      return { level: 'unknown', messages: [], brightness: null, sharpness: null, variance: null };
    }

    // Grayscale luminance array
    const gray = new Float32Array(w * h);
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      gray[p] = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
    }

    // Brightness
    let sum = 0;
    for (let i = 0; i < gray.length; i++) sum += gray[i];
    const brightness = sum / gray.length;

    // Variance (flat/solid-color images have ~0 variance)
    let sqDiff = 0;
    for (let i = 0; i < gray.length; i++) sqDiff += (gray[i] - brightness) ** 2;
    const variance = sqDiff / gray.length;

    // Sharpness proxy — average absolute gradient between adjacent pixels
    let gradSum = 0, gradCount = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w - 1; x++) {
        const idx = y * w + x;
        gradSum += Math.abs(gray[idx] - gray[idx + 1]);
        gradCount++;
      }
    }
    const sharpness = gradSum / gradCount;

    const messages = [];
    let level = 'ok';

    if (brightness < 28) {
      messages.push('Photo looks very dark — try again in better light so the pothole is visible.');
      level = 'warning';
    } else if (brightness > 235) {
      messages.push('Photo looks washed out / overexposed.');
      level = 'warning';
    }

    if (variance < 12) {
      messages.push('Photo looks like a flat, near solid-color image rather than a road surface.');
      level = 'warning';
    }

    if (sharpness < 2.2) {
      messages.push('Photo looks blurry or out of focus — a sharper shot helps engineers assess severity.');
      level = 'warning';
    }

    return { level, messages, brightness: Math.round(brightness), sharpness: +sharpness.toFixed(2), variance: Math.round(variance) };
  },

  _loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  },

  /* ── Tier 2: optional server-side AI vision check ───────────── */
  async runServerCheck(dataUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    try {
      const res = await fetch(this.ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl }),
        signal: controller.signal
      });
      clearTimeout(timer);

      if (!res.ok) return { available: false };
      const data = await res.json();
      if (!data || data.configured === false) return { available: false };

      return {
        available: true,
        isPothole: !!data.isPothole,
        confidence: typeof data.confidence === 'number' ? data.confidence : null,
        depth: data.depth || null,
        severity: data.severity || null,
        reason: data.reason || ''
      };
    } catch {
      clearTimeout(timer);
      // Endpoint missing (plain static hosting), offline, or timed out — silently skip.
      return { available: false };
    }
  },

  /**
   * Run both tiers and return a combined, UI-ready result.
   */
  async analyze(dataUrl) {
    const heuristics = await this.runHeuristics(dataUrl).catch(() => ({ level: 'unknown', messages: [] }));
    const server = await this.runServerCheck(dataUrl);

    return { heuristics, server };
  },

  /**
   * Render the result into a target container element.
   */
  renderResult(container, result) {
    if (!container) return;
    const { heuristics, server } = result;
    const parts = [];

    if (server && server.available) {
      const pct = server.confidence !== null ? Math.round(server.confidence * 100) : null;
      if (server.isPothole) {
        parts.push(`<div class="ai-check-row ai-check-ok">🤖 AI check: likely genuine road damage${pct !== null ? ` (${pct}% confidence)` : ''}</div>`);
      } else {
        parts.push(`<div class="ai-check-row ai-check-warn">🤖 AI check: this photo may not show a pothole${pct !== null ? ` (${pct}% confidence)` : ''} — you can still submit, but please double-check the photo.</div>`);
      }
      if (server.reason) parts.push(`<div class="ai-check-reason">"${Security.sanitizeHTML(server.reason)}"</div>`);
    }

    if (heuristics && heuristics.messages && heuristics.messages.length) {
      heuristics.messages.forEach(m => parts.push(`<div class="ai-check-row ai-check-warn">⚠️ ${Security.sanitizeHTML(m)}</div>`));
    } else if (!server || !server.available) {
      parts.push(`<div class="ai-check-row ai-check-ok">✅ Photo passed basic quality checks.</div>`);
    }

    container.innerHTML = parts.join('');
    container.style.display = parts.length ? 'block' : 'none';
  }
};
