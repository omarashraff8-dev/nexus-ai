// NEXUS AI — Backend server (Node.js + built-in SQLite, zero external deps)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { initDb, getDb, q, one, run, hashPassword, verifyPassword } = require('./db');
const { classifyComplaint, answerQuestion, buildInsights, generateSummary } = require('./ai');

initDb();

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

// ---------- helpers ----------
function send(res, status, obj, headers = {}) {
  const body = obj === null || obj === undefined ? '' : (Buffer.isBuffer(obj) ? obj : JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': Buffer.isBuffer(obj) ? (headers['Content-Type'] || 'application/octet-stream') : 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'same-origin',
    ...headers,
  });
  res.end(body);
}
const ok = (res, data, status = 200) => send(res, status, { ok: true, data });
const fail = (res, status, error) => send(res, status, { ok: false, error });

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('الملف أكبر من الحد المسموح (12MB)')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
async function parseJson(req) { const raw = await readBody(req); try { return raw ? JSON.parse(raw) : {}; } catch { const e = new Error('JSON غير صالح'); e.statusCode = 400; throw e; } }
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function publicUser(u) {
  if (!u) return null;
  const dept = u.department_id ? one('SELECT name FROM departments WHERE id = ?', [u.department_id]) : null;
  return { id: u.id, name: u.name, email: u.email, role: u.role, department_id: u.department_id, department_name: dept ? dept.name : null, student_code: u.student_code, phone: u.phone, active: !!u.active, last_login: u.last_login, created_at: u.created_at };
}
function getSessionUser(req) {
  const token = parseCookies(req)['nexus_session'];
  if (!token) return null;
  const s = one('SELECT * FROM sessions WHERE token = ?', [token]);
  if (!s) return null;
  if (new Date(String(s.expires_at).replace(' ', 'T') + 'Z') < new Date()) { run('DELETE FROM sessions WHERE token = ?', [token]); return null; }
  const u = one('SELECT * FROM users WHERE id = ? AND active = 1', [s.user_id]);
  return u ? { user: u, token } : null;
}
function requireAuth(req, res) {
  const session = getSessionUser(req);
  if (!session) { fail(res, 401, 'سجل الدخول أولًا'); return null; }
  return session;
}
function requireRole(req, res, roles) {
  const session = requireAuth(req, res); if (!session) return null;
  if (!roles.includes(session.user.role)) { fail(res, 403, 'ليس لديك صلاحية لهذا الإجراء'); return null; }
  return session;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  run('INSERT INTO sessions(token, user_id, expires_at) VALUES (?,?,datetime(\'now\',\'+7 days\'))', [token, userId]);
  return `nexus_session=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${7 * 24 * 3600}`;
}
function notify(userId, title, body, refType, refId) {
  try { run('INSERT INTO notifications(user_id, title, body, ref_type, ref_id) VALUES (?,?,?,?,?)', [userId, title, body || null, refType || null, refId || null]); } catch (e) { console.error('notify failed', e.message); }
}
function logUpdate(complaintId, userId, action, details) {
  run('INSERT INTO complaint_updates(complaint_id, user_id, action, details) VALUES (?,?,?,?)', [complaintId, userId, action, details || null]);
}
function canSeeComplaint(user, c) {
  if (!c) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'student') return c.student_id === user.id;
  return c.department_id === user.department_id || c.assigned_to === user.id; // staff
}
function loadComplaint(id) {
  return one(`SELECT c.*, ct.name AS type_name, d.name AS department_name,
              s.name AS student_name, s.student_code, s.email AS student_email,
              a.name AS assigned_name FROM complaints c
              LEFT JOIN complaint_types ct ON ct.id = c.type_id
              JOIN departments d ON d.id = c.department_id
              JOIN users s ON s.id = c.student_id
              LEFT JOIN users a ON a.id = c.assigned_to WHERE c.id = ?`, [id]);
}
const STATUS_LABEL = { new: 'جديدة', in_progress: 'قيد المراجعة', resolved: 'تم الحل', rejected: 'مرفوضة' };

// rate limit بسيط لمحاولات الدخول
const loginAttempts = new Map();
function loginRateLimited(ip) {
  const now = Date.now(); const rec = loginAttempts.get(ip) || [];
  const recent = rec.filter(t => now - t < 60_000); loginAttempts.set(ip, recent);
  return recent.length >= 8;
}
function noteLoginAttempt(ip) { const rec = loginAttempts.get(ip) || []; rec.push(Date.now()); loginAttempts.set(ip, rec); }

