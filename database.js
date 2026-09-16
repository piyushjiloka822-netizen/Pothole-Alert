/**
 * Database Module — Pothole Management System
 * SQLite database initialization and helper functions using better-sqlite3.
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'pothole.db');
let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      description TEXT DEFAULT '',
      severity TEXT DEFAULT 'medium',
      roadType TEXT DEFAULT 'city-road',
      address TEXT DEFAULT 'Unknown location',
      zone TEXT DEFAULT 'Other',
      reporterName TEXT DEFAULT 'Anonymous',
      reporterId TEXT DEFAULT '',
      status TEXT DEFAULT 'pending',
      upvotes INTEGER DEFAULT 0,
      voters TEXT DEFAULT '[]',
      photo TEXT,
      afterPhoto TEXT,
      workerPhoto TEXT,
      workerPhotoUploadedAt TEXT,
      assignedWorkerId TEXT,
      assignedWorkerName TEXT,
      resources TEXT DEFAULT '',
      crew TEXT DEFAULT '',
      adminNotes TEXT DEFAULT '',
      depthEstimate TEXT DEFAULT '',
      escalated INTEGER DEFAULT 0,
      aiCheckHeuristicLevel TEXT,
      aiCheckIsPothole INTEGER,
      aiCheckConfidence REAL,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      specialization TEXT DEFAULT 'General',
      status TEXT DEFAULT 'available',
      currentAssignment TEXT DEFAULT '',
      completedJobs INTEGER DEFAULT 0,
      rating REAL DEFAULT 5.0,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId TEXT NOT NULL,
      message TEXT NOT NULL,
      type TEXT DEFAULT 'info',
      read INTEGER DEFAULT 0,
      ticketId TEXT DEFAULT '',
      createdAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chat_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      ticketId TEXT DEFAULT '',
      details TEXT DEFAULT '{}',
      performedBy TEXT DEFAULT 'admin',
      createdAt TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
    CREATE INDEX IF NOT EXISTS idx_reports_zone ON reports(zone);
    CREATE INDEX IF NOT EXISTS idx_notifications_userId ON notifications(userId);
    CREATE INDEX IF NOT EXISTS idx_chat_sessionId ON chat_history(sessionId);
    CREATE INDEX IF NOT EXISTS idx_audit_ticketId ON audit_log(ticketId);
  `);

  // Seed some default workers if table is empty
  const count = db.prepare('SELECT COUNT(*) as c FROM workers').get().c;
  if (count === 0) {
    const insert = db.prepare(`INSERT INTO workers (id, name, phone, specialization, status) VALUES (?, ?, ?, ?, ?)`);
    const workers = [
      ['WRK-001', 'Rajesh Kumar', '+91-9876543001', 'Pothole Repair', 'available'],
      ['WRK-002', 'Suresh Yadav', '+91-9876543002', 'Road Resurfacing', 'available'],
      ['WRK-003', 'Amit Singh', '+91-9876543003', 'Drainage & Waterlogging', 'available'],
      ['WRK-004', 'Pradeep Verma', '+91-9876543004', 'Pothole Repair', 'available'],
      ['WRK-005', 'Manoj Tiwari', '+91-9876543005', 'General Maintenance', 'available'],
      ['WRK-006', 'Vikram Patel', '+91-9876543006', 'Heavy Equipment Operator', 'available'],
    ];
    const insertMany = db.transaction(() => {
      for (const w of workers) insert.run(...w);
    });
    insertMany();
  }
}

/* ── Report CRUD ─────────────────────────────────────────────── */

function generateTicketId() {
  const existing = db.prepare('SELECT id FROM reports').all().map(r => r.id);
  let id;
  do {
    id = 'POT-' + String(Math.floor(1000 + Math.random() * 9000));
  } while (existing.includes(id));
  return id;
}

