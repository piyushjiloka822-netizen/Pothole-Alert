/**
 * Server.js — Pothole Management System Backend
 * Express.js server with REST API, SSE push, and Gemini AI integration.
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const DB = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Serve static files from repo root
app.use(express.static(__dirname));

// File upload for worker photos
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// Initialize database
DB.getDb();

/* ══════════════════════════════════════════════════════════════
   SSE — Server-Sent Events for real-time push
══════════════════════════════════════════════════════════════ */

const sseClients = new Set();

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  res.write(`event: connected\ndata: {"message":"Connected to SSE"}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Heartbeat every 30s
  const heartbeat = setInterval(() => {
    res.write(`event: heartbeat\ndata: {"time":"${new Date().toISOString()}"}\n\n`);
  }, 30000);
  req.on('close', () => clearInterval(heartbeat));
});

/* ══════════════════════════════════════════════════════════════
   REPORTS API
══════════════════════════════════════════════════════════════ */

// Get all reports (with optional filters)
app.get('/api/reports', (req, res) => {
  try {
    const reports = DB.getAllReports(req.query);
    res.json(reports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single report
app.get('/api/reports/:id', (req, res) => {
  try {
    const report = DB.getReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a new report (citizen submits complaint)
app.post('/api/reports', async (req, res) => {
  try {
    const data = req.body;

    if (!data.lat || !data.lng) {
      return res.status(400).json({ error: 'Location (lat/lng) is required' });
    }

    const report = DB.createReport(data);

    // Notify admin via SSE
    broadcastSSE('new_report', {
      id: report.id,
      address: report.address,
      severity: report.severity,
      lat: report.lat,
      lng: report.lng,
      createdAt: report.createdAt
    });

    // Audit log
    DB.logAudit('report_submitted', report.id, {
      severity: report.severity,
      zone: report.zone,
      reporterName: report.reporterName
    }, 'citizen');

    // Notification for reporter
    if (data.reporterId) {
      DB.addNotification(data.reporterId,
        `✅ Your complaint ${report.id} has been submitted successfully. We'll update you on progress.`,
        'success', report.id);
    }

    res.status(201).json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update a report (admin changes status, assigns worker, etc.)