// ---------- router ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, m => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, regex, keys, handler });
};

// ===== Auth =====
route('POST', '/api/auth/register', async (req, res) => {
  const { name, email, password, phone, student_code } = await parseJson(req);
  if (!name || !email || !password) return fail(res, 400, 'الاسم والبريد وكلمة المرور مطلوبة');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'صيغة البريد غير صحيحة');
  if (String(password).length < 6) return fail(res, 400, 'كلمة المرور 6 أحرف على الأقل');
  if (one('SELECT id FROM users WHERE email = ?', [String(email).toLowerCase()])) return fail(res, 409, 'البريد مستخدم بالفعل');
  const { salt, hash } = hashPassword(password);
  const info = run('INSERT INTO users(name, email, password_hash, salt, role, student_code, phone) VALUES (?,?,?,?,\'student\',?,?)',
    [name.trim(), String(email).toLowerCase().trim(), hash, salt, student_code || null, phone || null]);
  const cookie = createSession(res, info.lastInsertRowid);
  send(res, 201, { ok: true, data: { user: publicUser(one('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid])) } }, { 'Set-Cookie': cookie });
});

route('POST', '/api/auth/login', async (req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  if (loginRateLimited(ip)) return fail(res, 429, 'محاولات كثيرة. انتظر دقيقة وحاول تاني.');
  const { email, password } = await parseJson(req);
  if (!email || !password) { noteLoginAttempt(ip); return fail(res, 400, 'البريد وكلمة المرور مطلوبان'); }
  const u = one('SELECT * FROM users WHERE email = ?', [String(email).toLowerCase().trim()]);
  if (!u || !verifyPassword(password, u.salt, u.password_hash)) { noteLoginAttempt(ip); return fail(res, 401, 'البريد أو كلمة المرور غير صحيحة'); }
  if (!u.active) return fail(res, 403, 'الحساب موقوف. تواصل مع الإدارة.');
  run('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?', [u.id]);
  loginAttempts.delete(ip);
  const cookie = createSession(res, u.id);
  send(res, 200, { ok: true, data: { user: publicUser(u) } }, { 'Set-Cookie': cookie });
});

route('POST', '/api/auth/logout', async (req, res) => {
  const session = getSessionUser(req);
  if (session) run('DELETE FROM sessions WHERE token = ?', [session.token]);
  send(res, 200, { ok: true, data: null }, { 'Set-Cookie': 'nexus_session=; HttpOnly; Path=/; Max-Age=0' });
});

route('GET', '/api/auth/me', async (req, res) => {
  const session = requireAuth(req, res); if (!session) return;
  ok(res, { user: publicUser(session.user) });
});

// ===== Public-ish lookups (authed) =====
route('GET', '/api/departments', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  ok(res, q(`SELECT d.*, (SELECT COUNT(*) FROM complaints c WHERE c.department_id = d.id) AS complaints_count FROM departments d ORDER BY d.id`));
});
route('GET', '/api/complaint-types', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  ok(res, q('SELECT ct.*, d.name AS department_name FROM complaint_types ct JOIN departments d ON d.id = ct.department_id ORDER BY d.id, ct.id'));
});

// ===== Uploads (attachments) =====
route('POST', '/api/upload', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  const { filename, dataBase64 } = await parseJson(req);
  if (!filename || !dataBase64) return fail(res, 400, 'الملف غير مكتمل');
  const ext = path.extname(String(filename)).toLowerCase();
  const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf', '.doc', '.docx'];
  if (!allowed.includes(ext)) return fail(res, 400, 'نوع الملف غير مسموح (صور أو PDF فقط)');
  const buf = Buffer.from(String(dataBase64).split(',').pop(), 'base64');
  if (buf.length > 8 * 1024 * 1024) return fail(res, 400, 'الحد الأقصى لحجم الملف 8MB');
  const safe = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, safe), buf);
  ok(res, { url: `/uploads/${safe}`, name: path.basename(String(filename)) });
});

