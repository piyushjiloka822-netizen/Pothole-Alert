/**
 * POST /api/verify-pothole
 *
 * Optional server-side AI check for a submitted photo, using Google's
 * Gemini vision model. This is a Vercel Serverless Function — it deploys
 * automatically because it lives in /api, no extra config needed.
 *
 * Requires a GEMINI_API_KEY environment variable set in the Vercel
 * project (Project → Settings → Environment Variables) — NEVER commit
 * the key itself into this file or into git. Without it configured, this
 * endpoint responds { configured: false } and the frontend silently
 * falls back to client-side heuristic checks only (js/ai-verify.js) —
 * nothing breaks either way.
 *
 * Body:  { "image": "data:image/jpeg;base64,...." }
 * Reply: { configured: true, isPothole: boolean, confidence: 0..1, reason: string }
 */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ configured: false, error: 'Method not allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    // Not set up yet — frontend treats this as "AI tier unavailable".
    return res.status(200).json({ configured: false });
  }

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string' || !image.startsWith('data:image')) {
      return res.status(400).json({ configured: true, error: 'Missing or invalid image data URL' });
    }

    // Guard against oversized payloads (frontend already compresses images).
    if (image.length > 3_000_000) {
      return res.status(413).json({ configured: true, error: 'Image too large' });
    }

    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ configured: true, error: 'Malformed image data URL' });
    }
    const [, mimeType, base64Data] = match;

    const prompt = `You are reviewing a photo submitted through a municipal pothole-reporting app. Decide whether the photo genuinely shows a pothole, a crack, or other road-surface damage (as opposed to an unrelated, blank, or irrelevant photo). Reply with ONLY a compact JSON object, no markdown fences, in this exact shape:
{"isPothole": true|false, "confidence": 0.0-1.0, "reason": "one short sentence"}`;

    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: mimeType, data: base64Data } }
          ]
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 150 }
      })
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('verify-pothole: Gemini error', response.status, errText);
      return res.status(200).json({ configured: true, isPothole: null, confidence: null, reason: 'AI check temporarily unavailable.' });
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';

    let parsed;
    try {
      // Strip accidental markdown fences just in case.
      const cleaned = raw.replace(/```json|```/g, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { isPothole: null, confidence: null, reason: 'Could not parse AI response.' };
    }

    return res.status(200).json({
      configured: true,
      isPothole: parsed.isPothole,
      confidence: parsed.confidence,
      reason: parsed.reason || ''
    });
  } catch (err) {
    console.error('verify-pothole: unexpected error', err);
    return res.status(200).json({ configured: true, isPothole: null, confidence: null, reason: 'AI check failed unexpectedly.' });
  }
};
