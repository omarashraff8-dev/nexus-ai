// NEXUS AI — مشترك بين كل الصفحات
const $ = (s, p) => (p || document).querySelector(s);
const $$ = (s, p) => [...(p || document).querySelectorAll(s)];

async function api(url, options = {}) {
  const opts = { credentials: 'same-origin', headers: {}, ...options };
  if (options.body && typeof options.body !== 'string') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(options.body);
  }
  if (window.NEXUS_STATIC) return window.nexusLocalApi(url, opts);
  const res = await fetch(url, opts);
  let json = null;
  try { json = await res.json(); } catch { json = { ok: false, error: 'استجابة غير صالحة من السيرفر' }; }
  return { status: res.status, ...json };
}

function toast(msg, type = 'ok') {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.className = `toast show ${type}`;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.className = 'toast'; }, 3600);
}

function fmtDate(str) {
  if (!str) return '—';
  const d = new Date(String(str).replace(' ', 'T') + 'Z');
  if (isNaN(d)) return str;
  return d.toLocaleString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function fmtDay(str) {
  if (!str) return '—';
  const d = new Date(String(str).replace(' ', 'T') + 'Z');
  return isNaN(d) ? str : d.toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
}

const STATUS = { new: 'جديدة', in_progress: 'قيد المراجعة', resolved: 'تم الحل', rejected: 'مرفوضة' };
const PRIORITY = { low: 'منخفضة', medium: 'متوسطة', high: 'مرتفعة', urgent: 'عاجلة' };
const statusBadge = s => `<span class="badge ${s}">${STATUS[s] || s}</span>`;
const priorityBadge = p => `<span class="priority ${p}">${PRIORITY[p] || p}</span>`;

const ROLE_HOME = { student: 'student.html', staff: 'staff.html', admin: 'admin.html' };

// حارس الصفحة: يتأكد من تسجيل الدخول والدور، ويرجع بيانات المستخدم
async function requireRolePage(expectedRole) {
  const r = await api('/api/auth/me');
  if (!r.ok) { window.location.href = 'login.html?next=' + encodeURIComponent(window.location.pathname); return null; }
  const user = r.data.user;
  if (expectedRole && user.role !== expectedRole) { window.location.href = ROLE_HOME[user.role] || 'login.html'; return null; }
  return user;
}

// تهيئة الهيكل المشترك: الرابط النشط، عداد الإشعارات، تسجيل الخروج، زر القائمة
function initShell(opts = {}) {
  const { active, onOpenComplaint } = opts;
  if (active) $$('.side-link').forEach(a => a.classList.toggle('active', a.dataset.section === active));

  const logoutBtn = $('#logoutBtn');
  if (logoutBtn) logoutBtn.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); window.location.href = 'login.html'; });

  const toggle = $('.sidebar-toggle');
  if (toggle) toggle.addEventListener('click', () => $('.sidebar').classList.toggle('open'));

  // تبديل أقسام الصفحة (SPA-lite)
  $$('[data-section]').forEach(link => {
    if (!link.classList.contains('side-link')) return;
    link.addEventListener('click', () => {
      const target = link.dataset.section;
      $$('.page-section').forEach(sec => sec.classList.toggle('active', sec.id === 'section-' + target));
      $$('.side-link').forEach(a => a.classList.toggle('active', a === link));
      $('.sidebar').classList.remove('open');
      const title = $('#topbarTitle'); if (title && link.dataset.title) title.textContent = link.dataset.title;
      window.dispatchEvent(new CustomEvent('nexus:section-shown', { detail: { section: target } }));
    });
  });

  // الجرس + القائمة المنسدلة
  const bell = $('#bellBtn');
  const dropdown = $('#notifDropdown');
  async function refreshBadge() {
    const r = await api('/api/notifications/count');
    const badge = $('#bellBadge');
    if (badge && r.ok) { badge.textContent = r.data.count; badge.style.display = r.data.count > 0 ? 'grid' : 'none'; }
  }
  window.refreshNotifBadge = refreshBadge;
  refreshBadge();
  setInterval(refreshBadge, 30000);

  if (bell && dropdown) {
    bell.addEventListener('click', async () => {
      const opening = dropdown.style.display !== 'block';
      dropdown.style.display = opening ? 'block' : 'none';
      if (opening) {
        dropdown.innerHTML = '<div style="padding:.8rem;text-align:center;color:var(--muted);font-size:.8rem">جارِ التحميل...</div>';
        const r = await api('/api/notifications?limit=6');
        if (r.ok && r.data.length) {
          dropdown.innerHTML = r.data.map(n => `<button class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" data-ref="${n.ref_id || ''}" data-type="${n.ref_type || ''}" style="width:100%;text-align:start;background:none;border:none;cursor:pointer"><div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body || '')}</p></div><time>${fmtDay(n.created_at)}</time></button>`).join('') + '<button id="markAllRead" class="btn btn-outline btn-sm btn-block" style="margin-top:.4rem">تعليم الكل كمقروء</button>';
          $('#markAllRead').addEventListener('click', async () => { await api('/api/notifications/read-all', { method: 'POST' }); refreshBadge(); dropdown.style.display = 'none'; toast('تم تعليم كل الإشعارات كمقروءة'); });
        } else {
          dropdown.innerHTML = '<div style="padding:.8rem;text-align:center;color:var(--muted);font-size:.8rem">لا توجد إشعارات بعد</div>';
        }
        dropdown.addEventListener('click', async e => {
          const item = e.target.closest('.notif-item'); if (!item) return;
          await api(`/api/notifications/${item.dataset.id}/read`, { method: 'POST' });
          if (item.dataset.type === 'complaint' && item.dataset.ref && onOpenComplaint) onOpenComplaint(Number(item.dataset.ref));
          dropdown.style.display = 'none'; refreshBadge();
        }, { once: true });
      }
    });
    document.addEventListener('click', e => { if (!e.target.closest('#bellBtn') && !e.target.closest('#notifDropdown')) dropdown.style.display = 'none'; });
  }
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// نجوم التقييم
function renderStars(rating, container) {
  if (!container) return;
  let html = '';
  for (let i = 1; i <= 5; i++) html += `<button class="star-btn ${i <= (rating || 0) ? 'filled' : ''}" data-star="${i}" aria-label="${i} نجوم">★</button>`;
  container.innerHTML = html;
}

// شارة دور المستخدم بالعربية
function roleName(role) { return { student: 'طالب', staff: 'موظف', admin: 'إدارة المعهد' }[role] || role; }