// ===== Complaints =====
route('POST', '/api/complaints', async (req, res) => {
  const s = requireRole(req, res, ['student']); if (!s) return;
  const { title, details, type_id, department_id, priority, attachment } = await parseJson(req);
  if (!title || !details || String(title).trim().length < 5 || String(details).trim().length < 10)
    return fail(res, 400, 'اكتب عنوان (5 أحرف+) وتفاصيل (10 أحرف+) للشكوى');

  const cls = classifyComplaint(`${title} ${details}`);
  let deptId = Number(department_id) || cls.department_id;
  if (!one('SELECT id FROM departments WHERE id = ?', [deptId])) deptId = cls.department_id;
  let typeId = Number(type_id) || null;
  if (typeId && !one('SELECT id FROM complaint_types WHERE id = ?', [typeId])) typeId = null;
  const finalPriority = ['low', 'medium', 'high', 'urgent'].includes(priority) ? priority : cls.priority;

  const year = new Date().getFullYear();
  const seq = String((one('SELECT COUNT(*) AS c FROM complaints') || { c: 0 }).c + 1).padStart(4, '0');
  const ticketNo = `NX-${year}-${seq}`;

  const info = run(`INSERT INTO complaints(ticket_no, student_id, type_id, department_id, title, details, attachment, status, priority, ai_category, ai_confidence)
                    VALUES (?,?,?,?,?,?,?,'new',?,?,?)`,
    [ticketNo, s.user.id, typeId, deptId, String(title).trim(), String(details).trim(), attachment || null, finalPriority, cls.category, cls.confidence]);
  const cid = info.lastInsertRowid;
  logUpdate(cid, s.user.id, 'created', 'تم إنشاء الشكوى وتصنيفها تلقائيًا بواسطة NEXUS AI');

  // إشعار لكل موظفي القسم المختص
  const staffList = q('SELECT id FROM users WHERE role = \'staff\' AND department_id = ? AND active = 1', [deptId]);
  for (const st of staffList) notify(st.id, 'شكوى جديدة وصلت لقسمه', `${ticketNo} — ${String(title).trim()}`, 'complaint', cid);

  ok(res, { complaint: loadComplaint(cid), ai: cls }, 201);
});

route('GET', '/api/complaints', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  const url = new URL(req.url, 'http://x');
  const status = url.searchParams.get('status');
  const priority = url.searchParams.get('priority');
  const dept = url.searchParams.get('department');
  const qstr = (url.searchParams.get('q') || '').trim();
  const from = url.searchParams.get('from'); const to = url.searchParams.get('to');

  let sql = `SELECT c.*, ct.name AS type_name, d.name AS department_name, st.name AS student_name, st.student_code, a.name AS assigned_name
             FROM complaints c JOIN departments d ON d.id = c.department_id JOIN users st ON st.id = c.student_id
             LEFT JOIN complaint_types ct ON ct.id = c.type_id LEFT JOIN users a ON a.id = c.assigned_to WHERE 1=1`;
  const params = [];
  if (s.user.role === 'student') { sql += ' AND c.student_id = ?'; params.push(s.user.id); }
  else if (s.user.role === 'staff') { sql += ' AND (c.department_id = ? OR c.assigned_to = ?)'; params.push(s.user.department_id, s.user.id); }
  if (status) { sql += ' AND c.status = ?'; params.push(status); }
  if (priority) { sql += ' AND c.priority = ?'; params.push(priority); }
  if (dept && s.user.role === 'admin') { sql += ' AND c.department_id = ?'; params.push(Number(dept)); }
  if (qstr) { sql += ' AND (c.title LIKE ? OR c.details LIKE ? OR c.ticket_no LIKE ? OR st.name LIKE ?)'; const like = `%${qstr}%`; params.push(like, like, like, like); }
  if (from) { sql += " AND c.created_at >= ?"; params.push(`${from} 00:00:00`); }
  if (to) { sql += " AND c.created_at <= ?"; params.push(`${to} 23:59:59`); }
  sql += ' ORDER BY CASE c.priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, c.created_at DESC LIMIT 500';
  ok(res, q(sql, params));
});

route('GET', '/api/complaints/:id', async (req, res, p) => {
  const s = requireAuth(req, res); if (!s) return;
  const c = loadComplaint(Number(p.id));
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (!canSeeComplaint(s.user, c)) return fail(res, 403, 'لا تملك صلاحية مشاهدة هذه الشكوى');
  const internalAllowed = s.user.role !== 'student';
  const messages = q(`SELECT m.*, u.name AS sender_name, u.role AS sender_role FROM messages m JOIN users u ON u.id = m.sender_id
                      WHERE m.complaint_id = ? ${internalAllowed ? '' : 'AND m.is_internal = 0'} ORDER BY m.created_at ASC`, [c.id]);
  const updates = q(`SELECT u2.*, u.name AS user_name, u.role AS user_role FROM complaint_updates u2 LEFT JOIN users u ON u.id = u2.user_id
                     WHERE u2.complaint_id = ? ORDER BY u2.created_at ASC`, [c.id]);
  ok(res, { complaint: c, messages, updates });
});

