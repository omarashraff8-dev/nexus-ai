// NEXUS AI — Staff dashboard logic
let currentUser = null;
let currentComplaintId = null;
let searchTimer = null;

(async function init() {
  currentUser = await requireRolePage('staff');
  if (!currentUser) return;

  $('#userName').textContent = currentUser.name;
  $('#userAvatar').textContent = (currentUser.name || 'م').trim()[0];
  $('#userRole').textContent = 'موظف · ' + (currentUser.department_name || '');
  $('#deptSub').textContent = (currentUser.department_name || 'القسم') + ' — NEXUS AI';

  initShell({ active: 'dashboard', onOpenComplaint: openComplaint });
  document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => $(`.side-link[data-section="${b.dataset.goto}"]`)?.click()));
  window.addEventListener('nexus:section-shown', e => {
    const s = e.detail.section;
    if (s === 'complaints') loadComplaints();
    if (s === 'notifs') loadNotifications();
    if (s === 'dashboard') loadStats();
  });

  await Promise.all([loadStats(), loadUrgent(), loadTransferDepartments()]);
})();

// ---------- الرئيسية ----------
async function loadStats() {
  const r = await api('/api/stats');
  if (!r.ok) return;
  $('#stAssigned').textContent = r.data.assigned_to_me;
  $('#stOpen').textContent = r.data.open;
  $('#stResolvedWeek').textContent = r.data.resolved_week;
  $('#stResolvedTotal').textContent = r.data.resolved_total;
  $('#stAvgHours').textContent = r.data.avg_resolution_hours;
  $('#stSatisfaction').textContent = r.data.satisfaction !== null ? r.data.satisfaction + '%' : 'لسه مفيش تقييمات';
  const badge = $('#openBadge');
  badge.textContent = r.data.open; badge.style.display = r.data.open > 0 ? 'grid' : 'none';
}

async function loadUrgent() {
  const box = $('#urgentList');
  const r = await api('/api/complaints?status=new');
  const r2 = await api('/api/complaints?priority=urgent&status=in_progress');
  const urgent = [...(r.ok ? r.data : []).filter(c => c.priority === 'urgent' || c.priority === 'high'),
                  ...(r2.ok ? r2.data : [])].slice(0, 6);
  if (!urgent.length) { box.innerHTML = '<p style="color:var(--muted);font-size:.85rem;text-align:center;padding:.8rem">مفيش شكاوى عاجلة دلوقتي 🙌</p>'; return; }
  box.innerHTML = urgent.map(c => `
    <button class="complaint-item" style="width:100%;text-align:start;border-color:#FECACA" data-open="${c.id}">
      <span style="min-width:0"><span class="ticket-no">${escapeHtml(c.ticket_no)}</span><br><b>${escapeHtml(c.title)}</b><br><span style="font-size:.72rem;color:var(--muted)">${escapeHtml(c.student_name)} · ${fmtDay(c.created_at)}</span></span>
      ${priorityBadge(c.priority)}
    </button>`).join('');
  box.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openComplaint(Number(b.dataset.open))));
}

