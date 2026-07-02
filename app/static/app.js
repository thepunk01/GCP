const $ = (id) => document.getElementById(id);

let instances = [];
let overviewData = {};
let trafficSeries = [];
let appConfig = {};
let managedServers = [];
let commandPresets = [];
let startupScripts = [];
let monitorConfig = {};
let opsEvents = [];

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
  await refreshOps();
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
  bindOpsEvents();
}

async function refreshConfig() {
  const cfg = await fetch('/api/config').then(r => r.json());
  appConfig = cfg.data || appConfig;
  renderConfigStatus();
}

async function refreshAll() {
  saveProfile(true);
  if (!getProject()) {
    clearGcpViews('未填写 Project ID。管理面板已运行，可先添加服务器资产；GCP 实例功能稍后在 Profile 中填写 Project ID。');
    return;
  }
  try {
    await Promise.all([loadOverview(), loadInstances()]);
    addLog('实例和概览已刷新');
  } catch (err) {
    toast(err.message, true);
  }
}

function clearGcpViews(message = '暂无 GCP 项目') {
  overviewData = {};
  instances = [];
  ['statTotal','statRunning','statStopped','statIp','statDisk','statZones','statE2Micro'].forEach(id => { if ($(id)) $(id).textContent = '0'; });
  if ($('zoneSummary')) $('zoneSummary').innerHTML = `<span class="pill muted-pill">${escapeHtml(message)}</span>`;
  if ($('instancesBody')) $('instancesBody').innerHTML = `<tr><td colspan="8" class="empty">${escapeHtml(message)}</td></tr>`;
  if ($('instanceCount')) $('instanceCount').textContent = '0 / 0 台实例';
  renderTrafficInstanceOptions();
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


function bindOpsEvents() {
  if ($('refreshOpsBtn')) $('refreshOpsBtn').addEventListener('click', refreshOps);
  if ($('serverForm')) $('serverForm').addEventListener('submit', saveServerFromForm);
  if ($('resetServerFormBtn')) $('resetServerFormBtn').addEventListener('click', resetServerForm);
  if ($('serversBody')) $('serversBody').addEventListener('click', handleServerAction);
  if ($('saveMonitorBtn')) $('saveMonitorBtn').addEventListener('click', saveMonitorConfig);
  if ($('refreshEventsBtn')) $('refreshEventsBtn').addEventListener('click', loadOpsEvents);
  if ($('commandPresetForm')) $('commandPresetForm').addEventListener('submit', saveCommandPreset);
  if ($('commandPresetList')) $('commandPresetList').addEventListener('click', handleCommandPresetAction);
  if ($('runCommandForm')) $('runCommandForm').addEventListener('submit', runCommandSubmit);
  if ($('commandPresetSelect')) $('commandPresetSelect').addEventListener('change', applyCommandPresetToRunForm);
  if ($('startupScriptForm')) $('startupScriptForm').addEventListener('submit', saveStartupScriptPreset);
  if ($('startupScriptList')) $('startupScriptList').addEventListener('click', handleStartupScriptAction);
  if ($('applyStartupScriptBtn')) $('applyStartupScriptBtn').addEventListener('click', applySelectedStartupScript);
}

async function refreshOps() {
  try {
    await Promise.all([loadManagedServers(), loadMonitorConfig(), loadCommandPresets(), loadStartupScripts(), loadOpsEvents()]);
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadManagedServers() {
  managedServers = await api('/api/ops/servers');
  renderManagedServers();
  renderCommandServerList();
}

async function loadMonitorConfig() {
  monitorConfig = await api('/api/ops/monitor');
  if ($('monitorEnabled')) $('monitorEnabled').checked = Boolean(monitorConfig.enabled);
  if ($('monitorInterval')) $('monitorInterval').value = monitorConfig.interval_seconds || 300;
  if ($('monitorParallel')) $('monitorParallel').value = monitorConfig.max_parallel_checks || 5;
}

async function loadCommandPresets() {
  commandPresets = await api('/api/ops/command-presets');
  renderCommandPresets();
  renderCommandPresetOptions();
}

async function loadStartupScripts() {
  startupScripts = await api('/api/ops/startup-scripts');
  renderStartupScripts();
  renderStartupScriptOptions();
}

async function loadOpsEvents() {
  opsEvents = await api('/api/ops/events?limit=80');
  renderOpsEvents();
}

function serverPayloadFromForm() {
  const form = $('serverForm');
  const fd = new FormData(form);
  let replacementTemplate = {};
  const rawTpl = String(fd.get('replacement_template') || '').trim();
  if (rawTpl) {
    try { replacementTemplate = JSON.parse(rawTpl); }
    catch (err) { throw new Error(`替换实例模板 JSON 错误：${err.message}`); }
  }
  const checkType = fd.get('check_type') || 'tcp';
  const pathOrUrl = String(fd.get('check_path') || '/').trim();
  return {
    id: fd.get('id') || null,
    name: String(fd.get('name') || '').trim(),
    host: String(fd.get('host') || '').trim(),
    provider: fd.get('provider') || 'manual',
    project: String(fd.get('project') || '').trim() || null,
    zone: String(fd.get('zone') || '').trim() || null,
    instance_name: String(fd.get('instance_name') || '').trim() || null,
    port: Number(fd.get('check_port') || 22),
    network_interface: 'nic0',
    access_config_name: 'External NAT',
    network_tier: 'PREMIUM',
    check: {
      enabled: Boolean(fd.get('check_enabled')),
      type: checkType,
      port: Number(fd.get('check_port') || (checkType === 'https' ? 443 : checkType === 'http' ? 80 : 22)),
      path: pathOrUrl.startsWith('http') ? '/' : pathOrUrl,
      url: pathOrUrl.startsWith('http') ? pathOrUrl : null,
      timeout_seconds: Number(fd.get('timeout_seconds') || 5),
      interval_seconds: fd.get('interval_seconds') ? Number(fd.get('interval_seconds')) : null,
      failure_threshold: Number(fd.get('failure_threshold') || 3),
      action_cooldown_seconds: 900,
      rotate_ip_on_blocked: Boolean(fd.get('rotate_ip_on_blocked')),
      replace_on_unavailable: Boolean(fd.get('replace_on_unavailable')),
    },
    ssh: {
      username: String(fd.get('ssh_username') || '').trim() || null,
      port: Number(fd.get('ssh_port') || 22),
      password: String(fd.get('ssh_password') || '') || null,
      private_key: String(fd.get('ssh_private_key') || '') || null,
    },
    replacement: {
      delete_old_after_replace: Boolean(fd.get('delete_old_after_replace')),
      template: replacementTemplate,
    },
  };
}

async function saveServerFromForm(event) {
  event.preventDefault();
  try {
    const payload = serverPayloadFromForm();
    const method = payload.id ? 'PUT' : 'POST';
    const path = payload.id ? `/api/ops/servers/${encodeURIComponent(payload.id)}` : '/api/ops/servers';
    await api(path, { method, body: JSON.stringify(payload) });
    toast(`服务器已保存：${payload.name}`);
    resetServerForm();
    await loadManagedServers();
  } catch (err) { toast(err.message, true); }
}

function resetServerForm() {
  const form = $('serverForm');
  form.reset();
  form.elements.id.value = '';
  form.elements.check_enabled.checked = true;
  form.elements.check_port.value = 22;
  form.elements.failure_threshold.value = 3;
  form.elements.timeout_seconds.value = 5;
  form.elements.ssh_port.value = 22;
}

function renderManagedServers() {
  const body = $('serversBody');
  if (!body) return;
  if (!managedServers.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty">暂无服务器。你可以先添加已经开机的服务器 IP。</td></tr>';
    return;
  }
  body.innerHTML = managedServers.map(server => {
    const st = server.state || {};
    const check = server.check || {};
    const actions = [];
    if (check.rotate_ip_on_blocked) actions.push('失败换 IP');
    if (check.replace_on_unavailable) actions.push('失败替换');
    return `<tr>
      <td><strong>${escapeHtml(server.name)}</strong><small>${escapeHtml(server.instance_name || server.id || '')}</small></td>
      <td>${escapeHtml(server.host)}<small>${escapeHtml((check.type || 'tcp').toUpperCase())} ${escapeHtml(st.last_target || '')}</small></td>
      <td>${escapeHtml(server.provider || 'manual')}</td>
      <td><span class="badge ${st.last_status === 'ok' ? 'RUNNING' : st.last_status === 'failed' ? 'TERMINATED' : ''}">${escapeHtml(st.last_status || 'unknown')}</span><small>${escapeHtml(st.last_error || st.last_checked_at || '')}</small></td>
      <td>${Number(st.consecutive_failures || 0)}</td>
      <td>${actions.length ? actions.map(x => `<span class="pill">${escapeHtml(x)}</span>`).join(' ') : '<span class="hint">无</span>'}</td>
      <td><div class="actions">
        <button class="ghost" data-server-action="check" data-id="${escapeHtml(server.id)}">检测</button>
        <button class="ghost" data-server-action="edit" data-id="${escapeHtml(server.id)}">编辑</button>
        <button class="ghost" data-server-action="rotate" data-id="${escapeHtml(server.id)}" ${server.provider === 'gcp' ? '' : 'disabled'}>换 IP</button>
        <button class="warn" data-server-action="replace" data-id="${escapeHtml(server.id)}" ${server.provider === 'gcp' ? '' : 'disabled'}>替换</button>
        <button class="danger" data-server-action="delete" data-id="${escapeHtml(server.id)}">删除</button>
      </div></td>
    </tr>`;
  }).join('');
}

async function handleServerAction(event) {
  const btn = event.target.closest('button[data-server-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.serverAction;
  const server = managedServers.find(x => x.id === id);
  if (!server) return;
  try {
    if (action === 'edit') return fillServerForm(server);
    if (action === 'delete') {
      if (!confirm(`确定删除服务器资产：${server.name}？`)) return;
      await api(`/api/ops/servers/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(`已删除服务器：${server.name}`);
      return refreshOps();
    }
    if (action === 'check') {
      const result = await api(`/api/ops/servers/${encodeURIComponent(id)}/check`, { method: 'POST' });
      toast(`${server.name} 检测：${result.probe.ok ? '可用' : '不可用'}${result.probe.error ? ' · ' + result.probe.error : ''}`, !result.probe.ok);
      return refreshOps();
    }
    if (action === 'rotate') {
      if (!confirm(`确定给 ${server.name} 换外部 IP？`)) return;
      await api(`/api/ops/servers/${encodeURIComponent(id)}/rotate-ip`, { method: 'POST' });
      toast(`已发起换 IP：${server.name}`);
      return refreshOps();
    }
    if (action === 'replace') {
      if (!confirm(`确定创建替换实例：${server.name}？`)) return;
      await api(`/api/ops/servers/${encodeURIComponent(id)}/replace`, { method: 'POST' });
      toast(`已发起实例替换：${server.name}`);
      return refreshOps();
    }
  } catch (err) { toast(err.message, true); }
}

function fillServerForm(server) {
  const form = $('serverForm');
  const check = server.check || {};
  const ssh = server.ssh || {};
  const replacement = server.replacement || {};
  form.elements.id.value = server.id || '';
  form.elements.name.value = server.name || '';
  form.elements.host.value = server.host || '';
  form.elements.provider.value = server.provider || 'manual';
  form.elements.project.value = server.project || '';
  form.elements.zone.value = server.zone || '';
  form.elements.instance_name.value = server.instance_name || '';
  form.elements.check_type.value = check.type || 'tcp';
  form.elements.check_port.value = check.port || server.port || 22;
  form.elements.check_path.value = check.url || check.path || '/';
  form.elements.interval_seconds.value = check.interval_seconds || '';
  form.elements.failure_threshold.value = check.failure_threshold || 3;
  form.elements.timeout_seconds.value = check.timeout_seconds || 5;
  form.elements.check_enabled.checked = check.enabled !== false;
  form.elements.rotate_ip_on_blocked.checked = Boolean(check.rotate_ip_on_blocked);
  form.elements.replace_on_unavailable.checked = Boolean(check.replace_on_unavailable);
  form.elements.delete_old_after_replace.checked = Boolean(replacement.delete_old_after_replace);
  form.elements.ssh_username.value = ssh.username || '';
  form.elements.ssh_port.value = ssh.port || 22;
  form.elements.ssh_password.value = ssh.password || '';
  form.elements.ssh_private_key.value = ssh.private_key || '';
  form.elements.replacement_template.value = replacement.template && Object.keys(replacement.template).length ? JSON.stringify(replacement.template, null, 2) : '';
  location.hash = '#servers';
}

async function saveMonitorConfig() {
  try {
    const payload = {
      enabled: $('monitorEnabled').checked,
      interval_seconds: Number($('monitorInterval').value || 300),
      max_parallel_checks: Number($('monitorParallel').value || 5),
    };
    await api('/api/ops/monitor', { method: 'PUT', body: JSON.stringify(payload) });
    toast(`自动检测已${payload.enabled ? '启用' : '关闭'}，间隔 ${payload.interval_seconds}s`);
    await loadMonitorConfig();
  } catch (err) { toast(err.message, true); }
}

function renderOpsEvents() {
  const box = $('opsEvents');
  if (!box) return;
  if (!opsEvents.length) {
    box.innerHTML = '<div class="empty log-empty">暂无自动化事件</div>';
    return;
  }
  box.innerHTML = opsEvents.slice(0, 60).map(event => `
    <div class="log-row ${escapeHtml(event.level)}">
      <span>${escapeHtml(event.time)}</span>
      <strong>${escapeHtml(event.message)}</strong>
    </div>`).join('');
}

function renderCommandPresets() {
  const box = $('commandPresetList');
  if (!box) return;
  if (!commandPresets.length) {
    box.innerHTML = '<span class="hint">暂无命令预设</span>';
    return;
  }
  box.innerHTML = commandPresets.map(preset => `
    <div class="template-item">
      <button class="ghost" data-cmd-preset-action="use" data-id="${escapeHtml(preset.id)}">${escapeHtml(preset.name)}</button>
      <button class="mini danger" data-cmd-preset-action="delete" data-id="${escapeHtml(preset.id)}">×</button>
    </div>`).join('');
}

function renderCommandPresetOptions() {
  const select = $('commandPresetSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">手动输入命令</option>' + commandPresets.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  select.value = current;
}

async function saveCommandPreset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  try {
    await api('/api/ops/command-presets', { method: 'POST', body: JSON.stringify({ id: fd.get('id') || null, name: fd.get('name'), command: fd.get('command') }) });
    form.reset();
    toast('命令预设已保存');
    await loadCommandPresets();
  } catch (err) { toast(err.message, true); }
}

async function handleCommandPresetAction(event) {
  const btn = event.target.closest('button[data-cmd-preset-action]');
  if (!btn) return;
  const preset = commandPresets.find(p => p.id === btn.dataset.id);
  if (!preset) return;
  if (btn.dataset.cmdPresetAction === 'delete') {
    if (!confirm(`删除命令预设：${preset.name}？`)) return;
    await api(`/api/ops/command-presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' });
    toast('命令预设已删除');
    return loadCommandPresets();
  }
  $('runCommandForm').elements.command.value = preset.command;
  $('commandPresetSelect').value = preset.id;
  location.hash = '#commands';
}

function applyCommandPresetToRunForm() {
  const preset = commandPresets.find(p => p.id === $('commandPresetSelect').value);
  if (preset) $('runCommandForm').elements.command.value = preset.command;
}

function renderCommandServerList() {
  const box = $('commandServerList');
  if (!box) return;
  if (!managedServers.length) {
    box.innerHTML = '<span class="hint">请先添加服务器资产</span>';
    return;
  }
  box.innerHTML = managedServers.map(s => `<label class="inline-check"><input type="checkbox" value="${escapeHtml(s.id)}" /> ${escapeHtml(s.name)} · ${escapeHtml(s.host)}</label>`).join('');
}

async function runCommandSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const serverIds = Array.from($('commandServerList').querySelectorAll('input[type="checkbox"]:checked')).map(x => x.value);
  if (!serverIds.length) { toast('请选择至少一台目标服务器', true); return; }
  const command = form.elements.command.value.trim();
  const presetId = $('commandPresetSelect').value || null;
  if (!command && !presetId) { toast('请选择预设或填写命令', true); return; }
  if (!confirm(`确定向 ${serverIds.length} 台服务器执行命令？`)) return;
  try {
    const results = await api('/api/ops/commands/run', { method: 'POST', body: JSON.stringify({ server_ids: serverIds, preset_id: presetId, command, timeout_seconds: Number(form.elements.timeout_seconds.value || 60) }) });
    $('commandOutput').textContent = JSON.stringify(results, null, 2);
    toast('命令下发完成');
    await loadOpsEvents();
  } catch (err) { toast(err.message, true); }
}

function renderStartupScripts() {
  const box = $('startupScriptList');
  if (!box) return;
  if (!startupScripts.length) {
    box.innerHTML = '<span class="hint">暂无开机脚本预设</span>';
    return;
  }
  box.innerHTML = startupScripts.map(script => `
    <div class="template-item">
      <button class="ghost" data-startup-action="apply" data-id="${escapeHtml(script.id)}">${escapeHtml(script.name)}</button>
      <button class="mini danger" data-startup-action="delete" data-id="${escapeHtml(script.id)}">×</button>
    </div>`).join('');
}

function renderStartupScriptOptions() {
  const select = $('startupScriptSelect');
  if (!select) return;
  const current = select.value;
  select.innerHTML = '<option value="">不使用预设</option>' + startupScripts.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join('');
  select.value = current;
}

async function saveStartupScriptPreset(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const fd = new FormData(form);
  try {
    await api('/api/ops/startup-scripts', { method: 'POST', body: JSON.stringify({ id: fd.get('id') || null, name: fd.get('name'), script: fd.get('script') }) });
    form.reset();
    toast('开机脚本预设已保存');
    await loadStartupScripts();
  } catch (err) { toast(err.message, true); }
}

async function handleStartupScriptAction(event) {
  const btn = event.target.closest('button[data-startup-action]');
  if (!btn) return;
  const script = startupScripts.find(s => s.id === btn.dataset.id);
  if (!script) return;
  if (btn.dataset.startupAction === 'delete') {
    if (!confirm(`删除开机脚本：${script.name}？`)) return;
    await api(`/api/ops/startup-scripts/${encodeURIComponent(script.id)}`, { method: 'DELETE' });
    toast('开机脚本已删除');
    return loadStartupScripts();
  }
  const textarea = $('createForm').elements.startup_script;
  textarea.value = script.script || '';
  $('startupScriptSelect').value = script.id;
  location.hash = '#create';
  toast(`已应用开机脚本：${script.name}`);
}

function applySelectedStartupScript() {
  const script = startupScripts.find(s => s.id === $('startupScriptSelect').value);
  if (!script) { toast('请选择开机脚本预设', true); return; }
  $('createForm').elements.startup_script.value = script.script || '';
  toast(`已应用开机脚本：${script.name}`);
}

window.addEventListener('resize', () => drawChart());
init().catch(err => toast(err.message, true));