route('POST', '/api/complaints/:id/status', async (req, res, p) => {
  const s = requireRole(req, res, ['staff', 'admin']); if (!s) return;
  const { status } = await parseJson(req);
  if (!['new', 'in_progress', 'resolved', 'rejected'].includes(status)) return fail(res, 400, 'حالة غير صالحة');
  const c = one('SELECT * FROM complaints WHERE id = ?', [p.id]);
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (!canSeeComplaint(s.user, c)) return fail(res, 403, 'ليست ضمن نطاقك');
  const resolvedAt = status === 'resolved' ? 'datetime(\'now\')' : 'NULL';
  run(`UPDATE complaints SET status = ?, updated_at = datetime('now'), resolved_at = ${resolvedAt} WHERE id = ?`, [status, c.id]);
  logUpdate(c.id, s.user.id, 'status', `تم تغيير الحالة إلى: ${STATUS_LABEL[status]}`);
  notify(c.student_id, status === 'resolved' ? 'تم حل شكواك 🎉' : 'تحديث على شكواك', `${c.ticket_no} — الحالة أصبحت: ${STATUS_LABEL[status]}`, 'complaint', c.id);
  ok(res, { complaint: loadComplaint(c.id) });
});

route('POST', '/api/complaints/:id/assign', async (req, res, p) => {
  const s = requireRole(req, res, ['staff', 'admin']); if (!s) return;
  const { assigned_to } = await parseJson(req);
  const c = one('SELECT * FROM complaints WHERE id = ?', [p.id]);
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (!canSeeComplaint(s.user, c)) return fail(res, 403, 'ليست ضمن نطاقك');
  let targetId = Number(assigned_to);
  if (s.user.role === 'staff') {
    if (targetId && targetId !== s.user.id) return fail(res, 403, 'الموظف يمكنه الإسناد لنفسه فقط');
    targetId = s.user.id;
  }
  const target = one('SELECT * FROM users WHERE id = ? AND role IN (\'staff\',\'admin\') AND active = 1', [targetId]);
  if (!target) return fail(res, 400, 'الموظف غير موجود');
  run('UPDATE complaints SET assigned_to = ?, department_id = COALESCE(?, department_id), updated_at = datetime(\'now\') WHERE id = ?', [targetId, target.department_id, c.id]);
  logUpdate(c.id, s.user.id, 'assigned', `تم إسناد الشكوى إلى ${target.name}`);
  if (targetId !== s.user.id) notify(targetId, 'شكوى أُسندت إليك', `${c.ticket_no} — ${c.title}`, 'complaint', c.id);
  ok(res, { complaint: loadComplaint(c.id) });
});

route('POST', '/api/complaints/:id/transfer', async (req, res, p) => {
  const s = requireRole(req, res, ['staff', 'admin']); if (!s) return;
  const { department_id, assigned_to, reason } = await parseJson(req);
  const c = one('SELECT * FROM complaints WHERE id = ?', [p.id]);
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (!canSeeComplaint(s.user, c)) return fail(res, 403, 'ليست ضمن نطاقك');
  const newDept = Number(department_id);
  if (!newDept || !one('SELECT id FROM departments WHERE id = ?', [newDept])) return fail(res, 400, 'القسم غير صحيح');
  const newAssignee = assigned_to ? Number(assigned_to) : null;
  if (newAssignee && !one('SELECT id FROM users WHERE id = ? AND role IN (\'staff\',\'admin\')', [newAssignee])) return fail(res, 400, 'الموظف غير موجود');
  run('UPDATE complaints SET department_id = ?, assigned_to = ?, updated_at = datetime(\'now\') WHERE id = ?', [newDept, newAssignee, c.id]);
  const dept = one('SELECT name FROM departments WHERE id = ?', [newDept]);
  logUpdate(c.id, s.user.id, 'transfer', `تم التحويل إلى قسم ${dept.name}${reason ? ' — السبب: ' + reason : ''}`);
  for (const st of q('SELECT id FROM users WHERE role=\'staff\' AND department_id = ? AND active = 1', [newDept])) notify(st.id, 'شكوى محوّلة إليكم', `${c.ticket_no} — ${c.title}`, 'complaint', c.id);
  notify(c.student_id, 'تم تحويل شكواك للقسم المختص', `${c.ticket_no} — أصبحت لدى قسم ${dept.name}`, 'complaint', c.id);
  ok(res, { complaint: loadComplaint(c.id) });
});

