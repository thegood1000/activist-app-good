// יצירת מנהל-על ראשון + אגף לדוגמה + קוד הצטרפות לדוגמה
// הרצה: npm run seed -- --phone 0501234567 --pin 1234 --name "שם מלא"
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { nanoid } = require('nanoid');
const db = require('../db');

const args = process.argv.slice(2);
function argVal(flag, def) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
}

const phone = argVal('--phone', '0500000000');
const pin = argVal('--pin', '1234');
const name = argVal('--name', 'מנהל ראשי');

const existing = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
if (existing) {
  console.log('משתמש עם הטלפון הזה כבר קיים. לא נוצר כפול.');
} else {
  const pinHash = bcrypt.hashSync(pin, 10);
  const info = db.prepare(`
    INSERT INTO users (full_name, phone, pin_hash, role) VALUES (?, ?, ?, 'super_admin')
  `).run(name, phone, pinHash);
  console.log(`נוצר מנהל-על: ${name} | טלפון: ${phone} | קוד אישי: ${pin} (משתמש #${info.lastInsertRowid})`);
}

let division = db.prepare('SELECT * FROM divisions WHERE name = ?').get('אגף ראשי');
if (!division) {
  const d = db.prepare('INSERT INTO divisions (name) VALUES (?)').run('אגף ראשי');
  division = { id: d.lastInsertRowid };
  console.log('נוצר אגף לדוגמה: אגף ראשי');
}

const sampleCode = 'START' + nanoid(4).toUpperCase();
db.prepare(`
  INSERT INTO invite_codes (code, division_id, role_to_grant, active) VALUES (?, ?, 'activist', 1)
`).run(sampleCode, division.id);
console.log(`קוד הצטרפות לדוגמה לפעילים: ${sampleCode}`);

const taskCount = db.prepare('SELECT COUNT(*) c FROM tasks').get().c;
if (taskCount === 0) {
  db.prepare(`
    INSERT INTO tasks (title, description, task_type, points, max_completions_per_user, proof_type, est_minutes, difficulty, requires_admin_approval)
    VALUES (?,?,?,?,?,?,?,?,1)
  `).run(
    'שתפו את הפוסט האחרון',
    'היכנסו לעמוד הפייסבוק/אינסטגרם הרשמי, שתפו את הפוסט המוצמד, וצלמו מסך שמראה שהשיתוף בוצע.',
    'digital', 10, 3, 'screenshot', 3, 'easy'
  );
  console.log('נוצרה משימת דוגמה ראשונה.');
}

console.log('\nהכל מוכן. אפשר להריץ npm start ולהתחבר.');