function createReport(data) {
  const requestedId = typeof data.id === 'string' && /^POT-\d{4}$/.test(data.id)
    ? data.id
    : null;
  const id = requestedId && !db.prepare('SELECT 1 FROM reports WHERE id = ?').get(requestedId)
    ? requestedId
    : generateTicketId();
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO reports (id, lat, lng, description, severity, roadType, address, zone,
      reporterName, reporterId, status, photo, aiCheckHeuristicLevel, aiCheckIsPothole,
      aiCheckConfidence, depthEstimate, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    id, data.lat, data.lng, data.description || '', data.severity || 'medium',
    data.roadType || 'city-road', data.address || 'Unknown location', data.zone || 'Other',
    data.reporterName || 'Anonymous', data.reporterId || '',
    data.photo || null,
    data.aiCheckHeuristicLevel || null,
    data.aiCheckIsPothole != null ? (data.aiCheckIsPothole ? 1 : 0) : null,
    data.aiCheckConfidence || null,
    data.depthEstimate || '',
    now, now
  );
  return getReport(id);
}

function getReport(id) {
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!row) return null;
  row.voters = JSON.parse(row.voters || '[]');
  row.escalated = !!row.escalated;
  row.aiCheckIsPothole = row.aiCheckIsPothole == null ? null : !!row.aiCheckIsPothole;
  return row;
}

function getAllReports(filters = {}) {
  let sql = 'SELECT * FROM reports';
  const conditions = [];
  const params = [];

  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters.zone) {
    conditions.push('zone = ?');
    params.push(filters.zone);
  }
  if (filters.severity) {
    conditions.push('severity = ?');
    params.push(filters.severity);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY createdAt DESC';

  const rows = db.prepare(sql).all(...params);
  return rows.map(row => {
    row.voters = JSON.parse(row.voters || '[]');
    row.escalated = !!row.escalated;
    row.aiCheckIsPothole = row.aiCheckIsPothole == null ? null : !!row.aiCheckIsPothole;
    return row;
  });
}

function updateReport(id, updates) {
  const report = getReport(id);
  if (!report) return null;

  const allowed = [
    'status', 'crew', 'assignedWorkerId', 'assignedWorkerName', 'resources',
    'afterPhoto', 'workerPhoto', 'workerPhotoUploadedAt', 'adminNotes',
    'depthEstimate', 'escalated', 'upvotes', 'voters', 'severity'
  ];

  const sets = [];
  const params = [];

  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      if (key === 'voters') {
        params.push(JSON.stringify(updates[key]));
      } else if (key === 'escalated') {
        params.push(updates[key] ? 1 : 0);
      } else {
        params.push(updates[key]);
      }
    }
  }

  if (sets.length === 0) return report;

  sets.push('updatedAt = ?');
  params.push(new Date().toISOString());
  params.push(id);

  db.prepare(`UPDATE reports SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getReport(id);
}

function deleteReport(id) {
  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
}

function upvoteReport(id, userId) {
  const report = getReport(id);
  if (!report) return null;
  if (report.voters.includes(userId)) return { report, alreadyVoted: true };
  const newVoters = [...report.voters, userId];
  const updated = updateReport(id, {
    upvotes: (report.upvotes || 0) + 1,
    voters: newVoters
  });
  return { report: updated, alreadyVoted: false };
}

/* ── Worker CRUD ─────────────────────────────────────────────── */

function getAllWorkers() {
  return db.prepare('SELECT * FROM workers ORDER BY name').all();
}

function getWorker(id) {
  return db.prepare('SELECT * FROM workers WHERE id = ?').get(id);
}

function createWorker(data) {
  const id = 'WRK-' + String(Math.floor(100 + Math.random() * 900));
  db.prepare(`INSERT INTO workers (id, name, phone, specialization, status) VALUES (?, ?, ?, ?, 'available')`)
    .run(id, data.name, data.phone || '', data.specialization || 'General');
  return getWorker(id);
}

function updateWorker(id, updates) {
  const allowed = ['name', 'phone', 'specialization', 'status', 'currentAssignment', 'completedJobs', 'rating'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (updates[key] !== undefined) {
      sets.push(`${key} = ?`);
      params.push(updates[key]);
    }
  }
  if (sets.length === 0) return getWorker(id);
  params.push(id);
  db.prepare(`UPDATE workers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getWorker(id);
}

function deleteWorker(id) {
  db.prepare('DELETE FROM workers WHERE id = ?').run(id);
}

/* ── Notifications ───────────────────────────────────────────── */

function addNotification(userId, message, type = 'info', ticketId = '') {
  db.prepare(`INSERT INTO notifications (userId, message, type, ticketId) VALUES (?, ?, ?, ?)`)
    .run(userId, message, type, ticketId);
}

