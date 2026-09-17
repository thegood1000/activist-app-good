const db = require('../db');

function loadUser(req, res, next) {
  res.locals.currentUser = null;
  if (req.session && req.session.userId) {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (user && !user.is_frozen) {
      req.user = user;
      res.locals.currentUser = user;
    } else if (user && user.is_frozen) {
      req.session.destroy(() => {});
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/join');
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/join');
    if (!roles.includes(req.user.role)) {
      return res.status(403).render('error', {
        title: 'אין הרשאה',
        message: 'אין לך הרשאה לצפות בעמוד הזה.',
      });
    }
    next();
  };
}

module.exports = { loadUser, requireAuth, requireRole };