app.put('/api/reports/:id', (req, res) => {
  try {
    const id = req.params.id;
    const oldReport = DB.getReport(id);
    if (!oldReport) return res.status(404).json({ error: 'Report not found' });

    const updates = req.body;
    const report = DB.updateReport(id, updates);

    // If worker assigned, update worker status
    if (updates.assignedWorkerId) {
      DB.updateWorker(updates.assignedWorkerId, {
        status: 'busy',
        currentAssignment: id
      });
    }

    // Notify citizen on status change
    if (updates.status && updates.status !== oldReport.status && oldReport.reporterId) {
      const statusMessages = {
        pending: `📝 Your report ${id} is pending officer review.`,
        scheduled: `📅 Your report ${id} has been scheduled for repair!`,
        'in-progress': `🚧 A repair crew has been assigned to your report ${id} and work is in progress!`,
        resolved: `✅ Great news! Your report ${id} has been resolved. The pothole has been repaired.`
      };
      if (statusMessages[updates.status]) {
        DB.addNotification(oldReport.reporterId, statusMessages[updates.status],
          updates.status === 'resolved' ? 'success' : 'info', id);
      }
    }

    // If worker name assigned, notify
    if (updates.assignedWorkerName && oldReport.reporterId) {
      DB.addNotification(oldReport.reporterId,
        `👷 Worker "${updates.assignedWorkerName}" has been assigned to repair pothole ${id}.`,
        'info', id);
    }

    // Broadcast update via SSE
    broadcastSSE('report_updated', {
      id: report.id,
      status: report.status,
      assignedWorkerName: report.assignedWorkerName,
      resources: report.resources,
      updatedAt: report.updatedAt
    });

    // Audit log
    DB.logAudit('report_updated', id, {
      oldStatus: oldReport.status,
      newStatus: updates.status || oldReport.status,
      assignedWorker: updates.assignedWorkerName || null,
      resources: updates.resources || null,
    });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Resolve a report (admin marks as resolved after verification)
app.put('/api/reports/:id/resolve', (req, res) => {
  try {
    const id = req.params.id;
    const oldReport = DB.getReport(id);
    if (!oldReport) return res.status(404).json({ error: 'Report not found' });

    const updates = {
      status: 'resolved',
      afterPhoto: req.body.afterPhoto || null
    };
    const report = DB.updateReport(id, updates);

    // Free up the worker
    if (oldReport.assignedWorkerId) {
      DB.updateWorker(oldReport.assignedWorkerId, {
        status: 'available',
        currentAssignment: '',
        completedJobs: (DB.getWorker(oldReport.assignedWorkerId)?.completedJobs || 0) + 1
      });
    }

    // Notify citizen
    if (oldReport.reporterId) {
      DB.addNotification(oldReport.reporterId,
        `✅ Great news! Your report ${id} has been verified and marked as RESOLVED. Thank you for your contribution to better roads!`,
        'success', id);
    }

    // SSE
    broadcastSSE('report_resolved', { id, status: 'resolved', updatedAt: report.updatedAt });

    // Audit
    DB.logAudit('report_resolved', id, { hadAfterPhoto: !!req.body.afterPhoto });

    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Worker uploads repair photo
app.post('/api/reports/:id/worker-photo', (req, res) => {
  try {
    const id = req.params.id;
    const report = DB.getReport(id);
    if (!report) return res.status(404).json({ error: 'Report not found' });

    const updates = {
      workerPhoto: req.body.photo,
      workerPhotoUploadedAt: new Date().toISOString()
    };
    const updated = DB.updateReport(id, updates);

    // SSE — notify admin that worker uploaded photo
    broadcastSSE('worker_photo_uploaded', {
      id, workerPhotoUploadedAt: updates.workerPhotoUploadedAt
    });

    // Audit
    DB.logAudit('worker_photo_uploaded', id, { workerId: report.assignedWorkerId });

    if (report.reporterId) {
      DB.addNotification(report.reporterId,
        `📸 Repair photo uploaded for ${id}. An officer will verify the work before closing the complaint.`,
        'info', id);
    }

    broadcastSSE('report_updated', {
      id: updated.id,
      status: updated.status,
      workerPhotoUploadedAt: updated.workerPhotoUploadedAt,
      updatedAt: updated.updatedAt
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Upvote a report
app.post('/api/reports/:id/upvote', (req, res) => {
  try {
    const userId = req.body.userId || 'anonymous';
    const result = DB.upvoteReport(req.params.id, userId);
    if (!result) return res.status(404).json({ error: 'Report not found' });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   WORKERS API
══════════════════════════════════════════════════════════════ */

app.get('/api/workers', (req, res) => {
  try {
    res.json(DB.getAllWorkers());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/workers', (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ error: 'Worker name is required' });
    const worker = DB.createWorker(req.body);
    DB.logAudit('worker_created', '', { workerId: worker.id, name: worker.name });
    res.status(201).json(worker);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/workers/:id', (req, res) => {
  try {
    const worker = DB.updateWorker(req.params.id, req.body);
    if (!worker) return res.status(404).json({ error: 'Worker not found' });
    res.json(worker);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workers/:id', (req, res) => {
  try {
    DB.deleteWorker(req.params.id);
    DB.logAudit('worker_deleted', '', { workerId: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   NOTIFICATIONS API
══════════════════════════════════════════════════════════════ */

app.get('/api/notifications/:userId', (req, res) => {
  try {
    const notifications = DB.getNotifications(req.params.userId);
    const unread = DB.getUnreadCount(req.params.userId);
    res.json({ notifications, unread });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/notifications/:userId/read', (req, res) => {
  try {
    DB.markNotificationsRead(req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   STATS & ANALYTICS API
══════════════════════════════════════════════════════════════ */

app.get('/api/stats', (req, res) => {
  try {
    res.json(DB.getStats());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analytics', (req, res) => {
  try {
    res.json(DB.getAnalytics());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/audit', (req, res) => {
  try {
    res.json(DB.getAuditLog(200));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ══════════════════════════════════════════════════════════════
   AI POTHOLE VERIFICATION (Gemini Vision)
══════════════════════════════════════════════════════════════ */

app.post('/api/verify-pothole', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.json({ configured: false });
  }

  try {
    const { image } = req.body || {};
    if (!image || typeof image !== 'string' || !image.startsWith('data:image')) {
      return res.status(400).json({ configured: true, error: 'Missing or invalid image' });
    }

    if (image.length > 3_000_000) {
      return res.status(413).json({ configured: true, error: 'Image too large' });
    }

    const match = image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ configured: true, error: 'Malformed image data URL' });
    }
    const [, mimeType, base64Data] = match;

    const prompt = `You are reviewing a photo submitted through a municipal pothole-reporting app. Decide whether the photo genuinely shows a pothole, a crack, or other road-surface damage (as opposed to an unrelated, blank, or irrelevant photo). Also estimate the depth (shallow/medium/deep) and severity (low/medium/high/critical). Reply with ONLY a compact JSON object, no markdown fences:\n{"isPothole": true|false, "confidence": 0.0-1.0, "depth": "shallow|medium|deep", "severity": "low|medium|high|critical", "reason": "one short sentence"}`;

    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64Data } }
        ]}],
        generationConfig: { temperature: 0, maxOutputTokens: 200 }
      })
    });

    if (!response.ok) {
      return res.json({ configured: true, isPothole: null, confidence: null, reason: 'AI check temporarily unavailable.' });
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch {
      parsed = { isPothole: null, confidence: null, reason: 'Could not parse AI response.' };
    }

    res.json({
      configured: true,
      isPothole: parsed.isPothole,
      confidence: parsed.confidence,
      depth: parsed.depth || null,
      severity: parsed.severity || null,
      reason: parsed.reason || ''
    });
  } catch (err) {
    res.json({ configured: true, isPothole: null, confidence: null, reason: 'AI check failed.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   SOS CHATBOT (Gemini-Powered)
══════════════════════════════════════════════════════════════ */

const CHATBOT_SYSTEM_PROMPT = `You are the MCL Road Grievance Helpdesk Assistant for the Municipal Corporation of Lucknow (MCL), Uttar Pradesh, India. You serve as both an AI helpdesk and an emergency helpline guide.

YOUR RESPONSIBILITIES:
1. Answer general questions about the pothole reporting system, how to file complaints, track status, and MCL services.
2. Help citizens understand complaint statuses (Pending, Scheduled, In-Progress, Resolved).
3. Provide emergency contact information when asked.
4. When asked about a specific ticket (e.g., "status of POT-1234"), say you'll look it up.
5. Be empathetic, professional, and helpful in Hindi and English.

KEY INFORMATION:
- MCL Control Room: 0522-2630-1234 (24/7)
- Toll-Free Helpline: 1800-180-5555
- WhatsApp Helpline: +91-9876-543-210
- CM Helpline: 1076
- Emergency Road Repair: Call 1800-180-5555
- Office: Nagar Nigam Bhawan, Lalbagh, Lucknow — 226001
- Office Hours: Mon–Sat, 10:00 AM – 5:00 PM

SLA COMMITMENTS:
- Critical potholes: 48 hours
- High severity: 7 working days
- Medium severity: 15 working days
- Low severity: 30 working days
- Auto-escalation after 30 days

HOW TO REPORT:
1. Click "Report a Pothole" → Pin location on map → Upload photo → Select severity → Submit
2. Quick Report: Take photo → GPS auto-detected → Submitted instantly
3. You get a Ticket ID (e.g., POT-1234) for tracking

FORMATS:
- Keep replies concise (under 150 words)
- Use emojis for friendliness
- If it's an emergency, IMMEDIATELY show emergency numbers
- Be bilingual (Hindi/English) based on user's language`;

app.post('/api/chat', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.json({
      reply: "I'm currently offline. For emergencies, please call:\n📞 MCL Control Room: 0522-2630-1234\n📞 Toll-Free: 1800-180-5555",
      emergency: true
    });
  }

  try {
    const { message, sessionId } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const chatSessionId = sessionId || 'default';

    // Save user message
    DB.addChatMessage(chatSessionId, 'user', message);

    // Get recent chat history for context
    const history = DB.getChatHistory(chatSessionId, 10);

    // Check if user is asking about a specific ticket
    const ticketMatch = message.match(/POT-\d{4}/i);
    let ticketContext = '';
    if (ticketMatch) {
      const report = DB.getReport(ticketMatch[0].toUpperCase());
      if (report) {
        ticketContext = `\n\n[LIVE DATA] Ticket ${report.id}: Status=${report.status}, Severity=${report.severity}, Location="${report.address}", Zone=${report.zone}, Assigned Worker=${report.assignedWorkerName || 'Not yet assigned'}, Created=${report.createdAt}`;
      } else {
        ticketContext = `\n\n[LIVE DATA] Ticket ${ticketMatch[0].toUpperCase()} was not found in our system.`;
      }
    }

    // Build conversation for Gemini
    const contents = [
      { role: 'user', parts: [{ text: CHATBOT_SYSTEM_PROMPT + ticketContext }] },
      { role: 'model', parts: [{ text: 'Understood. I am the MCL Road Grievance Helpdesk Assistant. How can I help you today? 🏛️' }] },
      ...history.map(h => ({
        role: h.role === 'user' ? 'user' : 'model',
        parts: [{ text: h.content }]
      }))
    ];

    // Ensure last message is from user (it should be, since we just added it)
    if (contents[contents.length - 1]?.role !== 'user') {
      contents.push({ role: 'user', parts: [{ text: message }] });
    }

    const model = 'gemini-2.0-flash';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 400 }
      })
    });

    if (!response.ok) {
      const reply = "I'm having trouble connecting right now. For urgent help:\n📞 MCL Control Room: 0522-2630-1234\n📞 Toll-Free: 1800-180-5555";
      DB.addChatMessage(chatSessionId, 'assistant', reply);
      return res.json({ reply, emergency: false });
    }

    const data = await response.json();
    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't process that. Please try again or call 0522-2630-1234 for immediate help.";

    // Save bot reply
    DB.addChatMessage(chatSessionId, 'assistant', reply);

    res.json({ reply, emergency: false });
  } catch (err) {
    console.error('Chat error:', err);
    res.json({
      reply: "I'm experiencing an error. For emergencies:\n📞 MCL Control Room: 0522-2630-1234\n📞 Toll-Free: 1800-180-5555",
      emergency: true
    });
  }
});

/* ══════════════════════════════════════════════════════════════
   START SERVER
══════════════════════════════════════════════════════════════ */

app.listen(PORT, () => {
  console.log(`\n🏛️  MCL Pothole Management System`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`🌐  Citizen Portal:  http://localhost:${PORT}/`);
  console.log(`🔐  Admin Dashboard: http://localhost:${PORT}/admin.html`);
  console.log(`📡  API Base:        http://localhost:${PORT}/api`);
  console.log(`🤖  Gemini AI:       ${GEMINI_API_KEY ? 'Configured ✅' : 'Not configured ❌'}`);
  console.log(`💾  Database:        pothole.db (SQLite)`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
});