function getNotifications(userId) {
  return db.prepare('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC LIMIT 30')
    .all(userId);
}

function markNotificationsRead(userId) {
  db.prepare('UPDATE notifications SET read = 1 WHERE userId = ? AND read = 0').run(userId);
}

function getUnreadCount(userId) {
  return db.prepare('SELECT COUNT(*) as c FROM notifications WHERE userId = ? AND read = 0').get(userId).c;
}

/* ── Chat History ────────────────────────────────────────────── */

function addChatMessage(sessionId, role, content) {
  db.prepare(`INSERT INTO chat_history (sessionId, role, content) VALUES (?, ?, ?)`)
    .run(sessionId, role, content);
}

function getChatHistory(sessionId, limit = 20) {
  return db.prepare('SELECT * FROM chat_history WHERE sessionId = ? ORDER BY createdAt DESC LIMIT ?')
    .all(sessionId, limit).reverse();
}

/* ── Audit Log ───────────────────────────────────────────────── */

function logAudit(action, ticketId = '', details = {}, performedBy = 'admin') {
  db.prepare(`INSERT INTO audit_log (action, ticketId, details, performedBy) VALUES (?, ?, ?, ?)`)
    .run(action, ticketId, JSON.stringify(details), performedBy);
}

function getAuditLog(limit = 100) {
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY createdAt DESC LIMIT ?').all(limit);
  return rows.map(r => { r.details = JSON.parse(r.details || '{}'); return r; });
}

/* ── Stats ───────────────────────────────────────────────────── */

function getStats() {
  const total = db.prepare('SELECT COUNT(*) as c FROM reports').get().c;
  const pending = db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'pending'").get().c;
  const scheduled = db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'scheduled'").get().c;
  const inProgress = db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'in-progress'").get().c;
  const resolved = db.prepare("SELECT COUNT(*) as c FROM reports WHERE status = 'resolved'").get().c;
  const escalated = db.prepare("SELECT COUNT(*) as c FROM reports WHERE escalated = 1").get().c;
  return { total, pending, scheduled, inProgress, resolved, escalated };
}

function getAnalytics() {
  const reports = getAllReports();
  const now = Date.now();

  // Zone breakdown
  const zoneCounts = {};
  reports.forEach(r => { const z = r.zone || 'Unknown'; zoneCounts[z] = (zoneCounts[z] || 0) + 1; });

  // Severity breakdown
  const severityCounts = { low: 0, medium: 0, high: 0, critical: 0 };
  reports.forEach(r => { if (severityCounts[r.severity] !== undefined) severityCounts[r.severity]++; });

  // Monthly trend (last 6 months)
  const monthlyCounts = {};
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now);
    d.setMonth(d.getMonth() - i);
    const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    monthlyCounts[key] = 0;
  }
  reports.forEach(r => {
    const d = new Date(r.createdAt);
    const key = d.toLocaleString('default', { month: 'short', year: '2-digit' });
    if (monthlyCounts[key] !== undefined) monthlyCounts[key]++;
  });

  // Average resolution time
  const resolved = reports.filter(r => r.status === 'resolved');
  let avgResolution = 0;
  if (resolved.length > 0) {
    const totalDays = resolved.reduce((sum, r) => {
      const days = (new Date(r.updatedAt) - new Date(r.createdAt)) / 86400000;
      return sum + days;
    }, 0);
    avgResolution = Math.round(totalDays / resolved.length);
  }

  // Road type breakdown
  const roadTypeCounts = { highway: 0, 'city-road': 0, lane: 0, bridge: 0 };
  reports.forEach(r => { if (roadTypeCounts[r.roadType] !== undefined) roadTypeCounts[r.roadType]++; });

  return { zoneCounts, severityCounts, monthlyCounts, avgResolution, roadTypeCounts, totalResolved: resolved.length };
}

module.exports = {
  getDb, generateTicketId,
  createReport, getReport, getAllReports, updateReport, deleteReport, upvoteReport,
  getAllWorkers, getWorker, createWorker, updateWorker, deleteWorker,
  addNotification, getNotifications, markNotificationsRead, getUnreadCount,
  addChatMessage, getChatHistory,
  logAudit, getAuditLog,
  getStats, getAnalytics
};