route('POST', '/api/complaints/:id/messages', async (req, res, p) => {
  const s = requireAuth(req, res); if (!s) return;
  const { body, is_internal } = await parseJson(req);
  if (!body || String(body).trim().length < 2) return fail(res, 400, 'الرسالة قصيرة جدًا');
  const c = one('SELECT * FROM complaints WHERE id = ?', [p.id]);
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (!canSeeComplaint(s.user, c)) return fail(res, 403, 'لا تملك صلاحية');
  const internal = !!is_internal;
  if (internal && s.user.role === 'student') return fail(res, 403, 'الطالب لا يضيف ملاحظات داخلية');
  run('INSERT INTO messages(complaint_id, sender_id, body, is_internal) VALUES (?,?,?,?)', [c.id, s.user.id, String(body).trim(), internal ? 1 : 0]);
  run('UPDATE complaints SET updated_at = datetime(\'now\') WHERE id = ?', [c.id]);
  if (!internal) {
    if (s.user.role === 'student') {
      const targets = c.assigned_to ? [c.assigned_to] : q('SELECT id FROM users WHERE role=\'staff\' AND department_id = ? AND active = 1', [c.department_id]).map(r => r.id);
      for (const t of targets) notify(t, 'رسالة جديدة من الطالب', `${c.ticket_no} — ${String(body).trim().slice(0, 80)}`, 'complaint', c.id);
    } else {
      notify(c.student_id, 'رد جديد على شكواك', `${c.ticket_no} — ${String(body).trim().slice(0, 80)}`, 'complaint', c.id);
    }
  }
  ok(res, { ok: true });
});

route('POST', '/api/complaints/:id/request-info', async (req, res, p) => {
  const s = requireRole(req, res, ['staff', 'admin']); if (!s) return;
  const { message } = await parseJson(req);
  const c = one('SELECT * FROM complaints WHERE id = ?', [p.id]);
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (!canSeeComplaint(s.user, c)) return fail(res, 403, 'ليست ضمن نطاقك');
  const body = String(message || 'برجاء تزويدنا بمعلومات إضافية عن الطلب').trim();
  run('INSERT INTO messages(complaint_id, sender_id, body, is_internal) VALUES (?,?,?,0)', [c.id, s.user.id, `📌 طلب معلومات إضافية: ${body}`]);
  logUpdate(c.id, s.user.id, 'request_info', body);
  notify(c.student_id, 'الإدارة طلبت معلومات إضافية', `${c.ticket_no} — ${body.slice(0, 100)}`, 'complaint', c.id);
  ok(res, { ok: true });
});

route('POST', '/api/complaints/:id/rate', async (req, res, p) => {
  const s = requireRole(req, res, ['student']); if (!s) return;
  const { rating } = await parseJson(req);
  const r = Number(rating);
  if (!(r >= 1 && r <= 5)) return fail(res, 400, 'التقييم من 1 إلى 5');
  const c = one('SELECT * FROM complaints WHERE id = ? AND student_id = ?', [p.id, s.user.id]);
  if (!c) return fail(res, 404, 'الشكوى غير موجودة');
  if (c.status !== 'resolved') return fail(res, 400, 'لا يمكن التقييم قبل الحل');
  run('UPDATE complaints SET rating = ? WHERE id = ?', [r, c.id]);
  ok(res, { complaint: loadComplaint(c.id) });
});

// ===== Notifications =====
route('GET', '/api/notifications', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  const url = new URL(req.url, 'http://x');
  const limit = Math.min(Number(url.searchParams.get('limit')) || 30, 100);
  const unreadOnly = url.searchParams.get('unread') === '1';
  ok(res, q(`SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read = 0' : ''} ORDER BY created_at DESC LIMIT ?`, [s.user.id, limit]));
});
route('GET', '/api/notifications/count', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  ok(res, { count: one('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0', [s.user.id]).c });
});
route('POST', '/api/notifications/:id/read', async (req, res, p) => {
  const s = requireAuth(req, res); if (!s) return;
  run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [p.id, s.user.id]);
  ok(res, { ok: true });
});
route('POST', '/api/notifications/read-all', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  run('UPDATE notifications SET read = 1 WHERE user_id = ?', [s.user.id]);
  ok(res, { ok: true });
});

// ===== AI =====
route('POST', '/api/ai/classify', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  const { text } = await parseJson(req);
  if (!text || String(text).trim().length < 5) return fail(res, 400, 'اكتب تفاصيل أكثر للتحليل');
  ok(res, classifyComplaint(text));
});

