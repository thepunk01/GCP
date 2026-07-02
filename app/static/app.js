const $ = (id) => document.getElementById(id);

let instances = [];
let overviewData = {};
let trafficSeries = [];
let appConfig = {};

const LS_PROFILES = 'gcp-panel-profiles-v2';
const LS_ACTIVE_PROFILE = 'gcp-panel-active-profile-v2';
const LS_TEMPLATES = 'gcp-panel-create-templates-v1';
const LS_CF = 'gcp-panel-cloudflare-v1';
const LS_LOG = 'gcp-panel-activity-log-v1';

function getProject() { return $('projectInput').value.trim(); }
function getToken() { return $('tokenInput').value.trim(); }
function getDefaultZone() { return $('zoneInput').value.trim() || 'us-central1-a'; }

function headers(json = false) {
  const h = {};
  const token = getToken();
  if (token) h['Authorization'] = `Bearer ${token}`;
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

async function api(path, options = {}) {
  const isJsonBody = options.body && !(options.body instanceof FormData);
  const res = await fetch(path, {
    ...options,
    headers: { ...headers(Boolean(isJsonBody)), ...(options.headers || {}) },
  });
  let payload;
  try { payload = await res.json(); } catch { payload = { ok: false, message: await res.text() }; }
  if (!res.ok || payload.ok === false) {
    const detail = payload.detail;
    const message = Array.isArray(detail) ? detail.map(x => x.msg || JSON.stringify(x)).join('; ') : detail;
    throw new Error(payload.message || message || `HTTP ${res.status}`);
  }
  return payload.data ?? payload;
}

function toast(message, error = false) {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.className = 'toast'; }, 5000);
  addLog(message, error ? 'error' : 'info');
}

function addLog(message, level = 'info') {
  const logs = loadJson(LS_LOG, []);
  logs.unshift({ time: new Date().toLocaleString(), message, level });
  localStorage.setItem(LS_LOG, JSON.stringify(logs.slice(0, 80)));
  renderLog();
}

function renderLog() {
  const box = $('activityLog');
  if (!box) return;
  const logs = loadJson(LS_LOG, []);
  if (!logs.length) {
    box.innerHTML = '<div class="empty log-empty">暂无操作记录</div>';
    return;
  }
  box.innerHTML = logs.slice(0, 30).map(row => `
    <div class="log-row ${escapeHtml(row.level)}">
      <span>${escapeHtml(row.time)}</span>
      <strong>${escapeHtml(row.message)}</strong>
    </div>`).join('');
}

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || ''); } catch { return fallback; }
}

function saveJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function bytes(num) {
  const n = Number(num || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 2)} ${units[i]}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
}

async function init() {
  const cfg = await fetch('/api/config').then(r => r.json());
  appConfig = cfg.data || {};
  bootstrapProfiles();
  renderProfiles();
  applyActiveProfile();
  loadCfSettings();
  renderConfigStatus();
  bindEvents();
  renderTemplates();
  renderLog();
  await refreshAll();
}

function bootstrapProfiles() {
  const profiles = loadJson(LS_PROFILES, {});
  if (!Object.keys(profiles).length) {
    const project = localStorage.getItem('gcp-panel-project') || appConfig.default_project || '';
    const token = localStorage.getItem('gcp-panel-token') || '';
    const zone = localStorage.getItem('gcp-panel-zone') || appConfig.default_zone || 'us-central1-a';
    profiles.main = { project, token, zone };
    saveJson(LS_PROFILES, profiles);
    localStorage.setItem(LS_ACTIVE_PROFILE, 'main');
  }
}

function renderProfiles() {
  const profiles = loadJson(LS_PROFILES, {});
  const active = localStorage.getItem(LS_ACTIVE_PROFILE) || Object.keys(profiles)[0] || 'main';
  $('profileSelect').innerHTML = Object.keys(profiles).map(name => (
    `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`
  )).join('') || '<option value="main">main</option>';
  $('profileSelect').value = active;
}

function applyActiveProfile() {
  const profiles = loadJson(LS_PROFILES, {});
  const active = localStorage.getItem(LS_ACTIVE_PROFILE) || Object.keys(profiles)[0] || 'main';
  const p = profiles[active] || { project: appConfig.default_project || '', token: '', zone: appConfig.default_zone || 'us-central1-a' };
  $('profileNameInput').value = active;
  $('projectInput').value = p.project || '';
  $('tokenInput').value = p.token || '';
  $('zoneInput').value = p.zone || appConfig.default_zone || 'us-central1-a';
  const zoneInput = document.querySelector('#createForm input[name="zone"]');
  if (zoneInput && !zoneInput.value) zoneInput.value = getDefaultZone();
  renderConfigStatus();
}

