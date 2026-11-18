// NEXUS AI — Database layer (SQLite, zero external dependencies)
const { DatabaseSync } = require('node:sqlite');
const crypto = require('crypto');
const path = require('path');

const DB_PATH = path.join(__dirname, 'nexus.db');
let db;

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

function initDb() {
  db = new DatabaseSync(DB_PATH);
  db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS departments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    sla_hours INTEGER NOT NULL DEFAULT 48
  );

  CREATE TABLE IF NOT EXISTS complaint_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    department_id INTEGER NOT NULL REFERENCES departments(id),
    keywords TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('student','staff','admin')),
    department_id INTEGER REFERENCES departments(id),
    student_code TEXT,
    phone TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    last_login TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_no TEXT NOT NULL UNIQUE,
    student_id INTEGER NOT NULL REFERENCES users(id),
    type_id INTEGER REFERENCES complaint_types(id),
    department_id INTEGER NOT NULL REFERENCES departments(id),
    assigned_to INTEGER REFERENCES users(id),
    title TEXT NOT NULL,
    details TEXT NOT NULL,
    attachment TEXT,
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','in_progress','resolved','rejected')),
    priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low','medium','high','urgent')),
    ai_category TEXT,
    ai_confidence REAL,
    rating INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE TABLE IF NOT EXISTS complaint_updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    details TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
    sender_id INTEGER NOT NULL REFERENCES users(id),
    body TEXT NOT NULL,
    is_internal INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT,
    ref_type TEXT,
    ref_id INTEGER,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS ai_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    complaint_id INTEGER REFERENCES complaints(id),
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS knowledge_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    source TEXT NOT NULL,
    page INTEGER,
    category TEXT NOT NULL,
    content TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_id INTEGER REFERENCES users(id),
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    period TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_complaints_dept ON complaints(department_id, status);
  CREATE INDEX IF NOT EXISTS idx_complaints_student ON complaints(student_id);
  CREATE INDEX IF NOT EXISTS idx_messages_complaint ON messages(complaint_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read);
  `);

  seed();
  return db;
}

function q(sql, params = []) { return db.prepare(sql).all(...params); }
function one(sql, params = []) { return db.prepare(sql).get(...params) || null; }
function run(sql, params = []) { return db.prepare(sql).run(...params); }

function seed() {
  const hasUsers = one('SELECT COUNT(*) AS c FROM users').c;
  if (hasUsers > 0) return; // already seeded

  const insertDept = (name, description, sla) =>
    run('INSERT INTO departments(name, description, sla_hours) VALUES (?,?,?)', [name, description, sla]).lastInsertRowid;

  const dTaalaat = insertDept('شؤون الطلاب', 'القيد، الشهادات، الكارنيهات، العذر والإجازات، التحويلات', 48);
  const dReg = insertDept('التسجيل والقبول', 'تسجيل المقررات، الجداول، الشعب، إعادة التسجيل', 48);
  const dExams = insertDept('الامتحانات', 'لجان الامتحانات، رصد الدرجات، التظلمات، إعادة الرصد', 24);
  const dFinance = insertDept('الشؤون المالية', 'المصروفات، الرسوم، الأقساط، الإيصالات', 48);
  const dIT = insertDept('تكنولوجيا المعلومات', 'المنصة الإلكترونية، البريد الجامعي، الواي فاي، الدعم الفني', 24);
  const dFacility = insertDept('المرافق والصيانة', 'الكهرباء، التكييف، المياه، المعامل، المباني', 24);
  const dLibrary = insertDept('المكتبة', 'الاستعارة، الكتب، قواعد البحث العلمي', 72);

  const types = [
    ['مشكلة تسجيل مقررات', dReg, 'تسجيل,ماده,مقرر,شعبة,جدول,سحب,اضافه'],
    ['إعادة أو رصد درجات', dExams, 'رصد,درجه,نتيجه,تظلم,استماره,ورقه'],
    ['شكوى مالية / مصروفات', dFinance, 'مصاريف,رسوم,قسط,دفع,ايصال,مالي'],
    ['استخراج شهادة / كارنيه', dTaalaat, 'شهاده,كارنيه,قيد,تاريخ,مستند'],
    ['طلب تحويل أو تأجيل', dTaalaat, 'تحويل,تاجيل,انسحاب,اجازه,عذر'],
    ['عطل في المرافق', dFacility, 'صيانه,تكييف,كهرباء,مياه,معمل,مقعد,باب'],
    ['مشكلة تقنية بالمنصة', dIT, 'المنصه,باسورد,بريد,واي فاي,انترنت,الموقع,دخول,ايميل'],
    ['مشكلة بالمكتبة', dLibrary, 'كتاب,مكتبه,استعاره,مرجع'],
    ['شكوى عامة / أخرى', dTaalaat, ''],
  ];
  const typeId = {};
  for (const [name, dept, kw] of types) {
    typeId[name] = run('INSERT INTO complaint_types(name, department_id, keywords) VALUES (?,?,?)', [name, dept, kw]).lastInsertRowid;
  }

  function addUser(name, email, password, role, dept, code) {
    const { salt, hash } = hashPassword(password);
    return run('INSERT INTO users(name, email, password_hash, salt, role, department_id, student_code) VALUES (?,?,?,?,?,?,?)',
      [name, email, hash, salt, role, dept || null, code || null]).lastInsertRowid;
  }

  const admin = addUser('أ/ سامر عادل', 'admin@nexus.edu', 'admin123', 'admin', null, null);
  const staffTaalaat = addUser('أ/ منى حسن', 'staff@nexus.edu', 'staff123', 'staff', dTaalaat, null);
  const staffIT = addUser('م/ كريم فؤاد', 'staff-it@nexus.edu', 'staff123', 'staff', dIT, null);
  const staffReg = addUser('أ/ هبة رشاد', 'staff-reg@nexus.edu', 'staff123', 'staff', dReg, null);
  const staffExams = addUser('أ/ محمود نجيب', 'staff-exams@nexus.edu', 'staff123', 'staff', dExams, null);
  const studentOmar = addUser('عمر أشرف', 'student@nexus.edu', 'student123', 'student', null, '20230214');
  const studentSara = addUser('سارة محمود', 'student2@nexus.edu', 'student123', 'student', null, '20230215');

  // ---- Knowledge base: لوائح المعهد (تغذي مساعد الذكاء الاصطناعي) ----
  const docs = [
    ['لائحة شئون الطلاب — التحويل بين المعاهد', 'لائحة المعهد العالي للهندسة — إصدار 2025', 45, 'التسجيل',
      'يجوز للطالب المقيد بفرقة أولى أو ثانية التحويل من معهد آخر إلى المعهد بناءً على الأعلى درجة، بشرط قضاء سنة دراسية كاملة بنجاح في الفرقة التي ينتقل منها، ومعادلة المواد التي درسها بلجنة المعادلة المختصة. يتم تقديم طلب التحويل خلال الأسبوعين الأولين من الفصل الدراسي مرفقًا بأصل بيان الدرجات والموافقة من المعهد المحول منه، ويخطر الطالب بالقبول خلال أسبوع من تاريخ تقديم الطلب. لا يجوز التحويل في حالة وجود إنذار أكاديمي أو فصل تأديبي سارٍ.'],
    ['المستندات المطلوبة للتقديم بالمعهد', 'لائحة المعهد العالي للهندسة — إصدار 2025', 12, 'التسجيل',
      'أوراق التقديم: 1) أصل شهادة الثانوية العامة أو ما يعادلها مع 3 صور منها، 2) شهادة ميلاد مميكنة وصورتان، 3) 6 صور شخصية حديثة، 4) أصل الإيصال الدال على سداد مصروفات التقديم، 5) استمارة 2 جند للطلاب الذكور، 6) حافظة مستندات بلاستيكية. يتم فتح ملف الطالب بمجرد استلام المستندات ومراجعتها بمعرفة شؤون الطلاب، ويُمنح كارنيه الطالب بعد قيده بالمعهد ويتجدد كل عام دراسي.'],
    ['إعادة رصد الدرجات والتظلمات', 'قواعد وشروط امتحانات المعهد — إصدار 2025', 78, 'الامتحانات',
      'يحق للطالب التقدم بطلب تظلم من درجة مادة خلال 15 يومًا من إعلان النتيجة بسداد رسم التظلم وقدره 150 جنيهًا عن كل مادة. تفتح لجنة التظلمات الأوراق بمعرفة أستاذ المادة الأصلي وأستاذ آخر من نفس القسم، ويخطر الطالب بالنتيجة خلال أسبوعين. في حالة ثبوت خطأ في الرصد يصحح مجانًا وتُرد إليه قيمة الرسم. أما طلبات إعادة الرصد فتحال مباشرة لإدارة الامتحانات دون رسوم.'],
    ['الغياب ونسبة الحضور المسموح بها', 'لائحة المعهد العالي للهندسة — إصدار 2025', 61, 'الامتحانات',
      'يُشترط لحضور الامتحان التحريري اجتياز نسبة حضور لا تقل عن 75% من محاضرات وتمارين كل مادة، و50% كحد أدنى للمعامل لعدم الحرمان. في حالة التجاوز في الغياب تحال حالة الطالب للجنة المختصة وقد يُحرم من دخول الامتحان في المواد التي تجاوز فيها نسبة الغياب. وفي حالة الغياب لعذر قهري (مرضي أو عائلي) يتقدم الطالب بطلب خلال أسبوع من تاريخ الغياب مرفقًا بالمستندات الدالة، وتقبل أصل التقارير الطبية المعتمدة فقط.'],
    ['المصروفات الدراسية ومواعيد السداد', 'لائحة المعهد العالي للهندسة — إصدار 2025', 90, 'المالية',
      'تسدد المصروفات الدراسية على قسطين: القسط الأول عند القيد بداية الفصل الدراسي الأول وقدره 60% من المصروفات، والقسط الثاني بداية الفصل الدراسي الثاني وقدره 40%. آخر موعد للسداد هو نهاية الأسبوع الثالث من بدء الدراسة، وبعده يُحرم الطالب من دخول الامتحان. يحق للطالب الخاص بمعاش تكافل أو ذوي إعاقة التقدم بطلب إعفاء أو تخفيض خلال الأسبوع الأول، ويرفق بإقرار من جهة عمل الولي أو بحث اجتماعي معتمد.'],
    ['العذر القهري والإجازة المرضية', 'لائحة المعهد العالي للهندسة — إصدار 2025', 52, 'شؤون الطلاب',
      'يقبل العذر القهري لعذر مرضي أو وفاة قريب من الدرجة الأولى في حدود أسبوعين كحد أقصى، ويقدم خلال أسبوع من زوال العذر مرفقًا بأصل الشهادة الطبية أو شهادة الوفاة. تُحسب مدة العذر غيابًا بعذر ولا يُحرم الطالب بسببها من الدخول للامتحان بشرط ألا تتجاوز ضعف نسبة الغياب المسموح بها بدون عذر. وفي حالة تكرار العذر القهري أكثر من مرة في الفصل الواحد تحال الحالة لشؤون الطلاب للنظر فيها.'],
    ['الانسحاب وتأجيل الدراسة', 'لائحة المعهد العالي للهندسة — إصدار 2025', 43, 'شؤون الطلاب',
      'يجوز للطالب المنتظم تأجيل الدراسة لمدة فصل دراسي واحد أو دراسي كامل بعذر قهري يقبله عميد المعهد، على ألا تتجاوز مدة التأجيل الكلية فصلين دراسيين في المرحلة الواحدة. يقدم الطلب خلال أسبوعين من بداية الفصل الدراسي مرفقًا بالمستندات الدالة على العذر، ويتم الاحتفاظ بمقعد الطالب بالمعهد، ولا تحتسب مدة التأجيل ضمن الحد الأقصى للدراسة.'],
    ['الدعم الفني للمنصة الإلكترونية', 'دليل الطالب للمنصة الذكية — إصدار 2026', 8, 'تكنولوجيا المعلومات',
      'يقدم الدعم الفني المساعدة في: استعادة كلمة المرور عبر "نسيت كلمة المرور" على صفحة الدخول، تفعيل البريد الجامعي، مشاكل تسجيل الدخول للمنصة، وأخطاء رفع الواجبات أو المشاريع التي تظهر برسائل باللون الأحمر. في الحالات المستعصية يتواصل الطالب مع مركز الدعم بالإدارة المركزية من 9 صباحًا حتى 4 عصرًا أيام العمل الرسمية عبر نموذج تذكرة داخل المنصة أو على الرقم الداخلي 114.'],
    ['نظام استعارة الكتب من المكتبة', 'لائحة المكتبة المركزية — إصدار 2025', 3, 'المكتبة',
      'يحق لطالب الفرقة الأولى استعارة كتابين كحد أقصى لمدة أسبوع، ويحق لطالب فرق السنة الثانية فأعلى استعارة 4 كتب لمدة أسبوعين قابلة للتجديد مرة واحدة في حالة عدم وجود طلب عليها. تقرر غرامة تأخير 5 جنيهات عن كل كتاب عن كل يوم تأخير، وتمنع الاستعارة من لا يسدد الغرامات. ولا يجوز استعارة المراجع والكتب النادرة خارج المكتبة وتتاح للاطلاع الداخلي فقط.'],
    ['درجات أعمال السنة وتقسيم المجموع', 'قواعد وشروط امتحانات المعهد — إصدار 2025', 70, 'الامتحانات',
      'تتوزع درجة المادة الواحدة (100) كالتالي: 15 درجة اختبار قصير، 10 درجات واجبات وحضور، 75 درجة امتحان نهاية الفصل. درجة النجاح في كل مادة 60%. لا تحتسب أعمال السنة في حالة الحرمان من الامتحان التحريري. يعتمد عميد المعهد نتائج الامتحانات بعد مراجعة لجنة الكنترول، ويحق لكل طالب الاطلاع على إجابته بمظروف بعد إعلان النتيجة بأسبوع حتى نهاية التظلم.'],
  ];
  const docId = {};
  for (const [title, source, page, category, content] of docs) {
    docId[title] = run('INSERT INTO knowledge_documents(title, source, page, category, content) VALUES (?,?,?,?,?)',
      [title, source, page, category, content]).lastInsertRowid;
  }

  // ---- شكاوى تجريبية موزعة على آخر 8 أسابيع (بيانات حقيقية للتحليلات) ----
  // مقياس أوزان: شؤون الطلاب أكبر ضغط، ثم التسجيل والاامتحانات
  const samples = [
    // [title, details, typeName, dept, student, assigned, daysAgo, status, priority, rating?]
    ['مش قادر أسجل مادة رسم هندسي والشعب مقفولة', 'حاولت أسجل مادة الرسم الهندسي للفرقة الثانية بس النظام بيقول الشعب مكتملة رغم إني لسه فاتح التسجيل بدري، ومش عارف أتصرف لأني بحتاج المادة عشان أدخل الامتحان', 'مشكلة تسجيل مقررات', dReg, studentOmar, staffReg, 1, 'in_progress', 'urgent'],
    ['مشكلة في دفع القسط التاني على المنصة', 'عندي القسط التاني ومحاولة الدفع بتظهر رسالة "العملية مرفوضة من البنك"، وإيصال الصرف اتخصم مش عارف هو راح فين', 'شكوى مالية / مصروفات', dFinance, studentOmar, null, 2, 'new', 'high'],
    ['مش ظاهر درجاتي في نتيجة نهاية العام', 'نتيجة الفصل التاني ظهرت ومش لاقي مادة رياضيات 2، ولازم التظلم قبل نهاية الأسبوع', 'إعادة أو رصد درجات', dExams, studentOmar, staffExams, 3, 'in_progress', 'high'],
    ['طلب استخراج شهادة قيد', 'محتاج شهادة قيد للمكان اللي هقدم فيه على الكامب الصيفي، ياريت تجهز خلال يومين لو ينفع', 'استخراج شهادة / كارنيه', dTaalaat, studentOmar, staffTaalaat, 5, 'resolved', 'medium', 5],
    ['تكييف القاعة 3 سايبة مش شغال', 'من أول الأسبوع التكييف مش شغال في قاعة 3 وحضور المحاضرات صعب، فيه محاضرات وأعمال العام برضه', 'عطل في المرافق', dFacility, studentOmar, null, 6, 'in_progress', 'medium'],
    ['نسيت كلمة مرور المنصة وحضرت امتحان إلكتروني', 'كلمة المرور مش بتفتح واليوم عندي اختبار إلكتروني ومحدش بيرد من الدعم', 'مشكلة تقنية بالمنصة', dIT, studentOmar, staffIT, 8, 'resolved', 'urgent', 5],
    ['عذر قهري عن غياب محاضرة لظرف صحي', 'غبت عن محاضرات الثلاثاء بسبب وعكة صحية وعندي تقرير طبي معتمد، ياريت يتسجلي عذر عشان الغياب ميتحسبش', 'طلب تحويل أو تأجيل', dTaalaat, studentOmar, staffTaalaat, 9, 'resolved', 'medium', 4],
    ['محتاج كارنيه بدل فاقد', 'كارنية المعهد ضاع مني في الأتوبيس، محتاج بدل فاقد وأبقى أراجع الإجراءات والأوراق المطلوبة', 'استخراج شهادة / كارنيه', dTaalaat, studentOmar, staffTaalaat, 12, 'resolved', 'low', 5],
    ['التسجيل بوافي عندي مشكلة في سحب الشعبة', 'حابب أسيب شعبة الصباحي للتسجيل المتأخر، كل ما أضغط سحب النظام بيرجع بخطأ غريب', 'مشكلة تسجيل مقررات', dReg, studentOmar, staffReg, 14, 'resolved', 'low', 4],
    ['رسيت في مادة بقيت أحاول أرفع تظلم', 'مادة ث ثابتة 58 وأنا شايفها أعلى، محتاج أقدم تظلم رسمي بس مش عارف الإجراءات', 'إعادة أو رصد درجات', dExams, studentOmar, staffExams, 16, 'resolved', 'medium', 5],
    ['الواي فاي في مبنى ب مش شغال من الصبح', 'النت مش شغال في مبنى ب، ولا أقدر أحمل الملفات على جروب المحاضرات', 'مشكلة تقنية بالمنصة', dIT, studentOmar, staffIT, 20, 'resolved', 'medium', 4],
    ['مقعدي في القاعة مكسور', 'كرسي في الصف الأخير قاعة 2 مكسور تمامًا، محتاج يتصلحلحد حد ما حد يزق عليه', 'عطل في المرافق', dFacility, studentOmar, null, 24, 'rejected', 'low'],
    ['تأخر استلام شهادة التخرج موقتًا', 'عندي استلام شهادة وهم يتأخروا في التجهيز، الكلية ورقالية واتصلت ومحدش عاود', 'استخراج شهادة / كارنيه', dTaalaat, studentSara, staffTaalaat, 2, 'new', 'medium'],
    ['معايا مشكلة في رسوم التأجيل', 'حابب أأجل الفصل والتاجيل بيخصم رسوم، مش عارف المبلغ ومين اللي بيحدد', 'شكوى مالية / مصروفات', dFinance, studentSara, null, 4, 'new', 'medium'],
    ['معمل الميكاترونيكس فيه تكييف باظ', 'معمل الميكاترونيكس سايب التكييف مطفي من أسبوعين، طلبة الفرقتين الثالثة والرابعة بيشتكوا', 'عطل في المرافق', dFacility, studentSara, null, 7, 'in_progress', 'medium'],
    ['عندي مشكلة في مادة الرسم 2 تسجيل', 'مش قادر أسجل مادة الرسم 2 ولو مش هضاف هبقى محروم منها السنة الجاية', 'مشكلة تسجيل مقررات', dReg, studentSara, staffReg, 10, 'in_progress', 'high'],
    ['خطأ في اسم الشهادة المبدئي', 'في شهادة القيد اسمي "سارة محممود" بحرف ميم زيادة، محتاجة تتصلحلحد بسرعة', 'استخراج شهادة / كارنيه', dTaalaat, studentSara, staffTaalaat, 15, 'resolved', 'high', 4],
    ['مشكلة في الدخول لجروب المادة على المنصة', 'مش عارف أدخل جروب الرسم على المنصة وبحاول من امبارح، عندي محاضرة المونداي', 'مشكلة تقنية بالمنصة', dIT, studentSara, staffIT, 19, 'resolved', 'medium', 5],
    ['الكتاب اللي عاوزه مش موجود في المكتبة', 'كتاب المقاومة والمواد المقدرة مش موجود ولا حتى مرجع واحد، مكتبة القسم رفوف فاضية', 'مشكلة بالمكتبة', dLibrary, studentSara, null, 21, 'resolved', 'low', 3],
    ['محتاج تظلم رسمي في مادة كهرباء', 'نتيجة مادة المحركات طلعت 55 وزي ما قولت للدكتور أنا باقي 45 في الأسئلة السهلة', 'إعادة أو رصد درجات', dExams, studentSara, staffExams, 26, 'resolved', 'medium', 4],
    ['عندي استفسار بخصوص الأقساط', 'عندي قسط المصروفات ودفعته الجمعة والعملية لسه معلقة على المنصة لحد دلوقتي', 'شكوى مالية / مصروفات', dFinance, studentSara, null, 27, 'in_progress', 'medium'],
    ['الإضاءة في طرقة الدور التاني ضعيفة', 'لمبات طرقة الدور التاني في المبنى الإداري نصفها بايظ، والطلاب بيبقوا في ضلمة آخر اليوم', 'عطل في المرافق', dFacility, studentSara, null, 30, 'new', 'low'],
    ['طلب تأجيل فصل لعذر عائلي', 'عندي ظروف عائلية تستدعي تأجيل فصل كامل، حابب أعرف الإجراءات والورق المطلوب', 'طلب تحويل أو تأجيل', dTaalaat, studentSara, staffTaalaat, 33, 'resolved', 'medium', 5],
    ['التأخر في رصد درجة المعمل', 'معمل الاتصالات الدوائر بتاعتي اتصلحلحد من قبل ماطلع بس الدرجة لسه ما ظهرتش', 'إعادة أو رصد درجات', dExams, studentSara, staffExams, 36, 'resolved', 'medium', 4],
    ['غبت عن امتحان تكميلي رغم الإجازة', 'عندي إجازة مرضية معتمدة من المستشفى بأيام الامتحان التكميلي، وخايف من الحرمان', 'طلب تحويل أو تأجيل', dTaalaat, studentOmar, staffTaalaat, 40, 'resolved', 'high', 5],
    ['تكييف القاعة الرئيسية مش شغال وقت الامتحان', 'قاعة الامتحان الرئيسي القاعة الكبيرة التكييف مش شغال والحر داخل مش محتمل', 'عطل في المرافق', dFacility, studentOmar, null, 44, 'resolved', 'high', 5],
    ['مش قادر أحمل ملف المشروع على المنصة', 'برفع ملف مشروع الشبكات وبيقول نوع الملف غير مدعوم، الملف PDF وحجمه 8 ميجا', 'مشكلة تقنية بالمنصة', dIT, studentOmar, staffIT, 48, 'resolved', 'medium', 4],
    ['محتاج كارنيه الطالب بدل ضائع', 'ضاع مني الكارنيه من شهر وعايز بدل تاني', 'استخراج شهادة / كارنيه', dTaalaat, studentOmar, staffTaalaat, 52, 'resolved', 'low', 4],
  ];

  let ticketSeq = 0;
  for (const [title, details, typeName, dept, student, assignedTo, daysAgo, status, priority, rating] of samples) {
    ticketSeq += 1;
    const ticketNo = `NX-2026-${String(ticketSeq).padStart(4, '0')}`;
    const t = typeId[typeName] || null;
    const resolvedAt = status === 'resolved' ? `datetime('now','-${Math.max(daysAgo - 2, 0)} days')` : null;
    const aiConf = 0.72 + ((ticketSeq * 37) % 20) / 100; // 0.72..0.91
    if (resolvedAt) {
      run(`INSERT INTO complaints(ticket_no, student_id, type_id, department_id, assigned_to, title, details, status, priority, ai_category, ai_confidence, rating, created_at, updated_at, resolved_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','-${daysAgo} days'),datetime('now','-${Math.max(daysAgo - 2, 0)} days'),datetime('now','-${Math.max(daysAgo - 2, 0)} days'))`,
        [ticketNo, student, t, dept, assignedTo || null, title, details, status, priority, typeName, aiConf, rating ?? null]);
    } else {
      run(`INSERT INTO complaints(ticket_no, student_id, type_id, department_id, assigned_to, title, details, status, priority, ai_category, ai_confidence, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,datetime('now','-${daysAgo} days'),datetime('now','-${daysAgo} days'))`,
        [ticketNo, student, t, dept, assignedTo || null, title, details, status, priority, typeName, aiConf]);
    }
    const cid = one('SELECT id FROM complaints WHERE ticket_no = ?', [ticketNo]).id;
    run('INSERT INTO complaint_updates(complaint_id, user_id, action, details, created_at) VALUES (?,?,?,?,datetime(\'now\',\'-' + daysAgo + ' days\'))',
      [cid, student, 'created', 'تم إنشاء الشكوى']);
    if (assignedTo) run('INSERT INTO complaint_updates(complaint_id, user_id, action, details) VALUES (?,?,?,?)', [cid, admin, 'assigned', 'تم إحالة الشكوى للموظف المختص']);
    if (status === 'resolved') {
      run('INSERT INTO complaint_updates(complaint_id, user_id, action, details) VALUES (?,?,?,?)', [cid, assignedTo || staffTaalaat, 'status', 'تم تغيير الحالة إلى: تم الحل']);
      run('INSERT INTO messages(complaint_id, sender_id, body, is_internal, created_at) VALUES (?,?,?,0,datetime(\'now\',\'-' + Math.max(daysAgo - 1, 0) + ' days\'))',
        [cid, assignedTo || staffTaalaat, 'أهلًا! تم استلام شكواك ومراجعتها والانتهاء من الإجراء اللازم. لو احتجت أي حاجة تانية أنا موجود.']);
    } else if (status === 'in_progress') {
      run('INSERT INTO messages(complaint_id, sender_id, body, is_internal, created_at) VALUES (?,?,?,0,datetime(\'now\',\'-' + daysAgo + ' days\'))',
        [cid, assignedTo || staffTaalaat, 'الشكوى وصلت وقيد المراجعة حاليًا، هنوافيك بالتحديثات أول بأول.']);
    }
  }

  // إشعارات تجريبية
  const note = (userId, title, body, refId) =>
    run('INSERT INTO notifications(user_id, title, body, ref_type, ref_id) VALUES (?,?,?,?,?)', [userId, title, body, 'complaint', refId || null]);
  const openForStaff = q('SELECT id, department_id FROM complaints WHERE status IN (\'new\',\'in_progress\')');
  for (const c of openForStaff.slice(0, 6)) {
    const staffList = q('SELECT id FROM users WHERE role=\'staff\' AND department_id = ?', [c.department_id]);
    for (const s of staffList) note(s.id, 'شكوى جديدة بانتظار المراجعة', 'وصلت شكوى جديدة لقسمه عبر NEXUS AI', c.id);
  }
  note(studentOmar, 'تم حل شكواك', 'تم حل مشكلتك بخصوص "طلب استخراج شهادة قيد" — قيّم التجربة من داخل الشكاوى');

  console.log('[db] Seed complete: users, departments, complaints, knowledge base ✓');
}

module.exports = { initDb, getDb: () => db, q, one, run, hashPassword, verifyPassword };
