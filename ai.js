// NEXUS AI — الوحدة الذكية: تصنيف الشكاوى + بحث RAG في اللوائح + التحليلات
const { q, one } = require('./db');

// ---------- أدوات معالجة العربية ----------
function normalizeArabic(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[ً-ٰٟ]/g, '')      // تشكيل
    .replace(/ـ/g, '')                  // tatweel
    .replace(/[أإآا]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/[^\u0600-\u06FFa-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokens(text) { return normalizeArabic(text).split(' ').filter(t => t.length > 1); }

// ---------- 1) تصنيف الشكاوى تلقائيًا ----------
// كل فئة: [كلمات مفتاحية (موزونة)، اسم القسم المستهدف]
const CATEGORIES = [
  { category: 'مشكلة تسجيل مقررات', dept: 'التسجيل والقبول', keywords: { 'تسجيل': 3, 'مقرر': 3, 'ماده': 2, 'شعب': 2, 'جدول': 2, 'سحب': 2, 'اضافه': 2, 'حذف': 1, 'شعبة': 2 } },
  { category: 'إعادة أو رصد درجات', dept: 'الامتحانات', keywords: { 'رصد': 3, 'درجه': 2, 'نتيجه': 3, 'تظلم': 3, 'ورقه': 2, 'استماره': 2, 'امتحان': 2, 'رسيت': 2, 'الكنترول': 2, 'معمل': 1 } },
  { category: 'شكوى مالية / مصروفات', dept: 'الشؤون المالية', keywords: { 'مصاريف': 3, 'رسوم': 3, 'قسط': 3, 'دفع': 2, 'ايصال': 2, 'مالي': 2, 'فلوس': 1, 'البنك': 2, 'خصم': 1 } },
  { category: 'استخراج شهادة / كارنيه', dept: 'شؤون الطلاب', keywords: { 'شهاده': 3, 'كارنيه': 3, 'قيد': 2, 'مستند': 2, 'بدل فاقد': 3, 'ورقه رسميه': 2 } },
  { category: 'طلب تحويل أو تأجيل', dept: 'شؤون الطلاب', keywords: { 'تحويل': 3, 'تاجيل': 3, 'اجاز': 2, 'عذر': 3, 'انسحاب': 2, 'اجازه': 2, 'تأجيل': 3 } },
  { category: 'عطل في المرافق', dept: 'المرافق والصيانة', keywords: { 'صيانه': 3, 'تكييف': 3, 'كهرباء': 3, 'مياه': 2, 'معمل': 2, 'كرسي': 2, 'مقعد': 2, 'باب': 1, 'سبور': 2, 'اضاءه': 2, 'لمبه': 2, 'مبني': 1 } },
  { category: 'مشكلة تقنية بالمنصة', dept: 'تكنولوجيا المعلومات', keywords: { 'المنصه': 3, 'باسورد': 3, 'كلمه المرور': 3, 'بريد': 2, 'ايميل': 2, 'واي فاي': 3, 'انترنت': 2, 'الموقع': 2, 'دخول': 1, 'الملف': 1, 'الجامعيه': 1 } },
  { category: 'مشكلة بالمكتبة', dept: 'المكتبة', keywords: { 'كتاب': 3, 'مكتبه': 3, 'استعاره': 3, 'مرجع': 2 } },
];
const URGENT_WORDS = ['عاجل', 'طارئ', 'فوري', 'بكره', 'اليوم', 'امتحان', 'الحرمان', 'الدعم', 'ساعه', 'فورًا'];
const HIGH_WORDS = ['بسرعه', 'قريب', 'قبل الامتحان', 'الاسبوع ده', 'لسه ما ظهرتش', 'محروق'];

function classifyComplaint(text) {
  const norm = normalizeArabic(text);
  const scores = CATEGORIES.map(cat => {
    let score = 0, matched = [];
    for (const [kw, w] of Object.entries(cat.keywords)) {
      const nkw = normalizeArabic(kw);
      if (nkw && norm.includes(nkw)) { score += w; matched.push(kw); }
    }
    return { ...cat, score, matched };
  }).sort((a, b) => b.score - a.score);

  const best = scores[0];
  const total = scores.reduce((s, c) => s + c.score, 0);
  const matchCount = best ? best.matched.length : 0;
  const confidence = best && best.score > 0
    ? Math.min(0.95, 0.4 + Math.min(best.score, 8) * 0.06 + (matchCount >= 3 ? 0.1 : matchCount === 2 ? 0.05 : 0))
    : 0.3;

  const urgent = URGENT_WORDS.some(w => norm.includes(normalizeArabic(w)));
  const high = !urgent && HIGH_WORDS.some(w => norm.includes(normalizeArabic(w)));
  const priority = urgent ? 'urgent' : high ? 'high' : best && best.score >= 3 ? 'medium' : 'low';
  const matchedSomething = !!(best && best.score > 0);

  // القسم المستهدف حسب التصنيف (fallback: شؤون الطلاب)
  let department = one('SELECT id, name FROM departments WHERE name = ?', [matchedSomething ? best.dept : 'شؤون الطلاب']);
  if (!department) department = one('SELECT id, name FROM departments ORDER BY id LIMIT 1');

  return {
    category: matchedSomething ? best.category : 'شكوى عامة / أخرى',
    department_id: department ? department.id : null,
    department_name: department ? department.name : null,
    priority,
    urgent,
    is_urgent: urgent,
    confidence: Math.round(confidence * 100) / 100,
    matched_keywords: matchedSomething ? best.matched : [],
  };
}

// ---------- 2) مساعد RAG: بحث في لوائح المعهد قبل الإجابة ----------
function searchKnowledge(query, topN = 3) {
  const qTokens = tokens(query);
  if (!qTokens.length) return [];
  const docs = q('SELECT * FROM knowledge_documents');
  const scored = docs.map(doc => {
    const docContent = normalizeArabic(doc.content);
    const docTitle = normalizeArabic(doc.title);
    let score = 0;
    const tf = {};
    for (const t of tokens(doc.content + ' ' + doc.title)) tf[t] = (tf[t] || 0) + 1;
    for (const qt of qTokens) {
      const freq = tf[qt] || 0;
      if (freq) score += 1 + Math.log(freq + 1);
      if (docTitle.includes(qt)) score += 2.5; // عنوان المستند أهم
    }
    return { doc, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

function extractAnswer(doc, query) {
  // نختار أفضل جملة من المستند تقاطع مع كلمات السؤال
  const qTokens = new Set(tokens(query));
  const sentences = String(doc.content).split(/[.،\n]+/).map(s => s.trim()).filter(s => s.length > 25);
  let best = null, bestScore = -1;
  for (const s of sentences) {
    const st = tokens(s);
    let sc = 0;
    for (const t of st) if (qTokens.has(t)) sc++;
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  const body = best || sentences[0] || doc.content.slice(0, 300);
  return `${body}.`;
}

function answerQuestion(query) {
  const results = searchKnowledge(query, 3);
  if (!results.length || results[0].score < 1.2) {
    return {
      answer: 'معلش، مش لاقي إجابة مباشرة عن السؤال ده في لوائح المعهد المتاحة عندي. تقدر تعيد صياغة السؤال، أو لو الموضوع خاص بحالتك ممكن تقدمه كشكوى من "شكوى جديدة" والقسم المختص هيرد عليك رسميًا.',
      sources: [], grounded: false,
    };
  }
  const top = results[0].doc;
  const answer = extractAnswer(top, query);
  return {
    answer,
    sources: results.map(r => ({ title: r.doc.title, source: r.doc.source, page: r.doc.page, category: r.doc.category, score: Math.round(r.score * 10) / 10 })),
    grounded: true,
  };
}

// ---------- 3) التحليلات والتنبؤ ----------
function weeklySeries(rows, weeks = 8) {
  const map = new Map();
  for (const r of rows) {
    const d = new Date(String(r.created_at).replace(' ', 'T') + 'Z');
    const key = `${d.getUTCFullYear()}-W${String(Math.ceil(((d - new Date(Date.UTC(d.getUTCFullYear(), 0, 1))) / 86400000 + new Date(Date.UTC(d.getUTCFullYear(), 0, 1)).getUTCDay() + 1) / 7)).padStart(2, '0')}`;
    map.set(key, (map.get(key) || 0) + 1);
  }
  // أرجع آخر N أسابيع بترتيب زمني
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-weeks).map(([week, count]) => ({ week, count }));
}

function linearPredict(values) {
  const n = values.length;
  if (n < 2) return values[0] || 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
  for (let i = 0; i < n; i++) { sumX += i; sumY += values[i]; sumXY += i * values[i]; sumXX += i * i; }
  const slope = (n * sumXY - sumX * sumY) / Math.max(1e-9, n * sumXX - sumX * sumX);
  const intercept = (sumY - slope * sumX) / n;
  return Math.max(0, Math.round(intercept + slope * n));
}

function buildInsights() {
  const all = q(`SELECT c.*, d.name AS department_name, ct.name AS type_name
                 FROM complaints c JOIN departments d ON d.id = c.department_id
                 LEFT JOIN complaint_types ct ON ct.id = c.type_id`);
  const total = all.length;
  const open = all.filter(c => c.status === 'new' || c.status === 'in_progress').length;
  const resolved = all.filter(c => c.status === 'resolved').length;
  const rejected = all.filter(c => c.status === 'rejected').length;

  const resolvedTimes = all.filter(c => c.status === 'resolved' && c.resolved_at)
    .map(c => (new Date(String(c.resolved_at).replace(' ', 'T') + 'Z') - new Date(String(c.created_at).replace(' ', 'T') + 'Z')) / 3600000);
  const avgResolutionHours = resolvedTimes.length ? Math.round(resolvedTimes.reduce((a, b) => a + b, 0) / resolvedTimes.length) : 0;

  const ratings = all.filter(c => c.rating).map(c => c.rating);
  const satisfaction = ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 20) : null; // نسبة مئوية

  // أكثر الأقسام استقبالًا
  const deptMap = {};
  for (const c of all) {
    deptMap[c.department_name] = deptMap[c.department_name] || { name: c.department_name, total: 0, open: 0, resolved: 0 };
    deptMap[c.department_name].total++;
    if (c.status === 'new' || c.status === 'in_progress') deptMap[c.department_name].open++;
    if (c.status === 'resolved') deptMap[c.department_name].resolved++;
  }
  const perDepartment = Object.values(deptMap).sort((a, b) => b.total - a.total);

  // أكثر أنواع المشكلات تكرارًا
  const typeMap = {};
  for (const c of all) { const k = c.type_name || c.ai_category || 'أخرى'; typeMap[k] = (typeMap[k] || 0) + 1; }
  const topTypes = Object.entries(typeMap).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, count]) => ({ name, count }));

  // أداء الموظفين (عدد المحلول)
  const staffPerf = q(`SELECT u.id, u.name, COUNT(*) AS resolved_count FROM complaints c JOIN users u ON u.id = c.assigned_to
                       WHERE c.status='resolved' AND u.role='staff' GROUP BY u.id ORDER BY resolved_count DESC`);

  // الاتجاه الأسبوعي + التنبؤ
  const series = weeklySeries(all, 8);
  const prediction = linearPredict(series.map(s => s.count));
  const currentWeek = series.length ? series[series.length - 1].count : 0;

  // أولويات مفتوحة تحتاج تدخل
  const urgentOpen = all.filter(c => (c.status === 'new' || c.status === 'in_progress') && (c.priority === 'urgent' || c.priority === 'high')).length;

  return { total, open, resolved, rejected, avgResolutionHours, satisfaction, perDepartment, topTypes, staffPerf, series, prediction, currentWeek, urgentOpen };
}

// ---------- 4) تلخيص ذكي للتقارير (مبني على بيانات حقيقية) ----------
function generateSummary() {
  const i = buildInsights();
  const today = new Date().toISOString().slice(0, 10);
  const topDept = i.perDepartment[0];
  const topType = i.topTypes[0];
  const lines = [];
  lines.push(`تقرير تحليل الشكاوى — حتى ${today}`);
  lines.push('');
  lines.push(`إجمالي الشكاوى والطلبات المسجلة ${i.total}، منها ${i.open} مفتوحة و ${i.resolved} تم حلها (${i.rejected} مرفوضة).`);
  lines.push(`متوسط زمن الحل ${i.avgResolutionHours} ساعة${i.satisfaction !== null ? `، ومستوى رضا الطلاب ${i.satisfaction}%` : ''}.`);
  if (topDept) lines.push(`أكثر الأقسام استقبالًا للشكاوى: "${topDept.name}" بإجمالي ${topDept.total} شكوى (${topDept.open} منها ما زالت مفتوحة).`);
  if (topType) lines.push(`أكثر المشكلات تكرارًا: "${topType.name}" بعدد ${topType.count} شكوى.`);
  if (i.series.length >= 2) {
    const last = i.series[i.series.length - 1].count, prev = i.series[i.series.length - 2].count;
    const diff = last - prev;
    lines.push(`الحجم الأسبوعي ${diff >= 0 ? 'ارتفع' : 'انخفض'} بمقدار ${Math.abs(diff)} شكوى عن الأسبوع السابق، والتوقع للأسبوع القادم ${i.prediction} شكوى تقريبًا.`);
  }
  if (i.urgentOpen > 0) lines.push(`تنبيه: يوجد ${i.urgentOpen} شكوى عاجلة أو عالية الأولوية مفتوحة تحتاج تدخلًا سريعًا.`);
  lines.push('');
  lines.push('توصيات مقترحة:');
  if (topDept && topDept.open > 3) lines.push(`- دعم قسم "${topDept.name}" بموظف إضافي أو إعادة توزيع الشكاوى لتقليل التراكم المفتوح.`);
  if (topType) lines.push(`- نشر إرشادات أو إعلان ثابت عن "${topType.name}" لتقليل الشكاوى المتكررة من المنبع.`);
  if (i.avgResolutionHours > 72) lines.push('- مراجعة زمن الاستجابة المستهدف (SLA) وتفعيل تنبيهات تلقائية للشكاوى المتأخرة.');
  lines.push('- تحديث قاعدة المعرفة (اللوائح) باستمرار لرفع جودة إجابات المساعد الذكي.');
  return { summary: lines.join('\n'), insights: i, generatedAt: today };
}

module.exports = { classifyComplaint, answerQuestion, searchKnowledge, buildInsights, generateSummary, normalizeArabic, tokens };