function saveProfile(silent = false) {
  const name = $('profileNameInput').value.trim() || 'main';
  const profiles = loadJson(LS_PROFILES, {});
  profiles[name] = { project: getProject(), token: getToken(), zone: getDefaultZone() };
  saveJson(LS_PROFILES, profiles);
  localStorage.setItem(LS_ACTIVE_PROFILE, name);
  renderProfiles();
  if (!silent) toast(`Profile 已保存：${name}`);
}

function deleteProfile() {
  const name = $('profileSelect').value;
  const profiles = loadJson(LS_PROFILES, {});
  if (Object.keys(profiles).length <= 1) { toast('至少保留一个 Profile', true); return; }
  if (!confirm(`确定删除 Profile：${name}？`)) return;
  delete profiles[name];
  saveJson(LS_PROFILES, profiles);
  localStorage.setItem(LS_ACTIVE_PROFILE, Object.keys(profiles)[0]);
  renderProfiles();
  applyActiveProfile();
  toast(`已删除 Profile：${name}`);
}

function renderConfigStatus() {
  const tokenRequired = appConfig.token_required ? '需要 Token' : '开发模式：Token 可空';
  $('authHint').textContent = tokenRequired;
  $('sideAuthHint').textContent = tokenRequired;
  const cs = appConfig.credential_status || {};
  if (cs.google_application_credentials) {
    $('credentialStatus').textContent = `凭据：${cs.service_account_project_id || '已配置'} · ${cs.google_application_credentials}`;
  } else {
    $('credentialStatus').textContent = cs.uploaded_service_account_exists ? '凭据：已上传，但未被环境变量加载' : '凭据：使用 ADC / gcloud 或尚未配置';
  }
  $('cfStatus').textContent = appConfig.cloudflare_token_configured ? 'Cloudflare：服务端 Token 已配置' : 'Cloudflare：未配置 CF_API_TOKEN';
}

function bindEvents() {
  $('profileSelect').addEventListener('change', () => {
    localStorage.setItem(LS_ACTIVE_PROFILE, $('profileSelect').value);
    applyActiveProfile();
    refreshAll();
  });
  $('saveProfileBtn').addEventListener('click', saveProfile);
  $('deleteProfileBtn').addEventListener('click', deleteProfile);
  $('refreshBtn').addEventListener('click', () => refreshAll());
  $('healthBtn').addEventListener('click', healthCheck);
  $('reloadClientBtn').addEventListener('click', reloadClient);
  $('uploadSaBtn').addEventListener('click', uploadServiceAccount);
  $('createForm').addEventListener('submit', createInstance);
  $('saveTemplateBtn').addEventListener('click', saveTemplateFromForm);
  $('queryTrafficBtn').addEventListener('click', queryTraffic);
  $('instanceFilter').addEventListener('input', renderInstances);
  $('statusFilter').addEventListener('change', renderInstances);
  $('saveCfBtn').addEventListener('click', saveCfSettings);
  $('clearLogBtn').addEventListener('click', () => { localStorage.removeItem(LS_LOG); renderLog(); });
  document.querySelectorAll('.traffic-preset').forEach(btn => btn.addEventListener('click', () => {
    $('trafficHours').value = btn.dataset.hours;
    queryTraffic();
  }));
  $('instancesBody').addEventListener('click', handleInstanceButton);
  $('templateList').addEventListener('click', handleTemplateButton);
}

async function refreshConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  appConfig = cfg.data || appConfig;
  renderConfigStatus();
}

async function refreshAll() {
  if (!getProject()) { toast('请先填写 Project ID', true); return; }
  saveProfile(true);
  try {
    await Promise.all([loadOverview(), loadInstances()]);
    addLog('实例和概览已刷新');
  } catch (err) {
    toast(err.message, true);
  }
}

