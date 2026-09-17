const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { rateLimit } = require('../middleware/rateLimit');
const router = express.Router();

const loginLimiter = rateLimit({ max: 8, windowMs: 15 * 60 * 1000, keyFn: (req) => 'login:' + (req.body.phone || req.ip) });
const joinLimiter = rateLimit({ max: 15, windowMs: 15 * 60 * 1000, keyFn: (req) => 'join:' + req.ip });

function normalizePhone(phone) {
  return (phone || '').replace(/[^0-9]/g, '');
}

// מסך פתיחה / הזנת קוד הזמנה
router.get('/join', (req, res) => {
  if (req.user) return res.redirect('/home');
  res.render('join', { error: null, step: 'code' });
});

router.post('/join/check-code', joinLimiter, (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ? AND active = 1').get(code);
  if (!invite) {
    return res.render('join', { error: 'קוד ההזמנה שגוי או שאינו פעיל. בדוק עם מנהל האגף שלך.', step: 'code' });
  }
  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return res.render('join', { error: 'קוד ההזמנה פג תוקף.', step: 'code' });
  }
  if (invite.max_uses && invite.uses_count >= invite.max_uses) {
    return res.render('join', { error: 'קוד ההזמנה מוצה. יש לבקש קוד חדש.', step: 'code' });
  }
  res.render('join', { error: null, step: 'details', code });
});

router.post('/join/register', (req, res) => {
  const code = (req.body.code || '').trim().toUpperCase();
  const fullName = (req.body.full_name || '').trim();
  const phone = normalizePhone(req.body.phone);
  const pin = (req.body.pin || '').trim();

  const invite = db.prepare('SELECT * FROM invite_codes WHERE code = ? AND active = 1').get(code);
  if (!invite) {
    return res.render('join', { error: 'קוד ההזמנה כבר לא תקף, נסה שוב מההתחלה.', step: 'code' });
  }
  if (!fullName || fullName.length < 2) {
    return res.render('join', { error: 'נא להזין שם מלא.', step: 'details', code });
  }
  if (!phone || phone.length < 9) {
    return res.render('join', { error: 'נא להזין מספר טלפון תקין.', step: 'details', code });
  }
  if (!pin || pin.length < 4) {
    return res.render('join', { error: 'נא לבחור קוד אישי בן 4 ספרות לפחות (לזכור אותו לכניסה הבאה).', step: 'details', code });
  }

  const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (existing) {
    return res.render('join', { error: 'המספר הזה כבר רשום במערכת. נסה להתחבר במקום להירשם.', step: 'code' });
  }

  const pinHash = bcrypt.hashSync(pin, 10);
  const info = db.prepare(`
    INSERT INTO users (full_name, phone, pin_hash, role, division_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(fullName, phone, pinHash, invite.role_to_grant || 'activist', invite.division_id);

  db.prepare('UPDATE invite_codes SET uses_count = uses_count + 1 WHERE id = ?').run(invite.id);
  db.prepare('INSERT INTO audit_log (actor_id, action, details) VALUES (?, ?, ?)')
    .run(info.lastInsertRowid, 'join', `הצטרפות עם קוד ${code}`);

  req.session.userId = info.lastInsertRowid;
  res.redirect('/onboarding');
});

// כניסה חוזרת
router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/home');
  res.render('login', { error: null });
});

router.post('/login', loginLimiter, (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const pin = (req.body.pin || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user || !bcrypt.compareSync(pin, user.pin_hash)) {
    return res.render('login', { error: 'טלפון או קוד אישי שגויים.' });
  }
  if (user.is_frozen) {
    return res.render('login', { error: 'החשבון שלך מוקפא כרגע. פנה למנהל האגף שלך.' });
  }
  req.session.userId = user.id;
  res.redirect('/home');
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/join'));
});

router.get('/onboarding', (req, res) => {
  if (!req.user) return res.redirect('/join');
  res.render('onboarding');
});

module.exports = router;
