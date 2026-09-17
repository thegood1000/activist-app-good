// הגבלת קצב פשוטה בזיכרון - מספיקה לשלב 1 (שרת יחיד).
// אם בעתיד ירוצו כמה מופעי שרת, יש לעבור למנגנון משותף (Redis וכו').
const attempts = new Map(); // key -> { count, resetAt }

function rateLimit({ windowMs = 15 * 60 * 1000, max = 8, keyFn }) {
  return (req, res, next) => {
    const key = keyFn(req);
    const now = Date.now();
    const entry = attempts.get(key);
    if (!entry || entry.resetAt < now) {
      attempts.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= max) {
      const minutesLeft = Math.ceil((entry.resetAt - now) / 60000);
      return res.status(429).render('error', {
        title: 'יותר מדי ניסיונות',
        message: `יותר מדי ניסיונות כניסה. נסה/י שוב בעוד כ-${minutesLeft} דקות, או פנה/י למנהל האגף לעזרה.`,
      });
    }
    entry.count += 1;
    next();
  };
}

module.exports = { rateLimit };
