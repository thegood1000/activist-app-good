const express = require('express');
const path = require('path');
const { nanoid } = require('nanoid');
const db = require('../db');
const { requireRole } = require('../middleware/auth');
const router = express.Router();

const STAFF = ['super_admin', 'division_head', 'reviewer'];
router.use(requireRole(...STAFF));

function isSuperAdmin(user) {
  return user.role === 'super_admin';
}

function logAudit(actorId, action, details) {
  db.prepare('INSERT INTO audit_log (actor_id, action, details) VALUES (?, ?, ?)')
    .run(actorId, action, details || null);
}

router.get('/admin', (req, res) => {
  const scopeDivision = isSuperAdmin(req.user) ? null : req.user.division_id;
  const pendingQuery = scopeDivision
    ? db.prepare(`
        SELECT s.*, t.title, t.points, u.full_name, u.division_id
        FROM submissions s JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.user_id
        WHERE s.status = 'pending' AND u.division_id = ?
        ORDER BY s.created_at ASC
      `).all(scopeDivision)
    : db.prepare(`
        SELECT s.*, t.title, t.points, u.full_name, u.division_id
        FROM submissions s JOIN tasks t ON t.id = s.task_id JOIN users u ON u.id = s.user_id
        WHERE s.status = 'pending'
        ORDER BY s.created_at ASC
      `).all();

  const stats = {
    pendingCount: pendingQuery.length,
    usersCount: isSuperAdmin(req.user)
      ? db.prepare('SELECT COUNT(*) c FROM users').get().c
      : db.prepare('SELECT COUNT(*) c FROM users WHERE division_id = ?').get(req.user.division_id).c,
    approvedToday: db.prepare(`
      SELECT COUNT(*) c FROM submissions WHERE status='approved' AND date(reviewed_at) = date('now')
    `).get().c,
  };

  res.render('admin/dashboard', { pending: pendingQuery, stats, isSuperAdmin: isSuperAdmin(req.user) });
});

