require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');

const { loadUser, requireAuth } = require('./middleware/auth');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));
app.use(express.static(path.join(__dirname, 'public')));

const dataDir = path.dirname(process.env.DB_PATH || path.join(__dirname, 'data', 'app.db'));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// זריעה אוטומטית של מנהל-על ראשון אם עדיין אין (נוח לאחר פריסה לאירוח, בלי גישה לטרמינל)
require('./lib/autoSeed')();

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret-before-going-live',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }, // חודש - כך שהכניסה החוזרת פשוטה
}));

app.use(loadUser);

// שם המערכת ניתן להחלפה במקום אחד
app.use((req, res, next) => {
  res.locals.appName = process.env.APP_NAME || 'כן. סמוטריץ׳';
  res.locals.orgName = process.env.ORG_NAME || 'צעירי הציונות הדתית';
  next();
});

app.get('/', (req, res) => res.redirect(req.user ? '/home' : '/welcome'));
app.get('/welcome', (req, res) => {
  if (req.user) return res.redirect('/home');
  res.render('welcome');
});

app.use('/', require('./routes/auth'));

app.use(requireAuth);
app.use('/', require('./routes/app'));
app.use('/', require('./routes/admin'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'הדף לא נמצא', message: 'העמוד שחיפשת לא קיים.' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`השרת רץ על פורט ${PORT}`));