route('POST', '/api/ai/chat', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  const { message, complaint_id } = await parseJson(req);
  const msg = String(message || '').trim();
  if (msg.length < 3) return fail(res, 400, 'اكتب سؤالك');
  run('INSERT INTO ai_conversations(user_id, complaint_id, role, message) VALUES (?,?,\'user\',?)', [s.user.id, complaint_id || null, msg]);
  const { answer, sources, grounded } = answerQuestion(msg);
  run('INSERT INTO ai_conversations(user_id, complaint_id, role, message) VALUES (?,?,\'assistant\',?)', [s.user.id, complaint_id || null, answer]);
  ok(res, { answer, sources, grounded });
});

route('GET', '/api/ai/conversations', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  ok(res, q('SELECT * FROM ai_conversations WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 40', [s.user.id]).reverse());
});

// ===== Stats (role-aware) =====
route('GET', '/api/stats', async (req, res) => {
  const s = requireAuth(req, res); if (!s) return;
  const u = s.user;
  if (u.role === 'student') {
    const rows = q('SELECT status, COUNT(*) c FROM complaints WHERE student_id = ? GROUP BY status', [u.id]);
    const by = Object.fromEntries(rows.map(r => [r.status, r.c]));
    const recent = q('SELECT id, ticket_no, title, status, priority, created_at FROM complaints WHERE student_id = ? ORDER BY created_at DESC LIMIT 5', [u.id]);
    ok(res, { total: rows.reduce((a, r) => a + r.c, 0), new: by.new || 0, in_progress: by.in_progress || 0, resolved: by.resolved || 0, rejected: by.rejected || 0, recent });
  } else if (u.role === 'staff') {
    const scope = '(department_id = ? OR assigned_to = ?)';
    const mine = one(`SELECT COUNT(*) c FROM complaints WHERE ${scope} AND assigned_to = ? AND status IN ('new','in_progress')`, [u.department_id, u.id, u.id]).c;
    const open = one(`SELECT COUNT(*) c FROM complaints WHERE ${scope} AND status IN ('new','in_progress')`, [u.department_id, u.id]).c;
    const resolvedWeek = one(`SELECT COUNT(*) c FROM complaints WHERE ${scope} AND status='resolved' AND resolved_at >= datetime('now','-7 days')`, [u.department_id, u.id]).c;
    const resolvedTotal = one(`SELECT COUNT(*) c FROM complaints WHERE ${scope} AND status='resolved'`, [u.department_id, u.id]).c;
    const avg = one(`SELECT AVG((julianday(resolved_at) - julianday(created_at)) * 24) h FROM complaints WHERE ${scope} AND status='resolved' AND resolved_at IS NOT NULL`, [u.department_id, u.id]);
    const ratings = one(`SELECT AVG(rating) r FROM complaints WHERE ${scope} AND rating IS NOT NULL`, [u.department_id, u.id]);
    ok(res, { assigned_to_me: mine, open, resolved_week: resolvedWeek, resolved_total: resolvedTotal, avg_resolution_hours: avg && avg.h ? Math.round(avg.h) : 0, satisfaction: ratings && ratings.r ? Math.round(ratings.r * 20) : null });
  } else {
    ok(res, buildInsights());
  }
});