async function healthCheck() {
  if (!getProject()) { toast('请先填写 Project ID', true); return; }
  try {
    const data = await api(`/api/health?project=${encodeURIComponent(getProject())}`);
    toast(`测活：Compute ${data.compute}，Monitoring ${data.monitoring}`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function reloadClient() {
  try {
    await api('/api/cache/reload', { method: 'POST' });
    await refreshConfig();
    toast('GCP 客户端缓存已刷新');
  } catch (err) { toast(err.message, true); }
}

async function uploadServiceAccount() {
  const file = $('saFileInput').files[0];
  if (!file) { toast('请选择 Service Account JSON 文件', true); return; }
  const form = new FormData();
  form.append('file', file);
  try {
    const data = await api('/api/credentials/gcp-service-account', { method: 'POST', body: form });
    await refreshConfig();
    if (data.project_id && !getProject()) $('projectInput').value = data.project_id;
    toast(`凭据上传成功：${data.client_email || data.project_id || '已加载'}`);
  } catch (err) { toast(err.message, true); }
}

async function loadOverview() {
  const project = encodeURIComponent(getProject());
  overviewData = await api(`/api/overview?project=${project}`);
  $('statTotal').textContent = overviewData.total ?? 0;
  $('statRunning').textContent = overviewData.running ?? 0;
  $('statStopped').textContent = overviewData.stopped ?? 0;
  $('statIp').textContent = overviewData.external_ip_count ?? 0;
  $('statDisk').textContent = overviewData.disk_gb ?? 0;
  $('statZones').textContent = overviewData.zone_count ?? 0;
  $('statE2Micro').textContent = overviewData.e2_micro_count ?? 0;
  renderZoneSummary();
}

async function loadInstances() {
  const project = encodeURIComponent(getProject());
  instances = await api(`/api/instances?project=${project}`);
  renderInstances();
  renderTrafficInstanceOptions();
}

function renderZoneSummary() {
  const row = $('zoneSummary');
  const byZone = overviewData.by_zone || {};
  const items = Object.entries(byZone).sort((a, b) => b[1] - a[1]);
  row.innerHTML = items.length ? items.map(([zone, count]) => `<span class="pill">${escapeHtml(zone)} · ${count}</span>`).join('') : '<span class="pill muted-pill">暂无可用区数据</span>';
}

function filteredInstances() {
  const q = $('instanceFilter').value.trim().toLowerCase();
  const status = $('statusFilter').value;
  return instances.filter(inst => {
    if (status && inst.status !== status) return false;
    if (!q) return true;
    const hay = [inst.name, inst.zone, inst.status, inst.machine_type, inst.internal_ip, inst.external_ip, inst.network].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderInstances() {
  const body = $('instancesBody');
  const list = filteredInstances();
  $('instanceCount').textContent = `${list.length} / ${instances.length} 台实例`;
  if (!list.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty">没有匹配实例</td></tr>';
    return;
  }
  body.innerHTML = list.map(inst => {
    const canStart = inst.status === 'TERMINATED';
    const canStop = inst.status === 'RUNNING';
    const diskGb = (inst.disks || []).reduce((sum, d) => sum + Number(d.disk_gb || 0), 0);
    return `
      <tr>
        <td><strong>${escapeHtml(inst.name)}</strong><small>${escapeHtml(inst.id || '')}</small></td>
        <td>${escapeHtml(inst.zone)}</td>
        <td><span class="badge ${escapeHtml(inst.status)}">${escapeHtml(inst.status)}</span></td>
        <td>${escapeHtml(inst.machine_type)}</td>
        <td>${escapeHtml(inst.internal_ip || '-')}</td>
        <td>${escapeHtml(inst.external_ip || '-')}</td>
        <td>${diskGb || '-'}</td>
        <td>
          <div class="actions">
            <button class="ghost" data-action="start" data-zone="${escapeHtml(inst.zone)}" data-name="${escapeHtml(inst.name)}" ${canStart ? '' : 'disabled'}>开机</button>
            <button class="warn" data-action="stop" data-zone="${escapeHtml(inst.zone)}" data-name="${escapeHtml(inst.name)}" ${canStop ? '' : 'disabled'}>关机</button>
            <button class="ghost" data-action="reset" data-zone="${escapeHtml(inst.zone)}" data-name="${escapeHtml(inst.name)}">重启</button>
            <button class="ghost" data-action="rotate-ip" data-zone="${escapeHtml(inst.zone)}" data-name="${escapeHtml(inst.name)}">换 IP</button>
            <button class="ghost" data-action="copy-ssh" data-ip="${escapeHtml(inst.external_ip || '')}">SSH</button>
            <button class="danger" data-action="delete" data-zone="${escapeHtml(inst.zone)}" data-name="${escapeHtml(inst.name)}">删除</button>
          </div>
        </td>
      </tr>`;
  }).join('');
}

async function handleInstanceButton(event) {
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  const zone = btn.dataset.zone;
  const name = btn.dataset.name;
  if (['start', 'stop', 'reset', 'delete'].includes(action)) return instanceAction(zone, name, action);
  if (action === 'rotate-ip') return rotateIp(zone, name);
  if (action === 'copy-ssh') return copySsh(btn.dataset.ip);
}

function renderTrafficInstanceOptions() {
  const select = $('trafficInstance');
  const current = select.value;
  select.innerHTML = '<option value="">全部实例</option>' + instances.map(i => (
    `<option value="${escapeHtml(`${i.zone}/${i.name}`)}">${escapeHtml(i.name)} · ${escapeHtml(i.zone)}</option>`
  )).join('');
  select.value = current;
}

function formPayload() {
  const form = $('createForm');
  const fd = new FormData(form);
  return {
    project: getProject(),
    zone: fd.get('zone'),
    name: fd.get('name'),
    machine_type: fd.get('machine_type'),
    source_image: fd.get('source_image'),
    disk_gb: Number(fd.get('disk_gb') || 10),
    network: fd.get('network'),
    subnetwork: fd.get('subnetwork') || null,
    external_ip: Boolean(fd.get('external_ip')),
    network_tier: fd.get('network_tier'),
    tags: String(fd.get('tags') || '').split(',').map(x => x.trim()).filter(Boolean),
    startup_script: fd.get('startup_script') || null,
  };
}

async function createInstance(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = formPayload();
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/api/instances', { method: 'POST', body: JSON.stringify(payload) });
    toast(`创建实例完成：${payload.name}`);
    form.reset();
    form.querySelector('input[name="zone"]').value = getDefaultZone();
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

function saveTemplateFromForm() {
  const payload = formPayload();
  const label = prompt('模板名称', payload.name || payload.machine_type || 'quick-create');
  if (!label) return;
  const templates = loadJson(LS_TEMPLATES, []);
  templates.unshift({ label, payload: { ...payload, name: '' }, created_at: new Date().toISOString() });
  saveJson(LS_TEMPLATES, templates.slice(0, 20));
  renderTemplates();
  toast(`快捷开机模板已保存：${label}`);
}

function renderTemplates() {
  const box = $('templateList');
  const templates = loadJson(LS_TEMPLATES, []);
  if (!templates.length) {
    box.innerHTML = '<span class="hint">暂无模板。填好创建表单后点击“保存模板”。</span>';
    return;
  }
  box.innerHTML = templates.map((tpl, idx) => `
    <div class="template-item">
      <button class="ghost" data-template-action="apply" data-index="${idx}">${escapeHtml(tpl.label)}</button>
      <button class="mini danger" data-template-action="delete" data-index="${idx}">×</button>
    </div>`).join('');
}

function handleTemplateButton(event) {
  const btn = event.target.closest('button[data-template-action]');
  if (!btn) return;
  const idx = Number(btn.dataset.index);
  const action = btn.dataset.templateAction;
  const templates = loadJson(LS_TEMPLATES, []);
  const tpl = templates[idx];
  if (!tpl) return;
  if (action === 'delete') {
    templates.splice(idx, 1);
    saveJson(LS_TEMPLATES, templates);
    renderTemplates();
    return;
  }
  applyTemplate(tpl.payload);
  toast(`已应用模板：${tpl.label}`);
}

function applyTemplate(payload) {
  const form = $('createForm');
  for (const [key, value] of Object.entries(payload)) {
    const el = form.elements[key];
    if (!el || key === 'project') continue;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (key === 'tags' && Array.isArray(value)) el.value = value.join(',');
    else el.value = value ?? '';
  }
  if (!form.elements.zone.value) form.elements.zone.value = getDefaultZone();
}

async function instanceAction(zone, name, action) {
  const label = { start: '开机', stop: '关机', reset: '重启', delete: '删除' }[action] || action;
  if (action === 'delete') {
    const typed = prompt(`删除实例 ${name} 不可逆。请输入实例名称确认：`);
    if (typed !== name) { toast('删除已取消：实例名称不匹配', true); return; }
  } else if (!confirm(`确定对 ${name} 执行 ${label}？`)) return;
  try {
    await api('/api/instances/action', {
      method: 'POST',
      body: JSON.stringify({ project: getProject(), zone, name, action }),
    });
    toast(`${label} 完成：${name}`);
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function rotateIp(zone, name) {
  const cf = getCfSettings();
  const cfText = cf.enabled ? '\n并尝试更新 Cloudflare DNS A 记录。' : '';
  if (!confirm(`确定给 ${name} 重新分配外部临时 IP？${cfText}`)) return;
  try {
    const data = await api('/api/instances/rotate-ip', {
      method: 'POST',
      body: JSON.stringify({
        project: getProject(),
        zone,
        name,
        network_interface: 'nic0',
        update_cloudflare_dns: Boolean(cf.enabled),
        cloudflare_zone_id: cf.zone_id || null,
        cloudflare_record_id: cf.record_id || null,
        cloudflare_record_name: cf.record_name || null,
        cloudflare_record_type: 'A',
      }),
    });
    toast(`换 IP 完成：${data.old_ip || '-'} -> ${data.new_ip || '-'}` + (data.cloudflare_dns ? '，DNS 已更新' : ''));
    await refreshAll();
  } catch (err) {
    toast(err.message, true);
  }
}

async function copySsh(ip) {
  if (!ip) { toast('该实例没有外部 IP', true); return; }
  const command = `ssh ${ip}`;
  try {
    await navigator.clipboard.writeText(command);
    toast(`已复制 SSH 命令：${command}`);
  } catch {
    prompt('复制 SSH 命令', command);
  }
}

function getCfSettings() {
  return loadJson(LS_CF, { enabled: false, zone_id: '', record_id: '', record_name: '' });
}

function loadCfSettings() {
  const cf = getCfSettings();
  $('cfEnabled').checked = Boolean(cf.enabled);
  $('cfZoneId').value = cf.zone_id || '';
  $('cfRecordId').value = cf.record_id || '';
  $('cfRecordName').value = cf.record_name || '';
}

function saveCfSettings() {
  saveJson(LS_CF, {
    enabled: $('cfEnabled').checked,
    zone_id: $('cfZoneId').value.trim(),
    record_id: $('cfRecordId').value.trim(),
    record_name: $('cfRecordName').value.trim(),
  });
  toast('Cloudflare DNS 设置已保存');
}

async function queryTraffic() {
  const hours = Number($('trafficHours').value || 24);
  const selected = $('trafficInstance').value;
  const params = new URLSearchParams({ project: getProject(), hours: String(hours) });
  if (selected) {
    const [zone, name] = selected.split('/');
    params.set('zone', zone);
    params.set('instance', name);
  }
  try {
    const data = await api(`/api/traffic?${params.toString()}`);
    trafficSeries = data.series || [];
    $('trafficSent').textContent = bytes(data.total_sent_bytes);
    $('trafficReceived').textContent = bytes(data.total_received_bytes);
    $('trafficTotal').textContent = bytes((data.total_sent_bytes || 0) + (data.total_received_bytes || 0));
    renderTrafficTable();
    drawChart();
    toast('流量查询完成');
  } catch (err) {
    toast(err.message, true);
  }
}

function renderTrafficTable() {
  const body = $('trafficBody');
  if (!trafficSeries.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty">没有查询到流量数据</td></tr>';
    return;
  }
  body.innerHTML = trafficSeries.slice().reverse().map(row => `
    <tr>
      <td>${escapeHtml(row.time)}</td>
      <td>${bytes(row.sent_bytes)}</td>
      <td>${bytes(row.received_bytes)}</td>
      <td>${bytes(row.total_bytes)}</td>
    </tr>`).join('');
}

function drawChart() {
  const canvas = $('trafficChart');
  const ctx = canvas.getContext('2d');
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(600, Math.floor(rect.width * dpr));
  canvas.height = Math.floor(220 * dpr);
  ctx.scale(dpr, dpr);

  const w = canvas.width / dpr;
  const h = canvas.height / dpr;
  ctx.clearRect(0, 0, w, h);
  ctx.font = '12px system-ui';
  ctx.fillStyle = '#94a3b8';

  if (!trafficSeries.length) {
    ctx.fillText('暂无数据', 20, 36);
    return;
  }

  const pad = { left: 46, right: 18, top: 18, bottom: 34 };
  const points = trafficSeries.map(x => x.total_bytes || 0);
  const max = Math.max(...points, 1);
  const min = 0;
  const plotW = w - pad.left - pad.right;
  const plotH = h - pad.top - pad.bottom;

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (plotH * i / 4);
    ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    const label = bytes(max * (1 - i / 4));
    ctx.fillText(label, 6, y + 4);
  }

  ctx.strokeStyle = '#7dd3fc';
  ctx.lineWidth = 2;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = pad.left + (points.length === 1 ? plotW : plotW * i / (points.length - 1));
    const y = pad.top + plotH - ((p - min) / (max - min || 1)) * plotH;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = '#7dd3fc';
  points.forEach((p, i) => {
    const x = pad.left + (points.length === 1 ? plotW : plotW * i / (points.length - 1));
    const y = pad.top + plotH - ((p - min) / (max - min || 1)) * plotH;
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  });
}

window.addEventListener('resize', () => drawChart());
init().catch(err => toast(err.message, true));
