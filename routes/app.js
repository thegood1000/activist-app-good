const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { getLevel } = require('../lib/levels');
const router = express.Router();

const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', 'public', 'uploads');
const upload = multer({
  dest: uploadsDir,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(file.mimetype);
    cb(ok ? null : new Error('סוג קובץ לא נתמך'), ok);
  },
});

function visibleTasksQuery(user) {
  return db.prepare(`
    SELECT * FROM tasks
    WHERE active = 1
      AND (division_id IS NULL OR division_id = ?)
      AND (starts_at IS NULL OR starts_at <= datetime('now'))
      AND (ends_at IS NULL OR ends_at >= datetime('now'))
    ORDER BY created_at DESC
  `).all(user.division_id);
}

function completionsCount(userId, taskId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS c FROM submissions
    WHERE user_id = ? AND task_id = ? AND status IN ('pending','approved')
  `).get(userId, taskId);
  return row.c;
}

router.get('/home', (req, res) => {
  const user = req.user;
  const level = getLevel(user.points_total);
  const tasks = visibleTasksQuery(user).filter(
    (t) => completionsCount(user.id, t.id) < t.max_completions_per_user
  );
  const division = user.division_id
    ? db.prepare('SELECT * FROM divisions WHERE id = ?').get(user.division_id)
    : null;

  res.render('home', {
    level,
    recommended: tasks[0] || null,
    moreTasks: tasks.slice(1, 3),
    division,
  });
});

router.get('/tasks', (req, res) => {
  const user = req.user;
  const filterType = req.query.type || '';
  let tasks = visibleTasksQuery(user);
  if (filterType) tasks = tasks.filter((t) => t.task_type === filterType);
  tasks = tasks.map((t) => ({
    ...t,
    doneCount: completionsCount(user.id, t.id),
  }));
  res.render('tasks', { tasks, filterType });
});

router.get('/tasks/:id', (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'לא נמצא', message: 'המשימה לא נמצאה.' });
  const doneCount = completionsCount(req.user.id, task.id);
  const canSubmit = doneCount < task.max_completions_per_user;
  const lastSubmission = db.prepare(`
    SELECT * FROM submissions WHERE user_id = ? AND task_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(req.user.id, task.id);
  res.render('task_detail', { task, canSubmit, lastSubmission });
});

router.post('/tasks/:id/submit', upload.single('proof'), (req, res) => {
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(req.params.id);
  if (!task) return res.status(404).render('error', { title: 'לא נמצא', message: 'המשימה לא נמצאה.' });

  const doneCount = completionsCount(req.user.id, task.id);
  if (doneCount >= task.max_completions_per_user) {
    return res.redirect(`/tasks/${task.id}`);
  }

  let proofPath = null;
  let proofHash = null;
  if (task.proof_type === 'screenshot' || task.proof_type === 'camera') {
    if (!req.file) {
      return res.render('task_detail', {
        task,
        canSubmit: true,
        lastSubmission: null,
        error: 'חסר צילום מסך - נא לצרף הוכחה לפני השליחה.',
      });
    }
    proofPath = '/uploads/' + req.file.filename;
    proofHash = crypto.createHash('sha256').update(require('fs').readFileSync(req.file.path)).digest('hex');

    const dup = db.prepare('SELECT id FROM submissions WHERE proof_hash = ?').get(proofHash);
    if (dup) {
      return res.render('task_detail', {
        task,
        canSubmit: true,
        lastSubmission: null,
        error: 'נראה שהתמונה הזו כבר נשלחה בעבר. יש לצלם הוכחה חדשה לכל משימה.',
      });
    }
  }

  db.prepare(`
    INSERT INTO submissions (task_id, user_id, proof_path, proof_hash, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(task.id, req.user.id, proofPath, proofHash);

  res.render('submit_success', { task });
});

router.get('/history', (req, res) => {
  const submissions = db.prepare(`
    SELECT s.*, t.title, t.points,
      (SELECT COUNT(*) FROM appeals a WHERE a.submission_id = s.id) AS appeal_count
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `).all(req.user.id);
  const ledger = db.prepare(`
    SELECT * FROM points_ledger WHERE user_id = ? ORDER BY created_at DESC
  `).all(req.user.id);
  res.render('history', { submissions, ledger, appealFlash: req.query.appeal });
});

router.post('/submissions/:id/appeal', (req, res) => {
  const submission = db.prepare('SELECT * FROM submissions WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!submission) return res.status(404).send('לא נמצא');

  const existing = db.prepare('SELECT id FROM appeals WHERE submission_id = ?').get(submission.id);
  if (existing) {
    return res.redirect('/history?appeal=exists');
  }

  db.prepare('INSERT INTO appeals (submission_id, user_id, message) VALUES (?, ?, ?)')
    .run(submission.id, req.user.id, (req.body.message || '').trim());
  res.redirect('/history?appeal=sent');
});

router.get('/leaderboard', (req, res) => {
  const individuals = db.prepare(`
    SELECT id, full_name, hide_full_name, points_total, division_id
    FROM users WHERE role = 'activist' OR role = 'division_head'
    ORDER BY points_total DESC LIMIT 50
  `).all().map((u, i) => ({
    rank: i + 1,
    name: u.hide_full_name ? 'פעיל/ה אנונימי/ת' : u.full_name,
    points: u.points_total,
    isMe: u.id === req.user.id,
  }));

  const divisions = db.prepare(`
    SELECT d.id, d.name, COALESCE(SUM(u.points_total),0) AS total
    FROM divisions d LEFT JOIN users u ON u.division_id = d.id
    GROUP BY d.id ORDER BY total DESC
  `).all();

  res.render('leaderboard', { individuals, divisions });
});

router.post('/profile/toggle-name', (req, res) => {
  db.prepare('UPDATE users SET hide_full_name = 1 - hide_full_name WHERE id = ?').run(req.user.id);
  res.redirect('/profile');
});

router.post('/profile/change-pin', (req, res) => {
  const { current_pin, new_pin, new_pin_confirm } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!current_pin || !bcrypt.compareSync(current_pin, user.pin_hash)) {
    return res.render('profile', { error: 'הקוד הנוכחי שגוי.' });
  }
  if (!new_pin || new_pin.trim().length < 4) {
    return res.render('profile', { error: 'הקוד החדש חייב להכיל לפחות 4 ספרות.' });
  }
  if (new_pin !== new_pin_confirm) {
    return res.render('profile', { error: 'הקוד החדש ואימות הקוד לא זהים.' });
  }

  const newHash = bcrypt.hashSync(new_pin.trim(), 10);
  db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(newHash, req.user.id);
  db.prepare('INSERT INTO audit_log (actor_id, action, details) VALUES (?, ?, ?)')
    .run(req.user.id, 'self_change_pin', null);
  res.render('profile', { success: 'הקוד האישי עודכן בהצלחה.' });
});

router.get('/profile', (req, res) => {
  res.render('profile');
});

module.exports = router;
