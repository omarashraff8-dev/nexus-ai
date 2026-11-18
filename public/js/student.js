// NEXUS AI — Student dashboard logic
let currentUser = null;
let currentComplaintId = null;
let attachmentPayload = null; // { name, dataBase64 }
let mineFilter = '';

(async function init() {
  currentUser = await requireRolePage('student');
  if (!currentUser) return;

  $('#userName').textContent = currentUser.name;
  $('#userAvatar').textContent = (currentUser.name || 'ط').trim()[0];
  $('#userRole').textContent = 'طالب' + (currentUser.student_code ? ' · ' + currentUser.student_code : '');

  initShell({ active: 'dashboard', onOpenComplaint: openComplaint });
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => switchSection(b.dataset.goto)));
  window.addEventListener('nexus:section-shown', e => {
    const s = e.detail.section;
    if (s === 'mine') loadMine();
    if (s === 'notifs') loadNotifications();
    if (s === 'dashboard') loadStats();
  });

  await Promise.all([loadTypes(), loadStats(), loadRecent()]);
  renderAiHistory();

  // استقبال حدث فتح شكوى من الإشعار (من الجرس في أي صفحة)
  // تم تمريره عبر initShell onOpenComplaint
})();

function switchSection(name) {
  $(`.side-link[data-section="${name}"]`)?.click();
}

// ---------- الرئيسية ----------
async function loadStats() {
  const r = await api('/api/stats');
  if (!r.ok) return;
  $('#stTotal').textContent = r.data.total;
  $('#stProgress').textContent = (r.data.in_progress || 0) + (r.data.new || 0);
  $('#stResolved').textContent = r.data.resolved;
  $('#stRejected').textContent = r.data.rejected;
}
async function loadRecent() {
  const r = await api('/api/stats');
  const box = $('#recentList');
  if (!r.ok || !r.data.recent?.length) { box.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:.6rem">لسه معندكش طلبات — قدّم أول شكوى من «شكوى جديدة» 🚀</p>'; return; }
  box.innerHTML = r.data.recent.map(c => `
    <button class="complaint-item" style="width:100%;text-align:start" data-open="${c.id}">
      <span><span class="ticket-no">${escapeHtml(c.ticket_no)}</span><br><b>${escapeHtml(c.title)}</b></span>
      <span style="display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">${priorityBadge(c.priority)} ${statusBadge(c.status)}</span>
    </button>`).join('');
  box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openComplaint(Number(b.dataset.open))));
}

// ---------- شكوى جديدة ----------
async function loadTypes() {
  const r = await api('/api/complaint-types');
  if (!r.ok) return;
  const sel = $('#fType');
  for (const t of r.data) {
    const o = document.createElement('option');
    o.value = t.id; o.textContent = `${t.name} — ${t.department_name}`; o.dataset.dept = t.department_id;
    sel.appendChild(o);
  }
}

$('#fAttachment').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('الملف أكبر من 8MB', 'err'); e.target.value = ''; return; }
  const reader = new FileReader();
  reader.onload = () => {
    attachmentPayload = { name: file.name, dataBase64: reader.result };
    $('#fileName').textContent = file.name;
  };
  reader.readAsDataURL(file);
});
$('#pickFileBtn').addEventListener('click', () => $('#fAttachment').click());

$('#aiAnalyzeBtn').addEventListener('click', runAiAnalysis);
async function runAiAnalysis() {
  const text = `${$('#fTitle').value} ${$('#fDetails').value}`.trim();
  const box = $('#aiSuggestionBody');
  if (text.length < 15) { toast('اكتب عنوان وتفاصيل كافية للتحليل', 'err'); return; }
  box.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  const r = await api('/api/ai/classify', { method: 'POST', body: { text } });
  if (!r.ok) { box.textContent = r.error; return; }
  const ai = r.data;
  const confPct = Math.round(ai.confidence * 100);
  $('#fPriority').value = ai.priority;
  // اختار نوع الشكوى المطابق إن وجد
  const opt = [...$('#fType').options].find(o => o.textContent.startsWith(ai.category));
  if (opt) $('#fType').value = opt.value;
  box.innerHTML = `
    <div style="display:grid;gap:.45rem;font-size:.84rem">
      <div style="display:flex;justify-content:space-between;gap:.5rem"><span style="color:var(--muted)">النوع المتوقع:</span><b>${escapeHtml(ai.category)}</b></div>
      <div style="display:flex;justify-content:space-between;gap:.5rem"><span style="color:var(--muted)">القسم المسؤول:</span><b>${escapeHtml(ai.department_name || '—')}</b></div>
      <div style="display:flex;justify-content:space-between;gap:.5rem"><span style="color:var(--muted)">الأولوية:</span>${priorityBadge(ai.priority)}</div>
      <div class="ai-analysis" style="margin-top:.2rem"><b>دقة التوقع: ${confPct}%</b><div class="conf"><div class="progress"><div style="width:${confPct}%"></div></div></div>
        ${ai.matched_keywords?.length ? `<div style="margin-top:.35rem;font-size:.72rem;color:var(--muted)">بناءً على كلمات: ${ai.matched_keywords.map(k => `<span class="src-chip">${escapeHtml(k)}</span>`).join('')}</div>` : ''}
        <div style="margin-top:.3rem;font-size:.7rem;color:var(--muted)">تم تعبئة الأولوية ونوع الشكوى تلقائيًا — تقدر تعدلها.</div>
      </div>
    </div>`;
}

