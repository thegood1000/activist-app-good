// זריעה אוטומטית בהפעלה ראשונה - כדי שלא יהיה צורך להריץ פקודות בטרמינל
// אחרי פריסה לאירוח (Railway וכו'). פועל רק אם עדיין אין אף מנהל-על במערכת.
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('../db');

function autoSeed() {
  const hasSuperAdmin = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'super_admin'").get().c > 0;
  if (hasSuperAdmin) return;

  const phone = process.env.INITIAL_ADMIN_PHONE;
  const pin = process.env.INITIAL_ADMIN_PIN;
  const name = process.env.INITIAL_ADMIN_NAME || 'מנהל ראשי';

  if (!phone || !pin) {
    console.log('[הפעלה ראשונה] לא נמצאו INITIAL_ADMIN_PHONE / INITIAL_ADMIN_PIN במשתני הסביבה - לא נוצר מנהל-על אוטומטית. אפשר להריץ ידנית: npm run seed -- --phone ... --pin ... --name ...');
    return;
  }

  const pinHash = bcrypt.hashSync(pin, 10);
  const info = db.prepare(`
    INSERT INTO users (full_name, phone, pin_hash, role) VALUES (?, ?, ?, 'super_admin')
  `).run(name, phone, pinHash);
  console.log(`[הפעלה ראשונה] נוצר מנהל-על: ${name} (טלפון: ${phone}). היכנס עם הטלפון והקוד האישי שהגדרת.`);

  let division = db.prepare("SELECT * FROM divisions WHERE name = 'אגף ראשי'").get();
  if (!division) {
    const d = db.prepare("INSERT INTO divisions (name) VALUES ('אגף ראשי')").run();
    division = { id: d.lastInsertRowid };
    console.log('[הפעלה ראשונה] נוצר אגף לדוגמה: אגף ראשי');
  }

  const sampleCode = 'START' + nanoid(4).toUpperCase();
  db.prepare(`
    INSERT INTO invite_codes (code, division_id, role_to_grant, active) VALUES (?, ?, 'activist', 1)
  `).run(sampleCode, division.id);
  console.log(`[הפעלה ראשונה] קוד הצטרפות לדוגמה לפעילים: ${sampleCode} (אפשר לכבות/להחליף בפאנל הניהול)`);

  const taskCount = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
  if (taskCount === 0) {
    db.prepare(`
      INSERT INTO tasks (title, description, task_type, points, max_completions_per_user, proof_type, est_minutes, difficulty, requires_admin_approval)
      VALUES (?,?,?,?,?,?,?,?,1)
    `).run(
      'שתפו את הפוסט האחרון',
      'היכנסו לעמוד הרשמי, שתפו את הפוסט המוצמד, וצלמו מסך שמראה שהשיתוף בוצע.',
      'digital', 10, 3, 'screenshot', 3, 'easy'
    );
    console.log('[הפעלה ראשונה] נוצרה משימת דוגמה ראשונה - אפשר לערוך/למחוק בפאנל הניהול.');
  }

  db.prepare(`INSERT INTO audit_log (actor_id, action, details) VALUES (?, ?, ?)`)
    .run(info.lastInsertRowid, 'auto_seed', 'זריעה אוטומטית בהפעלה ראשונה');
}

module.exports = autoSeed;