// ===== Admin: users / departments / types =====
route('GET', '/api/admin/users', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const url = new URL(req.url, 'http://x');
  const role = url.searchParams.get('role');
  let sql = `SELECT u.*, d.name AS department_name FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE 1=1`;
  const params = [];
  if (role) { sql += ' AND u.role = ?'; params.push(role); }
  sql += ' ORDER BY u.role, u.name';
  ok(res, q(sql, params).map(publicUser));
});
route('POST', '/api/admin/users', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const { name, email, password, role, department_id, phone, student_code } = await parseJson(req);
  if (!name || !email || !password || !role) return fail(res, 400, 'الاسم والبريد وكلمة المرور والدور مطلوبة');
  if (!['student', 'staff', 'admin'].includes(role)) return fail(res, 400, 'دور غير صالح');
  if (String(password).length < 6) return fail(res, 400, 'كلمة المرور 6 أحرف على الأقل');
  if (role === 'staff' && !department_id) return fail(res, 400, 'الموظف لازم يكون له قسم');
  if (one('SELECT id FROM users WHERE email = ?', [String(email).toLowerCase().trim()])) return fail(res, 409, 'البريد مستخدم بالفعل');
  const { salt, hash } = hashPassword(password);
  const info = run('INSERT INTO users(name, email, password_hash, salt, role, department_id, phone, student_code) VALUES (?,?,?,?,?,?,?,?)',
    [name.trim(), String(email).toLowerCase().trim(), hash, salt, role, department_id || null, phone || null, student_code || null]);
  ok(res, publicUser(one('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid])), 201);
});
route('PUT', '/api/admin/users/:id', async (req, res, p) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const target = one('SELECT * FROM users WHERE id = ?', [p.id]);
  if (!target) return fail(res, 404, 'المستخدم غير موجود');
  const { name, email, phone, role, department_id, active, password } = await parseJson(req);
  if (Number(p.id) === s.user.id && active === false) return fail(res, 400, 'لا يمكن إيقاف حسابك الحالي');
  if (target.role === 'admin' && role && role !== 'admin' && one('SELECT COUNT(*) c FROM users WHERE role=\'admin\'').c <= 1) return fail(res, 400, 'لا يمكن إزالة آخر مدير بالنظام');
  run('UPDATE users SET name = COALESCE(?,name), email = COALESCE(?,email), phone = COALESCE(?,phone), role = COALESCE(?,role), department_id = ?, active = COALESCE(?,active) WHERE id = ?',
    [name || null, email ? String(email).toLowerCase().trim() : null, phone ?? null, role || null, department_id === undefined ? target.department_id : (department_id || null), active === undefined ? target.active : (active ? 1 : 0), target.id]);
  if (password && String(password).length >= 6) { const { salt, hash } = hashPassword(password); run('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?', [hash, salt, target.id]); }
  run('DELETE FROM sessions WHERE user_id = ? AND (SELECT active FROM users WHERE id = ?) = 0', [target.id, target.id]);
  ok(res, publicUser(one('SELECT * FROM users WHERE id = ?', [target.id])));
});
route('DELETE', '/api/admin/users/:id', async (req, res, p) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const target = one('SELECT * FROM users WHERE id = ?', [p.id]);
  if (!target) return fail(res, 404, 'المستخدم غير موجود');
  if (target.id === s.user.id) return fail(res, 400, 'لا يمكن حذف حسابك الحالي');
  if (target.role === 'admin' && one('SELECT COUNT(*) c FROM users WHERE role=\'admin\'').c <= 1) return fail(res, 400, 'لا يمكن حذف آخر مدير بالنظام');
  run('DELETE FROM notifications WHERE user_id = ?', [target.id]);
  run('DELETE FROM sessions WHERE user_id = ?', [target.id]);
  run('UPDATE complaints SET assigned_to = NULL WHERE assigned_to = ?', [target.id]);
  run('DELETE FROM users WHERE id = ?', [target.id]);
  ok(res, { deleted: target.id });
});
route('POST', '/api/admin/departments', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const { name, description, sla_hours } = await parseJson(req);
  if (!name) return fail(res, 400, 'اسم القسم مطلوب');
  const info = run('INSERT INTO departments(name, description, sla_hours) VALUES (?,?,?)', [String(name).trim(), description || null, Number(sla_hours) || 48]);
  ok(res, one('SELECT * FROM departments WHERE id = ?', [info.lastInsertRowid]), 201);
});
route('PUT', '/api/admin/departments/:id', async (req, res, p) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const d = one('SELECT * FROM departments WHERE id = ?', [p.id]);
  if (!d) return fail(res, 404, 'القسم غير موجود');
  const { name, description, sla_hours } = await parseJson(req);
  run('UPDATE departments SET name = COALESCE(?,name), description = COALESCE(?,description), sla_hours = COALESCE(?,sla_hours) WHERE id = ?',
    [name || null, description ?? null, sla_hours ? Number(sla_hours) : null, d.id]);
  ok(res, one('SELECT * FROM departments WHERE id = ?', [d.id]));
});
route('DELETE', '/api/admin/departments/:id', async (req, res, p) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const used = one('SELECT COUNT(*) c FROM complaints WHERE department_id = ?', [p.id]).c;
  if (used > 0) return fail(res, 400, 'لا يمكن حذف قسم عليه شكاوى — انقلها أولًا');
  run('DELETE FROM complaint_types WHERE department_id = ?', [p.id]);
  run('UPDATE users SET department_id = NULL WHERE department_id = ?', [p.id]);
  run('DELETE FROM departments WHERE id = ?', [p.id]);
  ok(res, { deleted: Number(p.id) });
});
route('POST', '/api/admin/complaint-types', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const { name, department_id, keywords } = await parseJson(req);
  if (!name || !department_id) return fail(res, 400, 'الاسم والقسم مطلوبان');
  const info = run('INSERT INTO complaint_types(name, department_id, keywords) VALUES (?,?,?)', [String(name).trim(), Number(department_id), keywords || '']);
  ok(res, one('SELECT * FROM complaint_types WHERE id = ?', [info.lastInsertRowid]), 201);
});
route('DELETE', '/api/admin/complaint-types/:id', async (req, res, p) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  run('UPDATE complaints SET type_id = NULL WHERE type_id = ?', [p.id]);
  run('DELETE FROM complaint_types WHERE id = ?', [p.id]);
  ok(res, { deleted: Number(p.id) });
});