$('#complaintForm').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = $('#submitComplaintBtn'); btn.disabled = true; btn.textContent = 'جارِ الإرسال...';
  let attachmentUrl = attachmentPayload?.name ? null : null;
  if (attachmentPayload) {
    const up = await api('/api/upload', { method: 'POST', body: { filename: attachmentPayload.name, dataBase64: attachmentPayload.dataBase64 } });
    if (up.ok) attachmentUrl = up.data.url; else { toast(up.error || 'فشل رفع المرفق', 'err'); btn.disabled = false; btn.textContent = 'إرسال الشكوى الآن'; return; }
  }
  const selectedType = $('#fType').selectedOptions[0];
  const r = await api('/api/complaints', { method: 'POST', body: {
    title: $('#fTitle').value.trim(), details: $('#fDetails').value.trim(),
    type_id: $('#fType').value || null,
    department_id: selectedType?.dataset.dept || null,
    priority: $('#fPriority').value, attachment: attachmentUrl,
  }});
  if (!r.ok) { toast(r.error || 'تعذر إرسال الشكوى', 'err'); btn.disabled = false; btn.textContent = 'إرسال الشكوى الآن'; return; }
  toast(`تم استلام شكواك — رقم الطلب: ${r.data.complaint.ticket_no} ✓`);
  e.target.reset(); attachmentPayload = null; $('#fileName').textContent = 'لم يتم اختيار ملف';
  $('#aiSuggestionBody').textContent = 'تم إرسال الشكوى! الذكاء الاصطناعي حولها للقسم المختص وهنوافيك بأي تحديث على إشعار.';
  btn.disabled = false; btn.textContent = 'إرسال الشكوى الآن';
  switchSection('mine'); loadMine();
});

// ---------- شكوايّ ----------
$('#mineFilterSeg').addEventListener('click', e => {
  const b = e.target.closest('button[data-status]'); if (!b) return;
  mineFilter = b.dataset.status;
  $('#mineFilterSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  loadMine();
});

async function loadMine() {
  const box = $('#mineList');
  box.innerHTML = '<p style="color:var(--muted);text-align:center;padding:1rem">جارِ التحميل...</p>';
  const r = await api(`/api/complaints${mineFilter ? '?status=' + mineFilter : ''}`);
  if (!r.ok) { box.innerHTML = `<p style="color:var(--danger)">${escapeHtml(r.error)}</p>`; return; }
  if (!r.data.length) { box.innerHTML = '<p style="color:var(--muted);text-align:center;padding:1.2rem">لا توجد شكاوى في هذه الحالة.</p>'; return; }
  box.innerHTML = r.data.map(c => `
    <button class="complaint-item" style="width:100%;text-align:start" data-open="${c.id}">
      <span style="min-width:0"><span class="ticket-no">${escapeHtml(c.ticket_no)} · ${fmtDay(c.created_at)}</span><br><b>${escapeHtml(c.title)}</b><br><span style="font-size:.72rem;color:var(--muted)">${escapeHtml(c.department_name)}${c.assigned_name ? ' · ' + escapeHtml(c.assigned_name) : ''}</span></span>
      <span style="display:flex;flex-direction:column;gap:.3rem;align-items:flex-end">${statusBadge(c.status)} ${priorityBadge(c.priority)}</span>
    </button>`).join('');
  box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openComplaint(Number(b.dataset.open))));
}