// ---------- תור בדיקה ----------
router.post('/admin/submissions/:id/decide', (req, res) => {
  const submission = db.prepare(`
    SELECT s.*, u.division_id AS user_division, t.points AS task_points
    FROM submissions s JOIN users u ON u.id = s.user_id JOIN tasks t ON t.id = s.task_id
    WHERE s.id = ?
  `).get(req.params.id);
  if (!submission) return res.status(404).send('לא נמצא');

  if (!isSuperAdmin(req.user) && submission.user_division !== req.user.division_id) {
    return res.status(403).render('error', { title: 'אין הרשאה', message: 'אתה יכול לאשר רק פעילים מהאגף שלך.' });
  }

  const { decision } = req.body; // approve | reject | needs_info
  const reason = (req.body.reason || '').trim();
  const reasonLabel = reason || '(ללא סיבה מפורטת)';

  const now = new Date().toISOString();
  db.prepare(`
    UPDATE submissions SET status = ?, reviewer_id = ?, review_reason = ?, reviewed_at = ?
    WHERE id = ?
  `).run(decision === 'approve' ? 'approved' : decision === 'reject' ? 'rejected' : 'needs_info',
    req.user.id, reason || null, now, submission.id);

  if (decision === 'approve') {
    db.prepare('UPDATE submissions SET points_awarded = ? WHERE id = ?').run(submission.task_points, submission.id);
    db.prepare('UPDATE users SET points_total = points_total + ? WHERE id = ?').run(submission.task_points, submission.user_id);
    db.prepare(`
      INSERT INTO points_ledger (user_id, delta, reason, related_submission_id, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(submission.user_id, submission.task_points, `אישור משימה: ${reasonLabel}`, submission.id, req.user.id);
  }

  logAudit(req.user.id, `submission_${decision}`, `submission #${submission.id}: ${reasonLabel}`);
  res.redirect('/admin');
});

// ---------- ערעורים ----------
router.get('/admin/appeals', (req, res) => {
  const scopeDivision = isSuperAdmin(req.user) ? null : req.user.division_id;
  const appeals = scopeDivision
    ? db.prepare(`
        SELECT ap.*, s.task_id, s.proof_path, s.status AS submission_status,
               t.title, t.points, u.full_name, u.division_id
        FROM appeals ap
        JOIN submissions s ON s.id = ap.submission_id
        JOIN tasks t ON t.id = s.task_id
        JOIN users u ON u.id = s.user_id
        WHERE ap.status = 'open' AND u.division_id = ?
        ORDER BY ap.created_at ASC
      `).all(scopeDivision)
    : db.prepare(`
        SELECT ap.*, s.task_id, s.proof_path, s.status AS submission_status,
               t.title, t.points, u.full_name, u.division_id
        FROM appeals ap
        JOIN submissions s ON s.id = ap.submission_id
        JOIN tasks t ON t.id = s.task_id
        JOIN users u ON u.id = s.user_id
        WHERE ap.status = 'open'
        ORDER BY ap.created_at ASC
      `).all();
  res.render('admin/appeals', { appeals, isSuperAdmin: isSuperAdmin(req.user) });
});

router.post('/admin/appeals/:id/resolve', (req, res) => {
  const appeal = db.prepare(`
    SELECT ap.*, s.id AS submission_id, s.task_id, s.user_id AS submission_user_id,
           s.status AS submission_status, u.division_id
    FROM appeals ap
    JOIN submissions s ON s.id = ap.submission_id
    JOIN users u ON u.id = s.user_id
    WHERE ap.id = ?
  `).get(req.params.id);
  if (!appeal) return res.status(404).send('לא נמצא');
  if (!isSuperAdmin(req.user) && appeal.division_id !== req.user.division_id) {
    return res.status(403).render('error', { title: 'אין הרשאה', message: 'אתה יכול לטפל רק בערעורים מהאגף שלך.' });
  }
  if (appeal.status !== 'open') return res.redirect('/admin/appeals');

  const action = req.body.action; // accept | reject
  const resolutionNote = (req.body.note || '').trim();

  if (action === 'accept' && appeal.submission_status === 'rejected') {
    const task = db.prepare('SELECT points FROM tasks WHERE id = ?').get(appeal.task_id);
    db.prepare(`
      UPDATE submissions SET status = 'approved', points_awarded = ?, review_reason = ?, reviewed_at = datetime('now')
      WHERE id = ?
    `).run(task.points, `אושר בעקבות ערעור${resolutionNote ? ': ' + resolutionNote : ''}`, appeal.submission_id);
    db.prepare('UPDATE users SET points_total = points_total + ? WHERE id = ?').run(task.points, appeal.submission_user_id);
    db.prepare(`
      INSERT INTO points_ledger (user_id, delta, reason, related_submission_id, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(appeal.submission_user_id, task.points, `אישור בעקבות ערעור${resolutionNote ? ': ' + resolutionNote : ''}`,
      appeal.submission_id, req.user.id);
  }

  db.prepare(`UPDATE appeals SET status = 'resolved', resolution_note = ?, resolved_by = ? WHERE id = ?`)
    .run(resolutionNote, req.user.id, appeal.id);
  logAudit(req.user.id, `appeal_${action === 'accept' ? 'accepted' : 'rejected'}`,
    `appeal #${appeal.id} (submission #${appeal.submission_id}): ${resolutionNote}`);
  res.redirect('/admin/appeals');
});

// ---------- ניקוד ידני ----------
router.get('/admin/points', (req, res) => {
  const users = isSuperAdmin(req.user)
    ? db.prepare('SELECT * FROM users ORDER BY full_name').all()
    : db.prepare('SELECT * FROM users WHERE division_id = ? ORDER BY full_name').all(req.user.division_id);
  res.render('admin/points', { users });
});

router.post('/admin/points/adjust', (req, res) => {
  const { user_id, delta, reason } = req.body;
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(user_id);
  if (!target) return res.status(404).send('לא נמצא');
  if (!isSuperAdmin(req.user) && target.division_id !== req.user.division_id) {
    return res.status(403).render('error', { title: 'אין הרשאה', message: 'ניתן לשנות ניקוד רק לפעילים מהאגף שלך.' });
  }
  if (!reason || !reason.trim()) {
    return res.status(400).render('error', { title: 'חסרה סיבה', message: 'חובה לציין סיבה לכל שינוי ניקוד.' });
  }
  const d = parseInt(delta, 10) || 0;
  db.prepare('UPDATE users SET points_total = points_total + ? WHERE id = ?').run(d, target.id);
  db.prepare(`
    INSERT INTO points_ledger (user_id, delta, reason, created_by) VALUES (?, ?, ?, ?)
  `).run(target.id, d, reason, req.user.id);
  logAudit(req.user.id, 'manual_points_adjust', `user #${target.id}: ${d} (${reason})`);
  res.redirect('/admin/points');
});

// ---------- משימות (מנהל-על + מנהל אגף) ----------
router.get('/admin/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY created_at DESC').all();
  const divisions = db.prepare('SELECT * FROM divisions ORDER BY name').all();
  res.render('admin/tasks', { tasks, divisions });
});

router.post('/admin/tasks/create', (req, res) => {
  const b = req.body;
  const divisionId = isSuperAdmin(req.user) ? (b.division_id || null) : req.user.division_id;
  db.prepare(`
    INSERT INTO tasks (title, description, task_type, points, starts_at, ends_at,
      max_completions_per_user, proof_type, est_minutes, difficulty, approval_conditions,
      reference_link, requires_admin_approval, participant_limit, division_id, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)
  `).run(
    b.title, b.description || '', b.task_type || 'digital', parseInt(b.points, 10) || 10,
    b.starts_at || null, b.ends_at || null, parseInt(b.max_completions_per_user, 10) || 1,
    b.proof_type || 'screenshot', parseInt(b.est_minutes, 10) || null, b.difficulty || 'easy',
    b.approval_conditions || '', b.reference_link || '', b.participant_limit ? parseInt(b.participant_limit, 10) : null,
    divisionId, req.user.id
  );
  logAudit(req.user.id, 'task_create', b.title);
  res.redirect('/admin/tasks');
});

router.post('/admin/tasks/:id/toggle', (req, res) => {
  db.prepare('UPDATE tasks SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/tasks');
});

// ---------- קודי הצטרפות (מנהל-על בלבד) ----------
router.get('/admin/invites', requireRole('super_admin'), (req, res) => {
  const invites = db.prepare(`
    SELECT ic.*, d.name AS division_name FROM invite_codes ic
    LEFT JOIN divisions d ON d.id = ic.division_id ORDER BY ic.created_at DESC
  `).all();
  const divisions = db.prepare('SELECT * FROM divisions ORDER BY name').all();
  res.render('admin/invites', { invites, divisions });
});

router.post('/admin/invites/create', requireRole('super_admin'), (req, res) => {
  const b = req.body;
  const code = (b.custom_code || nanoid(8)).toUpperCase();
  db.prepare(`
    INSERT INTO invite_codes (code, division_id, role_to_grant, max_uses, expires_at, requires_approval, created_by)
    VALUES (?,?,?,?,?,?,?)
  `).run(code, b.division_id || null, b.role_to_grant || 'activist',
    b.max_uses ? parseInt(b.max_uses, 10) : null, b.expires_at || null,
    b.requires_approval ? 1 : 0, req.user.id);
  logAudit(req.user.id, 'invite_create', code);
  res.redirect('/admin/invites');
});

router.post('/admin/invites/:id/toggle', requireRole('super_admin'), (req, res) => {
  db.prepare('UPDATE invite_codes SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/invites');
});

// ---------- אגפים (מנהל-על בלבד) ----------
router.post('/admin/divisions/create', requireRole('super_admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) {
    db.prepare('INSERT OR IGNORE INTO divisions (name) VALUES (?)').run(name);
    logAudit(req.user.id, 'division_create', name);
  }
  res.redirect('/admin/invites');
});

// ---------- משתמשים (מנהל-על: כולם, מנהל אגף: האגף שלו) ----------
router.get('/admin/users', (req, res) => {
  const users = isSuperAdmin(req.user)
    ? db.prepare(`SELECT u.*, d.name AS division_name FROM users u LEFT JOIN divisions d ON d.id=u.division_id ORDER BY u.created_at DESC`).all()
    : db.prepare(`SELECT u.*, d.name AS division_name FROM users u LEFT JOIN divisions d ON d.id=u.division_id WHERE u.division_id = ? ORDER BY u.created_at DESC`).all(req.user.division_id);
  res.render('admin/users', { users });
});

router.post('/admin/users/:id/freeze', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).send('לא נמצא');
  if (!isSuperAdmin(req.user) && target.division_id !== req.user.division_id) {
    return res.status(403).render('error', { title: 'אין הרשאה', message: 'ניתן להקפיא רק פעילים מהאגף שלך.' });
  }
  db.prepare('UPDATE users SET is_frozen = 1 - is_frozen WHERE id = ?').run(target.id);
  logAudit(req.user.id, 'user_freeze_toggle', `user #${target.id}`);
  res.redirect('/admin/users');
});

