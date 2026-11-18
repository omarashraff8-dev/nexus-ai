// build-static.js — ينسخ public/ إلى docs/ ويضيف وضع الديمو الثابت
// يُستخدم لنشر نسخة حية على GitHub Pages (لا يشغّل سيرفر — كل شيء في المتصفح)
const fs = require('fs'), path = require('path');

const SRC = path.join(__dirname, 'public');
const DEST = path.join(__dirname, 'docs');

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });

let injected = 0;
for (const file of fs.readdirSync(DEST, { recursive: true })) {
  const full = path.join(DEST, file.toString());
  if (!full.endsWith('.html')) continue;
  let s = fs.readFileSync(full, 'utf8');
  const MARK = '<script>window.NEXUS_STATIC = true;</script>';
  if (s.includes(MARK)) { injected++; continue; }
  s = s.replace('<head>', '<head>\n' + MARK);
  fs.writeFileSync(full, s);
  injected++;
}
console.log(`[build-static] docs/ ready — ${injected} صفحة في وضع الديمو الثابت`);