// ---------- المودال ----------
const modal = $('#complaintModal');
$('#closeModalBtn').addEventListener('click', closeModal);
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
function closeModal() { modal.classList.remove('open'); currentComplaintId = null; }

async function openComplaint(id) {
  currentComplaintId = id;
  modal.classList.add('open');
  $('#modalHeadInfo').innerHTML = '<p style="color:var(--muted);font-size:.85rem">جارِ التحميل...</p>';
  const r = await api(`/api/complaints/${id}`);
  if (!r.ok) { toast(r.error, 'err'); closeModal(); return; }
  renderModal(r.data);
}

function renderModal({ complaint: c, messages, updates }) {
  $('#modalTitle').textContent = `${c.ticket_no} — ${c.title}`;
  $('#modalHeadInfo').innerHTML = `<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">${statusBadge(c.status)} ${priorityBadge(c.priority)}<span style="font-size:.75rem;color:var(--muted)">القسم: <b>${escapeHtml(c.department_name)}</b>${c.assigned_name ? ' · الموظف: <b>' + escapeHtml(c.assigned_name) + '</b>' : ''} · أُنشئت ${fmtDate(c.created_at)}</span></div>`;
  $('#modalDetails').textContent = c.details;

  // صندوق تحليل الذكاء الاصطناعي
  const aiBox = $('#modalAiBox');
  if (c.ai_category) {
    aiBox.style.display = 'block';
    aiBox.innerHTML = `<b>✨ تحليل NEXUS AI:</b> صُنفت كـ«${escapeHtml(c.ai_category)}» بثقة ${Math.round((c.ai_confidence || 0) * 100)}% وحُوّلت تلقائيًا للقسم المختص.`;
  } else aiBox.style.display = 'none';

  $('#modalAttachment').innerHTML = c.attachment ? `<a class="link" href="${escapeHtml(c.attachment)}" target="_blank" rel="noopener">📎 عرض المرفق</a>` : '';

  $('#modalTimeline').innerHTML = updates.map(u => `
    <li><div class="t-body"><b>${escapeHtml(actionLabel(u.action))}</b>${u.details ? `<span>${escapeHtml(u.details)}</span>` : ''}</div><time>${fmtDay(u.created_at)}</time></li>`).join('') || '<li><div class="t-body"><span>لا توجد تحديثات بعد</span></div></li>';

  // محادثة
  const chat = $('#modalChat');
  chat.innerHTML = messages.length ? messages.map(m => {
    const mine = m.sender_role === 'student';
    return `<div class="msg ${mine ? 'me' : 'them'}"><div class="meta"><span>${escapeHtml(m.sender_name)}</span><span>${fmtDate(m.created_at)}</span></div>${escapeHtml(m.body)}</div>`;
  }).join('') : '<p style="color:var(--muted);font-size:.82rem;text-align:center;padding:1rem">لسه مفيش رسائل — ابدأ المحادثة مع الموظف المختص.</p>';
  chat.scrollTop = chat.scrollHeight;

  // تقييم بعد الحل
  const ratingBox = $('#ratingBox');
  if (c.status === 'resolved') {
    ratingBox.style.display = 'block';
    renderStars(c.rating || 0, $('#ratingStars'));
    $('#ratingThanks').style.display = c.rating ? 'block' : 'none';
    if (!c.rating) {
      $('#ratingStars').querySelectorAll('.star-btn').forEach(btn => btn.addEventListener('click', async () => {
        const r2 = await api(`/api/complaints/${c.id}/rate`, { method: 'POST', body: { rating: Number(btn.dataset.star) } });
        if (r2.ok) { renderStars(r2.data.complaint.rating, $('#ratingStars')); $('#ratingStars').querySelectorAll('.star-btn').forEach(b => b.disabled = true); $('#ratingThanks').style.display = 'block'; toast('شكرًا لتقييمك! 🌟'); }
      }));
    } else {
      $('#ratingStars').querySelectorAll('.star-btn').forEach(b => b.disabled = true);
    }
  } else ratingBox.style.display = 'none';
}
function actionLabel(a) { return { created: 'تم إنشاء الشكوى', status: 'تغيير الحالة', assigned: 'إسناد', transfer: 'تحويل لقسم', request_info: 'طلب معلومات' }[a] || a; }