// ---------- ייצוא CSV (מנהל-על בלבד) ----------
router.get('/admin/export/users.csv', requireRole('super_admin'), (req, res) => {
  const users = db.prepare(`SELECT u.id, u.full_name, u.phone, u.role, d.name AS division, u.points_total, u.is_frozen, u.created_at
    FROM users u LEFT JOIN divisions d ON d.id = u.division_id`).all();
  const header = 'id,full_name,phone,role,division,points_total,is_frozen,created_at\n';
  const rows = users.map((u) => [u.id, `"${u.full_name}"`, u.phone, u.role, u.division || '', u.points_total, u.is_frozen, u.created_at].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="users.csv"');
  res.send('﻿' + header + rows);
});

router.get('/admin/export/submissions.csv', requireRole('super_admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, u.full_name, t.title, s.status, s.points_awarded, s.review_reason, s.created_at, s.reviewed_at
    FROM submissions s JOIN users u ON u.id=s.user_id JOIN tasks t ON t.id = s.task_id
  `).all();
  const header = 'id,full_name,task,status,points_awarded,review_reason,created_at,reviewed_at\n';
  const body = rows.map((r) => [r.id, `"${r.full_name}"`, `"${r.title}"`, r.status, r.points_awarded || '', `"${(r.review_reason||'').replace(/"/g,'""')}"`, r.created_at, r.reviewed_at || ''].join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="submissions.csv"');
  res.send('﻿' + header + body);
});

// ---------- גיבוי מהיר של בסיס הנתונים (מנהל-על בלבד) ----------
router.get('/admin/backup/db', requireRole('super_admin'), (req, res) => {
  const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
  logAudit(req.user.id, 'db_backup_download', dbPath);
  res.download(dbPath, `activist-app-backup-${new Date().toISOString().slice(0, 10)}.db`);
});

module.exports = router;