// ===== Admin: insights / AI summary / reports / export =====
route('GET', '/api/admin/insights', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  ok(res, buildInsights());
});
route('POST', '/api/admin/summary', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const { summary, insights, generatedAt } = generateSummary();
  const info = run('INSERT INTO reports(admin_id, title, summary, period) VALUES (?,?,?,?)', [s.user.id, `ملخص ذكي — ${generatedAt}`, summary, generatedAt]);
  ok(res, { id: info.lastInsertRowid, summary, insights, generatedAt });
});
route('GET', '/api/admin/reports', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  ok(res, q('SELECT r.*, u.name AS admin_name FROM reports r LEFT JOIN users u ON u.id = r.admin_id ORDER BY r.created_at DESC LIMIT 20'));
});
route('GET', '/api/admin/reports.csv', async (req, res) => {
  const s = requireRole(req, res, ['admin']); if (!s) return;
  const url = new URL(req.url, 'http://x');
  const from = url.searchParams.get('from'), to = url.searchParams.get('to');
  let sql = `SELECT c.ticket_no, st.name AS student, d.name AS department, ct.name AS type, c.title, c.priority, c.status, c.created_at, c.resolved_at
             FROM complaints c JOIN departments d ON d.id = c.department_id JOIN users st ON st.id = c.student_id LEFT JOIN complaint_types ct ON ct.id = c.type_id WHERE 1=1`;
  const params = [];
  if (from) { sql += ' AND c.created_at >= ?'; params.push(`${from} 00:00:00`); }
  if (to) { sql += ' AND c.created_at <= ?'; params.push(`${to} 23:59:59`); }
  sql += ' ORDER BY c.created_at DESC';
  const rows = q(sql, params);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['رقم الشكوى', 'اسم الطالب', 'القسم', 'نوع الشكوى', 'العنوان', 'الأولوية', 'الحالة', 'تاريخ الإنشاء', 'تاريخ الحل'];
  const csv = '\uFEFF' + [head.map(esc).join(',')].concat(rows.map(r => [r.ticket_no, r.student, r.department, r.type, r.title, r.priority, STATUS_LABEL[r.status] || r.status, r.created_at, r.resolved_at || ''].map(esc).join(','))).join('\r\n');
  send(res, 200, Buffer.from(csv, 'utf8'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="nexus-ai-report.csv"' });
});

// ===== Static files =====
function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) return fail(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { ok: false, error: 'الصفحة غير موجودة' });
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);

    // مرفقات الشكاوى: تتطلب تسجيل دخول + عضوية في الشكوى نفسها
    if (pathname.startsWith('/uploads/')) {
      const session = requireAuth(req, res); if (!session) return;
      const filename = path.basename(pathname);
      const c = one('SELECT * FROM complaints WHERE attachment = ?', [`/uploads/${filename}`]);
      if (!c || !canSeeComplaint(session.user, c)) return fail(res, 403, 'غير مسموح');
      const file = path.join(UPLOADS_DIR, filename);
      return fs.readFile(file, (err, data) => {
        if (err) return fail(res, 404, 'الملف غير موجود');
        send(res, 200, data, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      });
    }

    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.regex.exec(pathname);
      if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return await r.handler(req, res, params);
    }
    if (req.method === 'GET') return serveStatic(req, res, pathname);
    fail(res, 405, 'Method Not Allowed');
  } catch (e) {
    console.error('[error]', e);
    if (!res.headersSent) fail(res, e.statusCode || 500, e.message || 'خطأ داخلي في السيرفر');
  }
});

server.listen(PORT, () => {
  console.log(`NEXUS AI يعمل الآن على http://localhost:${PORT}`);
});