$('#modalMessageForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#modalMessageInput');
  const body = input.value.trim(); if (!body || !currentComplaintId) return;
  const r = await api(`/api/complaints/${currentComplaintId}/messages`, { method: 'POST', body: { body } });
  if (!r.ok) { toast(r.error, 'err'); return; }
  input.value = '';
  const reload = await api(`/api/complaints/${currentComplaintId}`);
  if (reload.ok) renderModal(reload.data);
  toast('تم إرسال رسالتك للموظف ✓');
});

// ---------- المساعد الذكي ----------
const aiBox = $('#aiChatBox');
function addAiBubble(text, cls) {
  const div = document.createElement('div');
  div.className = `ai-msg ${cls}`;
  div.textContent = text;
  aiBox.appendChild(div);
  aiBox.scrollTop = aiBox.scrollHeight;
  return div;
}
function addBotAnswer(answer, sources) {
  const div = document.createElement('div');
  div.className = 'ai-msg bot';
  div.innerHTML = `${escapeHtml(answer)}${sources && sources.length ? `<div class="sources"><b>المصادر:</b><br>${sources.map(s => `<span class="src-chip">📄 ${escapeHtml(s.title)} · ص${s.page ?? '—'}</span>`).join(' ')}</div>` : ''}`;
  aiBox.appendChild(div);
  aiBox.scrollTop = aiBox.scrollHeight;
}
async function askAssistant(text) {
  addAiBubble(text, 'user');
  const typing = document.createElement('div');
  typing.className = 'ai-msg bot'; typing.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
  aiBox.appendChild(typing); aiBox.scrollTop = aiBox.scrollHeight;
  const r = await api('/api/ai/chat', { method: 'POST', body: { message: text } });
  typing.remove();
  if (!r.ok) { addBotAnswer(r.error || 'حصل خطأ، حاول تاني.', []); return; }
  addBotAnswer(r.data.answer, r.data.sources);
}
async function renderAiHistory() {
  const r = await api('/api/ai/conversations');
  if (!r.ok || !r.data.length) {
    addBotAnswer('أهلًا بيك! أنا المساعد الذكي بتاع المعهد 🎓 اسألني عن اللوائح، التسجيل، الامتحانات، المصروفات، أو الخدمات — والإجابة هتجيلك بالمصدر والصفحة.', []);
    return;
  }
  for (const row of r.data) {
    if (row.role === 'user') addAiBubble(row.message, 'user'); else addAiBubble(row.message, 'bot');
  }
}
$('#aiChatForm').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('#aiChatInput'); const v = input.value.trim(); if (v.length < 3) return;
  input.value = ''; askAssistant(v);
});
$('#quickQuestions').addEventListener('click', e => {
  const btn = e.target.closest('.qq'); if (!btn) return;
  askAssistant(btn.textContent.trim());
});

// ---------- الإشعارات ----------
async function loadNotifications() {
  const list = $('#notifList');
  list.innerHTML = '<p style="color:var(--muted);text-align:center;padding:1rem">جارِ التحميل...</p>';
  const r = await api('/api/notifications');
  if (!r.ok) { list.innerHTML = `<p style="color:var(--danger)">${escapeHtml(r.error)}</p>`; return; }
  if (!r.data.length) { list.innerHTML = '<p style="color:var(--muted);text-align:center;padding:1.2rem">لا توجد إشعارات بعد 🔔</p>'; return; }
  list.innerHTML = r.data.map(n => `
    <div class="notif-item ${n.read ? '' : 'unread'}" data-id="${n.id}" ${n.ref_id ? `data-complaint="${n.ref_id}" style="cursor:pointer"` : ''}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="${n.read ? '#8AA3C4' : '#2563EB'}" stroke-width="2" stroke-linecap="round" style="flex:0 0 auto;margin-top:.15rem"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/></svg>
      <div><b>${escapeHtml(n.title)}</b><p>${escapeHtml(n.body || '')}</p></div>
      <time>${fmtDay(n.created_at)}</time>
    </div>`).join('');
  list.querySelectorAll('[data-id]').forEach(item => item.addEventListener('click', async () => {
    await api(`/api/notifications/${item.dataset.id}/read`, { method: 'POST' });
    item.classList.remove('unread');
    refreshNotifBadge();
    if (item.dataset.complaint) openComplaint(Number(item.dataset.complaint));
  }));
}
$('#markAllBtn').addEventListener('click', async () => { await api('/api/notifications/read-all', { method: 'POST' }); loadNotifications(); refreshNotifBadge(); toast('تم تعليم الكل كمقروء'); });