// ---------- جدول الشكاوى ----------
function currentFilters() {
  const params = new URLSearchParams();
  if ($('#fSearch').value.trim()) params.set('q', $('#fSearch').value.trim());
  if ($('#fStatus').value) params.set('status', $('#fStatus').value);
  if ($('#fPriority').value) params.set('priority', $('#fPriority').value);
  return params.toString();
}
async function loadComplaints() {
  const tbody = $('#complaintsTableBody');
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted)">جارِ التحميل...</td></tr>';
  const qs = currentFilters();
  const r = await api('/api/complaints' + (qs ? '?' + qs : ''));
  if (!r.ok) { tbody.innerHTML = `<tr><td colspan="7" style="color:var(--danger)">${escapeHtml(r.error)}</td></tr>`; return; }
  $('#resultCount').textContent = `${r.data.length} شكوى`;
  if (!r.data.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--muted);padding:1.5rem">لا توجد شكاوى بهذه الفلاتر.</td></tr>'; return; }
  tbody.innerHTML = r.data.map(c => `
    <tr>
      <td><span class="ticket-no">${escapeHtml(c.ticket_no)}</span></td>
      <td><b style="font-size:.82rem">${escapeHtml(c.student_name)}</b><br><span style="font-size:.68rem;color:var(--muted)" dir="ltr">${escapeHtml(c.student_code || '')}</span></td>
      <td style="max-width:280px"><b style="font-size:.83rem">${escapeHtml(c.title.slice(0, 70))}${c.title.length > 70 ? '…' : ''}</b><br><span style="font-size:.68rem;color:var(--muted)">${escapeHtml(c.type_name || '—')}</span></td>
      <td>${priorityBadge(c.priority)}</td>
      <td>${statusBadge(c.status)}</td>
      <td style="white-space:nowrap;font-size:.76rem">${fmtDay(c.created_at)}</td>
      <td><button class="btn btn-primary btn-sm" data-open="${c.id}">فتح</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openComplaint(Number(b.dataset.open))));
}
$('#fSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadComplaints, 300); });
$('#fStatus').addEventListener('change', loadComplaints);
$('#fPriority').addEventListener('change', loadComplaints);
$('#clearFilters').addEventListener('click', () => { $('#fSearch').value = ''; $('#fStatus').value = ''; $('#fPriority').value = ''; loadComplaints(); });

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
  $('#modalHeadInfo').innerHTML = `<div style="display:flex;gap:.5rem;flex-wrap:wrap;align-items:center">${statusBadge(c.status)} ${priorityBadge(c.priority)}<span style="font-size:.75rem;color:var(--muted)">القسم: <b>${escapeHtml(c.department_name)}</b>${c.assigned_name ? ' · مسندة إلى: <b>' + escapeHtml(c.assigned_name) + '</b>' : ' · غير مسندة'} · أُنشئت ${fmtDate(c.created_at)}</span></div>`;
  $('#mdStudent').textContent = c.student_name;
  $('#mdCode').textContent = c.student_code || '—';
  $('#mdEmail').textContent = c.student_email || '—';
  $('#mdType').textContent = c.type_name || '—';
  $('#modalDetails').textContent = c.details;
  $('#modalAttachment').innerHTML = c.attachment ? `<a class="link" href="${escapeHtml(c.attachment)}" target="_blank" rel="noopener">📎 عرض المرفق</a>` : '';

  const aiBox = $('#modalAiBox');
  if (c.ai_category) {
    aiBox.style.display = 'block';
    aiBox.innerHTML = `<b>✨ تحليل NEXUS AI:</b> «${escapeHtml(c.ai_category)}» · ثقة ${Math.round((c.ai_confidence || 0) * 100)}% · الأولوية المقترحة ${PRIORITY[c.priority] || c.priority}`;
  } else aiBox.style.display = 'none';

  $('#modalTimeline').innerHTML = updates.map(u => `
    <li><div class="t-body"><b>${escapeHtml(actionLabel(u.action))}${u.user_name ? ' — ' + escapeHtml(u.user_name) : ''}</b>${u.details ? `<span>${escapeHtml(u.details)}</span>` : ''}</div><time>${fmtDay(u.created_at)}</time></li>`).join('');

  const chat = $('#modalChat');
  chat.innerHTML = messages.length ? messages.map(m => {
    const mine = m.sender_role !== 'student';
    const internal = m.is_internal;
    return `<div class="msg ${internal ? 'internal' : mine ? 'me' : 'them'}"><div class="meta"><span>${internal ? '🔒 ملاحظة داخلية — ' : ''}${escapeHtml(m.sender_name)}</span><span>${fmtDate(m.created_at)}</span></div>${escapeHtml(m.body)}</div>`;
  }).join('') : '<p style="color:var(--muted);font-size:.82rem;text-align:center;padding:1rem">لا توجد رسائل بعد.</p>';
  chat.scrollTop = chat.scrollHeight;
}
function actionLabel(a) { return { created: 'تم إنشاء الشكوى', status: 'تغيير الحالة', assigned: 'إسناد', transfer: 'تحويل لقسم', request_info: 'طلب معلومات' }[a] || a; }

async function reloadModal() {
  if (!currentComplaintId) return;
  const r = await api(`/api/complaints/${currentComplaintId}`);
  if (r.ok) renderModal(r.data);
  loadComplaints(); loadStats(); loadUrgent();
}

// تغيير الحالة
document.querySelectorAll('.status-actions [data-status]').forEach(btn => btn.addEventListener('click', async () => {
  if (!currentComplaintId) return;
  const status = btn.dataset.status;
  if (status === 'rejected' && !confirm('تأكيد رفض الشكوى؟')) return;
  const r = await api(`/api/complaints/${currentComplaintId}/status`, { method: 'POST', body: { status } });
  if (!r.ok) return toast(r.error, 'err');
  toast('تم تحديث حالة الشكوى ✓'); reloadModal();
}));

// تولّي الشكوى
$('#assignToMeBtn').addEventListener('click', async () => {
  if (!currentComplaintId) return;
  const r = await api(`/api/complaints/${currentComplaintId}/assign`, { method: 'POST', body: {} });
  if (!r.ok) return toast(r.error, 'err');
  toast('تم إسناد الشكوى إليك ✓'); reloadModal();
});

// طلب معلومات إضافية
$('#requestInfoBtn').addEventListener('click', async () => {
  if (!currentComplaintId) return;
  const msg = prompt('ما المعلومات المطلوبة من الطالب؟', 'برجاء رفع صورة من الإيصال أو توضيح الرقم الجامعي');
  if (msg === null) return;
  const r = await api(`/api/complaints/${currentComplaintId}/request-info`, { method: 'POST', body: { message: msg } });
  if (!r.ok) return toast(r.error, 'err');
  toast('تم إرسال طلب المعلومات للطالب ✓'); reloadModal();
});

// التحويل لقسم آخر
function loadTransferDepartments() {
  api('/api/departments').then(r => {
    if (!r.ok) return;
    $('#transferDept').innerHTML = '<option value="">تحويل إلى قسم...</option>' + r.data.map(d => `<option value="${d.id}">${escapeHtml(d.name)}</option>`).join('');
  });
}
$('#transferBtn').addEventListener('click', async () => {
  const deptId = $('#transferDept').value;
  if (!deptId) return toast('اختر القسم المستهدف', 'err');
  if (!currentComplaintId) return;
  const reason = prompt('سبب التحويل (اختياري):', '') || '';
  const r = await api(`/api/complaints/${currentComplaintId}/transfer`, { method: 'POST', body: { department_id: Number(deptId), reason } });
  if (!r.ok) return toast(r.error, 'err');
  toast('تم تحويل الشكوى للقسم المختص ✓'); reloadModal();
});

// إرسال رد / ملاحظة داخلية
$('#modalMessageForm').addEventListener('submit', async e => {
  e.preventDefault();
  const input = $('#modalMessageInput');
  const body = input.value.trim(); if (!body || !currentComplaintId) return;
  const isInternal = $('#internalNoteToggle').checked;
  const r = await api(`/api/complaints/${currentComplaintId}/messages`, { method: 'POST', body: { body, is_internal: isInternal } });
  if (!r.ok) return toast(r.error, 'err');
  input.value = ''; $('#internalNoteToggle').checked = false;
  toast(isInternal ? 'تم حفظ الملاحظة الداخلية 🔒' : 'تم إرسال ردك للطالب ✓');
  reloadModal();
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
