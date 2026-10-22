'use strict';

const T = window.__TAURI__;
const invoke = T.core.invoke;
const listen = T.event.listen;
const IS_ANDROID = /Android/i.test(navigator.userAgent);

const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'DeepSeek 官方开放平台'
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o4-mini'],
    hint: 'OpenAI 官方平台'
  },
  dashscope: {
    label: '阿里通义',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen-vl-max', 'qwen3-235b-a22b'],
    hint: '阿里云百炼（DashScope）'
  },
  moonshot: {
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-latest'],
    hint: '月之暗面 Kimi 开放平台'
  },
  zhipu: {
    label: '智谱',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash', 'glm-4v-plus'],
    hint: '智谱 AI 开放平台'
  }
};

const MODE_LABEL = { relay: '中转站', official: '官方', expert: '开发者' };

let cfg = { providers: [], activeId: null };
let roleStore = { roles: [], groups: [] };
let chatStore = { chats: [] };

let view = 'chats';
let currentChatId = null;
let live = null;
let stopFlag = false;
let pendingAttach = [];
let sheetMode = null;
let draftProvider = null;

const $ = (sel, root = document) => root.querySelector(sel);
const stage = $('#stage');
const topbar = $('#topbar');
const tabs = $('#tabs');
const sheetEl = $('#sheet');
const sheetCard = $('#sheet-card');
const toastEl = $('#toast');

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(text) {
  toastEl.textContent = text;
  toastEl.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toastEl.hidden = true; }, 2400);
}

function md(text) {
  let h = esc(text);
  h = h.replace(/```([\w+-]*)\n([\s\S]*?)```/g, (_, lang, code) => `<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return h;
}

const shortTime = (ts) => {
  const d = new Date(ts);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  return same
    ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    : `${d.getMonth() + 1}/${d.getDate()}`;
};

/* ---------------- 持久化 ---------------- */

const saveConfig = () => invoke('save_file', { name: 'config', data: cfg }).catch(() => {});
const saveRoles = () => invoke('save_file', { name: 'roles', data: roleStore }).catch(() => {});
const saveChats = () => invoke('save_file', { name: 'chats', data: chatStore }).catch(() => {});

async function boot() {
  const data = await invoke('load_all');
  if (data.config && Array.isArray(data.config.providers)) {
    cfg = { providers: data.config.providers, activeId: data.config.activeId || null };
  }
  if (data.roles) {
    roleStore = {
      roles: Array.isArray(data.roles.roles) ? data.roles.roles : [],
      groups: Array.isArray(data.roles.groups) ? data.roles.groups : []
    };
  }
  if (data.chats && Array.isArray(data.chats.chats)) chatStore = { chats: data.chats.chats };

  if (!cfg.providers.length) {
    view = 'settings';
    render();
    setTimeout(() => openProviderSheet(null, 'relay'), 220);
  } else {
    render();
  }
}

/* ---------------- 数据辅助 ---------------- */

const activeProvider = () => cfg.providers.find((p) => p.id === cfg.activeId) || cfg.providers[0] || null;
const chatById = (id) => chatStore.chats.find((c) => c.id === id);
const roleById = (id) => roleStore.roles.find((r) => r.id === id);
const groupById = (id) => roleStore.groups.find((g) => g.id === id);

function newChat(opts = {}) {
  const chat = {
    id: uid(),
    title: opts.title || '新对话',
    providerId: (activeProvider() || {}).id || null,
    roleId: opts.roleId || null,
    groupId: opts.groupId || null,
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  chatStore.chats.unshift(chat);
  saveChats();
  return chat;
}

function openChat(id) {
  currentChatId = id;
  view = 'chat';
  render();
}

/* ---------------- 渲染 ---------------- */

function render() {
  tabs.hidden = view === 'chat';
  document.querySelectorAll('#tabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.view === view);
  });
  if (view === 'chat') renderChat();
  else if (view === 'roles') renderRoles();
  else if (view === 'settings') renderSettings();
  else renderChats();
}

function setTop(title, sub, actions = []) {
  topbar.innerHTML = `
    <div class="title">${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}</div>
    ${actions.map((a, i) => `<button class="icon-btn" data-top="${i}" aria-label="${esc(a.label)}">${a.icon}</button>`).join('')}
  `;
  actions.forEach((a, i) => {
    const el = topbar.querySelector(`[data-top="${i}"]`);
    if (el) el.onclick = a.onClick;
  });
}

const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>',
  send: '<svg viewBox="0 0 24 24"><path d="M4.5 12h14M13 6.5 18.5 12 13 17.5"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="7.5" y="7.5" width="9" height="9" rx="1.6" fill="currentColor" stroke="none"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><path d="M17.5 8.5 10 16a3.2 3.2 0 0 1-4.5-4.5l7-7a4.2 4.2 0 0 1 6 6l-7.2 7.2"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4.5 19.5h4L20 8a2.5 2.5 0 0 0-3.5-3.5L5 16v3.5Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4.5 7h15M9.5 7V4.8h5V7M7 7l.8 12.2h8.4L17 7"/></svg>'
};

/* ---------------- 对话列表 ---------------- */

function renderChats() {
  const p = activeProvider();
  setTop('轻语 Breeze', p ? `${MODE_LABEL[p.mode] || '方案'} · ${p.model}` : '还没有配置模型', [
    { label: '新对话', icon: ICON.plus, onClick: () => openChat(newChat().id) }
  ]);

  if (!chatStore.chats.length) {
    stage.innerHTML = `
      <div class="hero">
        <h1>说点什么</h1>
        <p>${p ? '直接开始，或先去角色里挑一个人设。' : '先到设置里填一个 API Key，三十秒搞定。'}</p>
      </div>
      <div class="card">
        <h3>快捷开始</h3>
        <div class="row">
          <button class="btn primary grow" data-act="new">空白对话</button>
          <button class="btn grow" data-act="roles">选角色</button>
        </div>
      </div>`;
    stage.querySelector('[data-act="new"]').onclick = () => openChat(newChat().id);
    stage.querySelector('[data-act="roles"]').onclick = () => { view = 'roles'; render(); };
    return;
  }

  stage.innerHTML = `<div class="list">${chatStore.chats.map((c) => {
    const role = c.groupId ? groupById(c.groupId) : roleById(c.roleId);
    const last = c.messages[c.messages.length - 1];
    const name = role ? (c.groupId ? `${role.emoji || '◈'} ${role.name}` : role.name) : '自由对话';
    const preview = last ? (last.text || (last.images && last.images.length ? '[图片]' : '')).replace(/\s+/g, ' ').slice(0, 40) : '还没有消息';
    return `<div class="item" data-chat="${c.id}">
      <div class="avatar">${role ? esc(role.emoji || '◈') : '✧'}</div>
      <div class="item-body">
        <div class="item-title">${esc(c.title)}</div>
        <div class="item-sub">${esc(name)} · ${esc(preview)}</div>
      </div>
      <div class="item-meta">${shortTime(c.updatedAt)}</div>
    </div>`;
  }).join('')}</div>`;

  stage.querySelectorAll('[data-chat]').forEach((el) => {
    el.onclick = () => openChat(el.dataset.chat);
  });
}

/* ---------------- 聊天 ---------------- */

function renderChat() {
  const chat = chatById(currentChatId);
  if (!chat) { view = 'chats'; render(); return; }

  const role = chat.groupId ? groupById(chat.groupId) : roleById(chat.roleId);
  setTop(chat.title, role ? (role.name || '') : '自由对话', [
    { label: '返回', icon: ICON.back, onClick: () => { view = 'chats'; currentChatId = null; render(); } },
    { label: '更多', icon: ICON.more, onClick: () => chatMenu(chat) }
  ]);

  stage.classList.add('chat-mode');
  stage.innerHTML = `
    <div class="chat-wrap">
      <div id="chat-log"></div>
      <div id="composer">
        <div class="attach-row" id="attach-row"></div>
        <div class="input-row">
          <button class="icon-btn" id="btn-attach" aria-label="附件">${ICON.clip}</button>
          <textarea id="input" rows="1" placeholder="发消息…"></textarea>
          <button class="send" id="send" aria-label="发送">${ICON.send}</button>
        </div>
      </div>
    </div>`;

  renderLog(chat);
  renderAttach();
  const input = $('#input');
  input.value = sessionStorage.getItem('breeze-draft') || '';
  autoGrow(input);
  input.addEventListener('input', () => {
    autoGrow(input);
    sessionStorage.setItem('breeze-draft', input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !IS_ANDROID) {
      e.preventDefault();
      send();
    }
  });
  $('#btn-attach').onclick = pickAttachments;
  $('#send').onclick = () => (live ? stopStream() : send());
}

function renderLog(chat) {
  const log = $('#chat-log');
  if (!log) return;
  if (!chat.messages.length) {
    log.innerHTML = `<div class="empty"><b>开始吧</b>${chat.groupId ? '群聊里每个角色会依次发言' : '直接输入问题，或附加一张图片'}</div>`;
    return;
  }
  log.innerHTML = chat.messages.map((m, i) => msgHtml(m, i)).join('');
  scrollLog();
}

function msgHtml(m, i) {
  const who = m.role === 'user' ? '我' : (m.name || 'AI');
  if (m.role === 'user') {
    const imgs = (m.images || []).map((im) => `<img src="data:${esc(im.mime)};base64,${im.data}" alt="">`).join('');
    const notes = (m.files || []).map((f) => `<div class="file-note">📎 ${esc(f)}</div>`).join('');
    return `<div class="msg user"><div class="bubble">${esc(m.text || '').replace(/\n/g, '<br>')}${imgs}${notes}</div></div>`;
  }
  const think = m.reasoning ? `<div class="think">${esc(m.reasoning)}</div>` : '';
  const body = m.text ? md(m.text) : '';
  const cls = m.error ? 'msg bot err' : 'msg bot';
  return `<div class="${cls}" data-i="${i}">
    <div class="who">${esc(who)} · ${shortTime(m.ts || Date.now())}</div>
    ${think}<div class="bubble">${body}</div>
  </div>`;
}

function scrollLog() {
  const log = $('#chat-log');
  if (log) log.scrollTop = log.scrollHeight;
}

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 132) + 'px';
}

function chatMenu(chat) {
  openSheet('对话设置', `
    <div class="field"><label>标题</label><input id="m-title" type="text" value="${esc(chat.title)}"></div>
    <div class="sheet-actions">
      <button class="btn danger" id="m-del">删除对话</button>
      <button class="btn primary" id="m-save">保存</button>
    </div>`);
  $('#m-save').onclick = () => {
    chat.title = $('#m-title').value.trim() || '新对话';
    saveChats(); closeSheet(); render();
  };
  $('#m-del').onclick = () => {
    chatStore.chats = chatStore.chats.filter((c) => c.id !== chat.id);
    saveChats(); closeSheet();
    view = 'chats'; currentChatId = null; render();
  };
}

/* ---------------- 附件 ---------------- */

function pickAttachments() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'image/*,.txt,.md,.json,.csv,.log,.yaml,.yml,.html,.xml,.js,.ts,.py,.rs,.pdf';
  input.onchange = async () => {
    for (const file of input.files) addAttachment(file);
  };
  input.click();
}

async function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result);
      resolve(s.slice(s.indexOf(',') + 1));
    };
    fr.onerror = () => reject(new Error('读取失败'));
    fr.readAsDataURL(file);
  });
}

function isTextMime(mime, name) {
  if (mime.startsWith('text/')) return true;
  const ext = (name.split('.').pop() || '').toLowerCase();
  return ['txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml', 'html', 'xml', 'js', 'ts', 'py', 'rs', 'toml', 'ini', 'sql', 'sh'].includes(ext);
}

async function addAttachment(file) {
  if (file.size > 12 * 1024 * 1024) { toast('文件超过 12MB'); return; }
  try {
    const data = await readAsBase64(file);
    let text = null;
    if (isTextMime(file.type || '', file.name)) {
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).slice(0, 20000);
      } catch (_) { text = null; }
    }
    pendingAttach.push({
      name: file.name,
      mime: file.type || 'application/octet-stream',
      data,
      text,
      image: (file.type || '').startsWith('image/')
    });
    renderAttach();
  } catch (e) {
    toast('附加失败：' + e.message);
  }
}

function renderAttach() {
  const row = $('#attach-row');
  if (!row) return;
  row.innerHTML = pendingAttach.map((a, i) => `
    <div class="attach-tag"><span>${a.image ? '🖼' : '📎'} ${esc(a.name)}</span><b data-x="${i}">✕</b></div>
  `).join('');
  row.querySelectorAll('[data-x]').forEach((el) => {
    el.onclick = () => { pendingAttach.splice(Number(el.dataset.x), 1); renderAttach(); };
  });
}

/* ---------------- 发送 / 流式 ---------------- */

function composeContent(msg) {
  const parts = [];
  let text = msg.text || '';
  for (const f of msg.files || []) {
    if (f.text) text += `\n\n【附件：${f.name}】\n${f.text}`;
    else if (!f.image) text += `\n\n【附件：${f.name}（二进制文件，未解析内容）】`;
  }
  if (!(msg.images || []).length) return text;
  if (text.trim()) parts.push({ type: 'text', text });
  for (const im of msg.images) {
    parts.push({ type: 'image_url', image_url: { url: `data:${im.mime};base64,${im.data}` } });
  }
  return parts;
}

function buildMessages(chat, persona) {
  const out = [];
  let system = (persona && persona.system) || '';
  const knowledge = persona && persona.knowledge ? persona.knowledge : '';
  if (knowledge.trim()) system += `\n\n【可参考的资料】\n${knowledge.trim()}`;
  if (system.trim()) out.push({ role: 'system', content: system.trim() });

  const full = chat.messages;
  const userIdx = [];
  full.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
  const keepImages = new Set(userIdx.slice(-2));

  for (let i = Math.max(0, full.length - 24); i < full.length; i++) {
    const m = full[i];
    if (m.error) continue;
    if (m.role === 'user') {
      const copy = { ...m, images: keepImages.has(i) ? m.images : [] };
      out.push({ role: 'user', content: composeContent(copy) });
    } else if (m.text) {
      const prefix = chat.groupId ? `${m.name || 'AI'}：` : '';
      out.push({ role: 'assistant', content: prefix + m.text });
    }
  }
  return out;
}

async function send() {
  const chat = chatById(currentChatId);
  if (!chat) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text && !pendingAttach.length) return;

  const provider = cfg.providers.find((p) => p.id === chat.providerId) || activeProvider();
  if (!provider) { toast('还没有配置模型方案'); openProviderSheet(null, 'relay'); return; }

  const images = pendingAttach.filter((a) => a.image).map((a) => ({ mime: a.mime, data: a.data }));
  const files = pendingAttach.filter((a) => !a.image).map((a) => ({ name: a.name, text: a.text }));

  chat.messages.push({ role: 'user', text, images, files, ts: Date.now() });
  pendingAttach = [];
  input.value = '';
  sessionStorage.removeItem('breeze-draft');
  autoGrow(input);
  renderAttach();
  if (chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = text.slice(0, 18) || '图片对话';
  }
  chat.updatedAt = Date.now();
  saveChats();
  renderLog(chat);
  setBusy(true);
  stopFlag = false;

  let personas;
  if (chat.groupId) {
    const group = groupById(chat.groupId);
    personas = (group ? group.roleIds : []).map(roleById).filter(Boolean);
    if (!personas.length) personas = [null];
  } else {
    personas = [roleById(chat.roleId) || null];
  }

  try {
    for (const persona of personas) {
      if (stopFlag) break;
      await runOne(chat, provider, persona);
    }
  } finally {
    setBusy(false);
    chat.updatedAt = Date.now();
    saveChats();
    render();
  }
}

function setBusy(busy) {
  const btn = $('#send');
  if (!btn) return;
  btn.innerHTML = busy ? ICON.stop : ICON.send;
  btn.classList.toggle('stop', busy);
}

async function runOne(chat, provider, persona) {
  const msg = {
    role: 'assistant',
    name: persona ? persona.name : (provider.model || 'AI'),
    text: '',
    reasoning: '',
    ts: Date.now()
  };
  chat.messages.push(msg);
  renderLog(chat);

  const reqId = uid();
  live = { id: reqId, chatId: chat.id, index: chat.messages.length - 1, cancelled: false, buf: '', rbuf: '' };

  const payload = {
    id: reqId,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    model: provider.model,
    messages: buildMessages(chat, persona),
    stream: true,
    temperature: provider.temperature ?? 0.7,
    topP: provider.topP ?? null,
    maxTokens: provider.maxTokens ?? null,
    reasoningEffort: provider.reasoning && provider.reasoning !== 'none' ? provider.reasoning : null,
    thinking: provider.thinking || null,
    extraHeaders: provider.extraHeaders || null,
    extraBody: provider.extraBody || null,
    exactPath: provider.exactPath || null,
    timeoutSecs: provider.timeoutSecs ?? null
  };

  try {
    await invoke('chat_start', { req: payload });
  } catch (e) {
    msg.error = true;
    msg.text = '启动失败：' + e;
    renderLog(chat);
    live = null;
    return;
  }

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (!live || live.id !== reqId) { clearInterval(check); resolve(); }
    }, 120);
    live.resolve = () => { clearInterval(check); resolve(); };
  });
}

async function stopStream() {
  if (!live) return;
  stopFlag = true;
  live.cancelled = true;
  try { await invoke('chat_cancel', { id: live.id }); } catch (_) {}
  setBusy(false);
}

const listenersReady = listen('breeze://chat', (event) => {
  const { id, event: ev } = event.payload || {};
  if (!live || live.id !== id) return;
  const chat = chatById(live.chatId);
  if (!chat) return;
  const msg = chat.messages[live.index];
  if (!msg) return;

  if (ev.type === 'delta') {
    msg.text += ev.text || '';
  } else if (ev.type === 'reasoning') {
    msg.reasoning += ev.text || '';
  } else if (ev.type === 'error') {
    if (!msg.text.trim()) {
      msg.error = true;
      msg.text = ev.message || '出错了';
    } else {
      msg.text += `\n\n[中断：${ev.message || ''}]`;
    }
    finishLive();
    return;
  } else if (ev.type === 'done') {
    if (!msg.text.trim() && !msg.error) {
      msg.error = true;
      msg.text = '模型没有返回内容，检查模型名是否正确。';
    }
    finishLive();
    return;
  }
  paintLive(chat);
});

function paintLive(chat) {
  const host = $(`.msg.bot[data-i="${live.index}"]`);
  if (!host) { renderLog(chat); return; }
  const msg = chat.messages[live.index];
  const thinkEl = host.querySelector('.think');
  if (msg.reasoning) {
    if (thinkEl) thinkEl.textContent = msg.reasoning;
    else host.insertAdjacentHTML('afterbegin', `<div class="think">${esc(msg.reasoning)}</div>`);
  }
  const bubble = host.querySelector('.bubble');
  if (bubble) bubble.innerHTML = md(msg.text) + (live ? '<span class="cursor"></span>' : '');
  scrollLog();
}

function finishLive() {
  if (!live) return;
  const chat = chatById(live.chatId);
  if (chat) renderLog(chat);
  saveChats();
  const done = live.resolve;
  live = null;
  setBusy(false);
  if (done) done();
}

/* ---------------- 角色 / 群聊 ---------------- */

function renderRoles() {
  setTop('角色', `${roleStore.roles.length} 个人设 · ${roleStore.groups.length} 个群`, [
    { label: '新建角色', icon: ICON.plus, onClick: () => roleSheet(null) },
    { label: '导入', icon: ICON.edit, onClick: importSheet }
  ]);

  const groups = roleStore.groups.map((g) => {
    const names = (g.roleIds || []).map((id) => (roleById(id) || {}).name).filter(Boolean).join('、');
    return `<div class="item" data-group="${g.id}">
      <div class="avatar">${esc(g.emoji || '◈')}</div>
      <div class="item-body">
        <div class="item-title">${esc(g.name)} <span class="tag">群聊</span></div>
        <div class="item-sub">${esc(names || '还没有成员')}</div>
      </div>
    </div>`;
  }).join('');

  const roles = roleStore.roles.map((r) => `
    <div class="item" data-role="${r.id}">
      <div class="avatar">${esc(r.emoji || r.name.slice(0, 1))}</div>
      <div class="item-body">
        <div class="item-title">${esc(r.name)}</div>
        <div class="item-sub">${esc((r.system || '').replace(/\s+/g, ' ').slice(0, 52) || '没有人设描述')}</div>
      </div>
    </div>`).join('');

  stage.innerHTML = `
    ${roleStore.groups.length ? `<div class="section-label">群聊</div><div class="list">${groups}</div>` : ''}
    <div class="section-label">角色</div>
    <div class="list">${roles || `<div class="empty"><b>还没有角色</b>新建一个人设，或用 JSON 批量导入</div>`}</div>
    <div class="row" style="margin-top:14px">
      <button class="btn grow" id="new-group">新建群聊</button>
      <button class="btn grow" id="new-role">新建角色</button>
    </div>`;

  stage.querySelectorAll('[data-role]').forEach((el) => {
    el.onclick = () => roleSheet(roleById(el.dataset.role));
  });
  stage.querySelectorAll('[data-group]').forEach((el) => {
    el.onclick = () => groupSheet(groupById(el.dataset.group));
  });
  $('#new-group').onclick = () => groupSheet(null);
  $('#new-role').onclick = () => roleSheet(null);
}

function roleSheet(role) {
  const r = role || { id: uid(), name: '', emoji: '✦', system: '', knowledge: '' };
  openSheet(role ? '编辑角色' : '新建角色', `
    <div class="row">
      <div class="field" style="width:74px"><label>图标</label><input id="r-emoji" type="text" value="${esc(r.emoji)}" maxlength="2"></div>
      <div class="field grow"><label>名字</label><input id="r-name" type="text" value="${esc(r.name)}" placeholder="例如：夜航"></div>
    </div>
    <div class="field"><label>人设 / 系统提示词</label><textarea id="r-system" placeholder="你是一位……">${esc(r.system)}</textarea></div>
    <div class="field"><label>知识库（可选，会随对话一起发送）</label><textarea id="r-knowledge" placeholder="粘贴设定、资料、FAQ…">${esc(r.knowledge || '')}</textarea></div>
    <div class="sheet-actions">
      ${role ? '<button class="btn danger" id="r-del">删除</button><button class="btn" id="r-chat">单独聊</button>' : ''}
      <button class="btn primary" id="r-save">保存</button>
    </div>`);

  if (role) {
    $('#r-chat').onclick = () => {
      const chat = newChat({ title: role.name, roleId: role.id });
      closeSheet();
      view = 'chats';
      openChat(chat.id);
    };
  }

  $('#r-save').onclick = () => {
    const data = {
      id: r.id,
      emoji: $('#r-emoji').value.trim() || '✦',
      name: $('#r-name').value.trim() || '未命名',
      system: $('#r-system').value.trim(),
      knowledge: $('#r-knowledge').value.trim()
    };
    const i = roleStore.roles.findIndex((x) => x.id === r.id);
    if (i >= 0) roleStore.roles[i] = data; else roleStore.roles.push(data);
    saveRoles(); closeSheet(); render();
    toast('已保存');
  };
  if (role) {
    $('#r-del').onclick = () => {
      roleStore.roles = roleStore.roles.filter((x) => x.id !== r.id);
      roleStore.groups.forEach((g) => { g.roleIds = (g.roleIds || []).filter((id) => id !== r.id); });
      saveRoles(); closeSheet(); render();
    };
  }
}

function groupSheet(group) {
  const g = group || { id: uid(), name: '', emoji: '◈', roleIds: [] };
  if (!roleStore.roles.length) { toast('先建一个角色'); return; }
  openSheet(group ? '编辑群聊' : '新建群聊', `
    <div class="row">
      <div class="field" style="width:74px"><label>图标</label><input id="g-emoji" type="text" value="${esc(g.emoji)}" maxlength="2"></div>
      <div class="field grow"><label>群名</label><input id="g-name" type="text" value="${esc(g.name)}" placeholder="例如：深夜编辑部"></div>
    </div>
    <div class="field"><label>选择成员（会依次发言）</label>
      <div class="chips" id="g-members">
        ${roleStore.roles.map((r) => `<button class="chip ${g.roleIds.includes(r.id) ? 'on' : ''}" data-m="${r.id}">${esc(r.emoji || '')} ${esc(r.name)}</button>`).join('')}
      </div>
    </div>
    <div class="sheet-actions">
      ${group ? '<button class="btn danger" id="g-del">删除</button>' : ''}
      <button class="btn primary" id="g-save">开始</button>
    </div>`);

  const chosen = new Set(g.roleIds);
  $('#g-members').querySelectorAll('[data-m]').forEach((el) => {
    el.onclick = () => {
      const id = el.dataset.m;
      if (chosen.has(id)) { chosen.delete(id); el.classList.remove('on'); }
      else { chosen.add(id); el.classList.add('on'); }
    };
  });

  $('#g-save').onclick = () => {
    if (!chosen.size) { toast('至少选一个成员'); return; }
    const data = {
      id: g.id,
      emoji: $('#g-emoji').value.trim() || '◈',
      name: $('#g-name').value.trim() || '群聊',
      roleIds: [...chosen]
    };
    const i = roleStore.groups.findIndex((x) => x.id === g.id);
    if (i >= 0) roleStore.groups[i] = data; else roleStore.groups.push(data);
    saveRoles(); closeSheet();
    view = 'chats';
    openChat(newChat({ title: data.name, groupId: data.id }).id);
  };
  if (group) {
    $('#g-del').onclick = () => {
      roleStore.groups = roleStore.groups.filter((x) => x.id !== g.id);
      saveRoles(); closeSheet(); render();
    };
  }
}

function importSheet() {
  openSheet('导入角色', `
    <div class="field"><label>粘贴 JSON（数组或 {"roles":[…]}）</label>
      <textarea id="im-json" style="min-height:180px" placeholder='[{"name":"夜航","emoji":"✈","system":"你是…","knowledge":"…"}]'></textarea>
    </div>
    <div class="sheet-actions">
      <button class="btn" id="im-file">选择文件</button>
      <button class="btn primary" id="im-do">导入</button>
    </div>`);
  $('#im-file').onclick = async () => {
    const text = await getFileText();
    if (text) $('#im-json').value = text;
  };
  $('#im-do').onclick = () => {
    const raw = $('#im-json').value.trim();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (e) { toast('JSON 格式有误'); return; }
    const list = Array.isArray(data) ? data : Array.isArray(data.roles) ? data.roles : [data];
    let n = 0;
    for (const item of list) {
      if (!item || !(item.name || item.system)) continue;
      roleStore.roles.push({
        id: uid(),
        name: String(item.name || '未命名'),
        emoji: String(item.emoji || item.avatar || '✦').slice(0, 2),
        system: String(item.system || item.prompt || item.persona || ''),
        knowledge: String(item.knowledge || item.kb || '')
      });
      n++;
    }
    if (!n) { toast('没有可导入的角色'); return; }
    saveRoles(); closeSheet(); render();
    toast(`已导入 ${n} 个角色`);
  };
}

/* ---------------- 设置 ---------------- */

function renderSettings() {
  const p = activeProvider();
  setTop('设置', '一次配置，处处可用', [
    { label: '新增方案', icon: ICON.plus, onClick: () => openProviderSheet(null, 'relay') }
  ]);

  const providers = cfg.providers.map((it) => `
    <div class="item" data-prov="${it.id}">
      <div class="avatar">${it.id === cfg.activeId ? '✓' : '·'}</div>
      <div class="item-body">
        <div class="item-title">${esc(it.name)} ${it.id === cfg.activeId ? '<span class="tag">使用中</span>' : ''}</div>
        <div class="item-sub">${esc(MODE_LABEL[it.mode] || '')} · ${esc(it.model)}</div>
      </div>
    </div>`).join('');

  stage.innerHTML = `
    <div class="card">
      <h3>模型方案</h3>
      <div class="list">${providers || '<div class="empty" style="padding:22px 0">还没有方案，点右上角 + 添加</div>'}</div>
      ${p ? `<div class="mini-note">当前：${esc(p.name)} · ${esc(p.model)}${p.baseUrl ? ' · ' + esc(p.baseUrl.replace(/^https?:\/\//, '')) : ''}</div>` : ''}
    </div>

    <div class="card">
      <h3>数据</h3>
      <div class="row">
        <button class="btn grow" id="s-export">导出全部</button>
        <button class="btn grow" id="s-import">导入备份</button>
      </div>
      <div class="mini-note">导出的 JSON 含方案、角色与对话，换设备直接导入即可。</div>
    </div>

    <div class="card">
      <h3>关于</h3>
      <div class="mini-note">
        Breeze 轻语 · 纯本地存储，API Key 只存在你自己的设备里，不经过任何第三方服务器。<br>
        Rust + Tauri 构建，同一套代码跑在 Android 与 Windows。
      </div>
      <div class="row" style="margin-top:12px">
        <button class="btn grow" id="s-clear">清空全部数据</button>
      </div>
    </div>`;

  stage.querySelectorAll('[data-prov]').forEach((el) => {
    el.onclick = () => {
      const item = cfg.providers.find((x) => x.id === el.dataset.prov);
      if (!item) return;
      if (cfg.activeId !== item.id) {
        cfg.activeId = item.id;
        saveConfig();
        render();
        toast(`已切换到 ${item.name}`);
      }
      setTimeout(() => openProviderSheet(item), 260);
    };
  });

  $('#s-export').onclick = exportSheet;
  $('#s-import').onclick = backupImport;
  $('#s-clear').onclick = () => {
    openSheet('清空全部数据', `
      <div class="mini-note">将删除所有方案、角色和对话，且无法恢复。</div>
      <div class="sheet-actions">
        <button class="btn" id="c-no">取消</button>
        <button class="btn danger" id="c-yes">确认清空</button>
      </div>`);
    $('#c-no').onclick = closeSheet;
    $('#c-yes').onclick = async () => {
      cfg = { providers: [], activeId: null };
      roleStore = { roles: [], groups: [] };
      chatStore = { chats: [] };
      await Promise.all([saveConfig(), saveRoles(), saveChats()]);
      closeSheet(); render();
      toast('已清空');
    };
  };
}

function openProviderSheet(item, mode) {
  const isNew = !item;
  const p = item || {
    id: uid(), name: '', mode: mode || 'relay', baseUrl: '', apiKey: '', model: '',
    models: [], reasoning: 'none', temperature: 0.7, topP: null, maxTokens: null,
    exactPath: '', extraHeaders: null, extraBody: null, thinking: null, timeoutSecs: null
  };
  draftProvider = JSON.parse(JSON.stringify(p));
  sheetMode = p.mode;
  paintProviderSheet(isNew);
}

function paintProviderSheet(isNew) {
  const p = draftProvider;
  const mode = sheetMode;

  const head = `
    <div class="seg" id="p-mode">
      <button data-mode="relay" class="${mode === 'relay' ? 'on' : ''}">中转站</button>
      <button data-mode="official" class="${mode === 'official' ? 'on' : ''}">官方平台</button>
      <button data-mode="expert" class="${mode === 'expert' ? 'on' : ''}">开发者</button>
    </div>`;

  let body = '';

  if (mode === 'relay') {
    body = `
      <div class="field"><label>给这个方案起个名字</label><input id="p-name" type="text" value="${esc(p.name)}" placeholder="例如：某中转站 / 主力模型"></div>
      <div class="field"><label>接口地址（Base URL）</label><input id="p-url" type="text" inputmode="url" value="${esc(p.baseUrl)}" placeholder="https://api.example.com/v1" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="field"><label>API Key</label><input id="p-key" type="password" value="${esc(p.apiKey)}" placeholder="sk-…" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="field">
        <label>模型</label>
        <div class="row">
          <input class="grow" id="p-model" type="text" value="${esc(p.model)}" placeholder="填模型名，或点右侧读取" autocapitalize="off" spellcheck="false">
          <button class="btn" id="p-fetch">读取列表</button>
        </div>
        <div class="chips" id="p-models" style="margin-top:8px"></div>
      </div>
      <div class="field">
        <label>思考强度</label>
        <div class="chips" id="p-effort">
          ${[['none', '默认'], ['low', '低'], ['medium', '中'], ['high', '高']].map(([v, l]) => `<button class="chip ${(p.reasoning || 'none') === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>温度 ${'' }<span id="p-temp-val">${p.temperature ?? 0.7}</span></label>
        <input id="p-temp" type="range" min="0" max="2" step="0.1" value="${p.temperature ?? 0.7}" style="width:100%">
      </div>`;
  } else if (mode === 'official') {
    const presetKey = Object.keys(PRESETS).find((k) => p.baseUrl && PRESETS[k].baseUrl === p.baseUrl) || 'deepseek';
    const preset = PRESETS[presetKey];
    if (!p.baseUrl) { p.baseUrl = preset.baseUrl; p.name = p.name || preset.label; }
    body = `
      <div class="field"><label>来自哪个官方平台</label>
        <div class="chips" id="p-preset">
          ${Object.entries(PRESETS).map(([k, v]) => `<button class="chip ${k === presetKey ? 'on' : ''}" data-k="${k}">${v.label}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>API Key</label><input id="p-key" type="password" value="${esc(p.apiKey)}" placeholder="粘贴官方 API Key" autocapitalize="off" autocorrect="off" spellcheck="false"></div>
      <div class="field"><label>模型</label>
        <div class="row">
          <input class="grow" id="p-model" type="text" value="${esc(p.model)}" placeholder="${esc(preset.models[0])}" autocapitalize="off" spellcheck="false">
          <button class="btn" id="p-fetch">读取</button>
        </div>
        <div class="chips" id="p-models" style="margin-top:8px">
          ${preset.models.map((m) => `<button class="chip ${p.model === m ? 'on' : ''}" data-m="${esc(m)}">${esc(m)}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>思考强度</label>
        <div class="chips" id="p-effort">
          ${[['none', '默认'], ['low', '低'], ['medium', '中'], ['high', '高']].map(([v, l]) => `<button class="chip ${(p.reasoning || 'none') === v ? 'on' : ''}" data-v="${v}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="field"><label>接口地址（一般不用改）</label><input id="p-url" type="text" value="${esc(p.baseUrl)}" autocapitalize="off" spellcheck="false"></div>
      <div class="mini-note">${esc(preset.hint)} · 只支持官方直连地址</div>`;
  } else {
    body = `
      <div class="field"><label>方案名称</label><input id="p-name" type="text" value="${esc(p.name)}"></div>
      <div class="field"><label>Base URL</label><input id="p-url" type="text" value="${esc(p.baseUrl)}" placeholder="https://host/v1" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label>API Key</label><input id="p-key" type="password" value="${esc(p.apiKey)}" autocapitalize="off" spellcheck="false"></div>
      <div class="field"><label>模型 ID</label>
        <div class="row">
          <input class="grow" id="p-model" type="text" value="${esc(p.model)}" autocapitalize="off" spellcheck="false">
          <button class="btn" id="p-fetch">读取</button>
        </div>
        <div class="chips" id="p-models" style="margin-top:8px"></div>
      </div>
      <div class="field"><label>自定义路径（可选，覆盖 /chat/completions）</label>
        <input id="p-path" type="text" value="${esc(p.exactPath || '')}" placeholder="/v1/chat/completions" autocapitalize="off" spellcheck="false"></div>
      <div class="row">
        <div class="field grow"><label>temperature</label><input id="p-temp" type="number" step="0.1" min="0" max="2" value="${p.temperature ?? ''}"></div>
        <div class="field grow"><label>top_p</label><input id="p-topp" type="number" step="0.05" min="0" max="1" value="${p.topP ?? ''}"></div>
        <div class="field grow"><label>max_tokens</label><input id="p-maxtok" type="number" step="1" min="1" value="${p.maxTokens ?? ''}"></div>
      </div>
      <div class="row">
        <div class="field grow"><label>reasoning_effort</label>
          <select id="p-effort-sel">
            <option value="">不发送</option>
            ${['low', 'medium', 'high'].map((v) => `<option value="${v}" ${p.reasoning === v ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>
        <div class="field grow"><label>超时（秒）</label><input id="p-timeout" type="number" min="0" step="5" value="${p.timeoutSecs ?? ''}"></div>
      </div>
      <div class="field"><label>额外请求头（JSON，可选）</label><textarea id="p-headers" placeholder='{"X-Custom":"1"}'>${p.extraHeaders ? esc(JSON.stringify(p.extraHeaders, null, 2)) : ''}</textarea></div>
      <div class="field"><label>额外请求体（JSON，可选）</label><textarea id="p-body" placeholder='{"top_k":40}'>${p.extraBody ? esc(JSON.stringify(p.extraBody, null, 2)) : ''}</textarea></div>
      <div class="field"><label>thinking 参数（JSON，可选）</label><textarea id="p-thinking" placeholder='{"type":"enabled","budget_tokens":2048}'>${p.thinking ? esc(JSON.stringify(p.thinking, null, 2)) : ''}</textarea></div>`;
  }

  openSheet(isNew ? '添加模型方案' : '编辑模型方案', `
    ${head}
    ${body}
    <div class="sheet-actions">
      ${isNew ? '' : '<button class="btn danger" id="p-del">删除</button>'}
      <button class="btn" id="p-test">测试</button>
      <button class="btn primary" id="p-save">保存</button>
    </div>`);

  $('#p-mode').querySelectorAll('[data-mode]').forEach((el) => {
    el.onclick = () => {
      collectProvider();
      sheetMode = el.dataset.mode;
      draftProvider.mode = sheetMode;
      paintProviderSheet(isNew);
    };
  });

  const presetWrap = $('#p-preset');
  if (presetWrap) {
    presetWrap.querySelectorAll('[data-k]').forEach((el) => {
      el.onclick = () => {
        const k = el.dataset.k;
        draftProvider.baseUrl = PRESETS[k].baseUrl;
        draftProvider.name = draftProvider.name || PRESETS[k].label;
        draftProvider.model = '';
        presetWrap.querySelectorAll('[data-k]').forEach((b) => b.classList.toggle('on', b === el));
        paintProviderSheet(isNew);
      };
    });
  }

  const modelWrap = $('#p-models');
  if (modelWrap) {
    modelWrap.querySelectorAll('[data-m]').forEach((el) => {
      el.onclick = () => {
        $('#p-model').value = el.dataset.m;
        modelWrap.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b === el));
      };
    });
  }

  const effortWrap = $('#p-effort');
  if (effortWrap) {
    effortWrap.querySelectorAll('[data-v]').forEach((el) => {
      el.onclick = () => {
        draftProvider.reasoning = el.dataset.v;
        effortWrap.querySelectorAll('[data-v]').forEach((b) => b.classList.toggle('on', b === el));
      };
    });
  }

  const tempRange = $('#p-temp');
  if (tempRange && tempRange.type === 'range') {
    tempRange.oninput = () => { $('#p-temp-val').textContent = tempRange.value; };
  }

  $('#p-fetch').onclick = async () => {
    collectProvider();
    const btn = $('#p-fetch');
    btn.disabled = true;
    btn.textContent = '读取中';
    try {
      const list = await invoke('list_models', {
        baseUrl: draftProvider.baseUrl,
        apiKey: draftProvider.apiKey,
        exactPath: draftProvider.exactPath || null,
        extraHeaders: draftProvider.extraHeaders || null
      });
      if (!list.length) { toast('没有读到模型'); return; }
      draftProvider.models = list;
      const wrap = $('#p-models');
      wrap.innerHTML = list.map((m) => `<button class="chip ${draftProvider.model === m ? 'on' : ''}" data-m="${esc(m)}">${esc(m)}</button>`).join('');
      wrap.querySelectorAll('[data-m]').forEach((el) => {
        el.onclick = () => {
          $('#p-model').value = el.dataset.m;
          wrap.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b === el));
        };
      });
      if (!draftProvider.model && list.length === 1) $('#p-model').value = list[0];
      toast(`读到 ${list.length} 个模型`);
    } catch (e) {
      toast(String(e).slice(0, 90));
    } finally {
      btn.disabled = false;
      btn.textContent = '读取';
    }
  };

  $('#p-test').onclick = async () => {
    collectProvider();
    if (!draftProvider.baseUrl || !draftProvider.apiKey || !draftProvider.model) {
      toast('先填地址、Key 和模型');
      return;
    }
    const btn = $('#p-test');
    btn.disabled = true;
    btn.textContent = '测试中';
    try {
      const id = 'test-' + uid();
      let first = '';
      let error = '';
      const un = await listen('breeze://chat', (ev) => {
        const p = ev.payload || {};
        if (p.id !== id) return;
        if (p.event.type === 'delta') first += p.event.text;
        if (p.event.type === 'error') error = p.event.message;
      });
      await invoke('chat_start', {
        req: {
          id,
          baseUrl: draftProvider.baseUrl,
          apiKey: draftProvider.apiKey,
          model: draftProvider.model,
          messages: [{ role: 'user', content: '说“好”，一个字。' }],
          stream: true,
          temperature: null,
          topP: null,
          maxTokens: 32,
          reasoningEffort: draftProvider.reasoning && draftProvider.reasoning !== 'none' ? draftProvider.reasoning : null,
          thinking: draftProvider.thinking || null,
          extraHeaders: draftProvider.extraHeaders || null,
          extraBody: draftProvider.extraBody || null,
          exactPath: draftProvider.exactPath || null,
          timeoutSecs: 40
        }
      });
      await new Promise((r) => setTimeout(r, 6000));
      un();
      if (error) toast('失败：' + String(error).slice(0, 80));
      else if (first.trim()) toast('连接正常：' + first.trim().slice(0, 24));
      else toast('没收到内容，检查模型名');
    } catch (e) {
      toast('失败：' + String(e).slice(0, 80));
    } finally {
      btn.disabled = false;
      btn.textContent = '测试';
    }
  };

  $('#p-save').onclick = () => {
    collectProvider();
    const d = draftProvider;
    if (!d.baseUrl.trim() || !d.apiKey.trim() || !d.model.trim()) {
      toast('地址、Key、模型都要填');
      return;
    }
    d.mode = sheetMode;
    d.name = d.name.trim() || d.model;
    const i = cfg.providers.findIndex((x) => x.id === d.id);
    if (i >= 0) cfg.providers[i] = d; else cfg.providers.push(d);
    cfg.activeId = d.id;
    saveConfig(); closeSheet(); render();
    toast('已保存，可以开始聊了');
  };

  if (!isNew) {
    $('#p-del').onclick = () => {
      cfg.providers = cfg.providers.filter((x) => x.id !== p.id);
      if (cfg.activeId === p.id) cfg.activeId = (cfg.providers[0] || {}).id || null;
      saveConfig(); closeSheet(); render();
    };
  }
}

function collectProvider() {
  const d = draftProvider;
  const val = (id) => { const el = $(id); return el ? el.value : undefined; };
  if (val('#p-name') !== undefined) d.name = val('#p-name');
  if (val('#p-url') !== undefined) d.baseUrl = val('#p-url');
  if (val('#p-key') !== undefined) d.apiKey = val('#p-key');
  if (val('#p-model') !== undefined) d.model = val('#p-model').trim();
  if (val('#p-path') !== undefined) d.exactPath = val('#p-path').trim();
  if (val('#p-temp') !== undefined) {
    const v = parseFloat(val('#p-temp'));
    d.temperature = Number.isFinite(v) ? v : null;
  }
  if (val('#p-topp') !== undefined) {
    const v = parseFloat(val('#p-topp'));
    d.topP = Number.isFinite(v) ? v : null;
  }
  if (val('#p-maxtok') !== undefined) {
    const v = parseInt(val('#p-maxtok'), 10);
    d.maxTokens = Number.isFinite(v) && v > 0 ? v : null;
  }
  if (val('#p-timeout') !== undefined) {
    const v = parseInt(val('#p-timeout'), 10);
    d.timeoutSecs = Number.isFinite(v) && v > 0 ? v : null;
  }
  const effSel = $('#p-effort-sel');
  if (effSel) d.reasoning = effSel.value || 'none';
  for (const [id, key] of [['#p-headers', 'extraHeaders'], ['#p-body', 'extraBody'], ['#p-thinking', 'thinking']]) {
    const el = $(id);
    if (!el) continue;
    const raw = el.value.trim();
    if (!raw) { d[key] = null; continue; }
    try { d[key] = JSON.parse(raw); } catch (_) { toast(`${key} 不是合法 JSON`); }
  }
}

/* ---------------- 导出 / 导入 ---------------- */

function fullBackup() {
  return JSON.stringify({ app: 'breeze', version: 1, exportedAt: new Date().toISOString(), config: cfg, roles: roleStore, chats: chatStore }, null, 2);
}

function exportSheet() {
  const text = fullBackup();
  openSheet('导出全部数据', `
    <div class="field">
      <label>复制这段 JSON，或保存成文件</label>
      <textarea id="ex-json" style="min-height:190px" readonly></textarea>
    </div>
    <div class="sheet-actions">
      <button class="btn" id="ex-file">保存文件</button>
      <button class="btn primary" id="ex-copy">复制</button>
    </div>`);
  $('#ex-json').value = text;
  $('#ex-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制，去新设备粘贴导入');
    } catch (_) {
      $('#ex-json').select();
      toast('请长按全选复制');
    }
  };
  $('#ex-file').onclick = async () => {
    try {
      const path = await invoke('plugin:dialog|save', {
        options: { defaultPath: `breeze-backup-${new Date().toISOString().slice(0, 10)}.json` }
      });
      if (!path) return;
      await invoke('write_file_text', { path, text });
      toast('已保存：' + path.split(/[\\/]/).pop());
    } catch (e) {
      toast('保存失败，请改用复制');
    }
  };
}

async function getFileText() {
  try {
    const path = await invoke('plugin:dialog|open', {
      options: { multiple: false, filters: [{ name: 'JSON', extensions: ['json'] }] }
    });
    if (!path) return null;
    const p = typeof path === 'string' ? path : path.path || (Array.isArray(path) ? path[0] : '');
    if (!p) return null;
    return await invoke('read_file_text', { path: p });
  } catch (e) {
    toast('读取失败，请粘贴文本');
    return null;
  }
}

async function backupImport() {
  openSheet('导入备份', `
    <div class="field"><label>粘贴之前导出的 JSON</label>
      <textarea id="bi-json" style="min-height:170px" placeholder='{"app":"breeze",…}'></textarea>
    </div>
    <div class="sheet-actions">
      <button class="btn" id="bi-file">选择文件</button>
      <button class="btn primary" id="bi-do">导入</button>
    </div>`);
  $('#bi-file').onclick = async () => {
    const text = await getFileText();
    if (text) $('#bi-json').value = text;
  };
  $('#bi-do').onclick = () => {
    const raw = $('#bi-json').value.trim();
    if (!raw) return;
    let data;
    try { data = JSON.parse(raw); } catch (e) { toast('JSON 格式有误'); return; }
    if (!data || data.app !== 'breeze') { toast('这不是 Breeze 的备份'); return; }
    if (data.config && Array.isArray(data.config.providers)) {
      cfg = { providers: data.config.providers, activeId: data.config.activeId || data.config.providers[0]?.id || null };
    }
    if (data.roles) {
      roleStore = {
        roles: Array.isArray(data.roles.roles) ? data.roles.roles : [],
        groups: Array.isArray(data.roles.groups) ? data.roles.groups : []
      };
    }
    if (data.chats && Array.isArray(data.chats.chats)) chatStore = { chats: data.chats.chats };
    Promise.all([saveConfig(), saveRoles(), saveChats()]).then(() => {
      closeSheet();
      view = 'chats'; currentChatId = null;
      render();
      toast('导入完成');
    });
  };
}

/* ---------------- 弹层 ---------------- */

function openSheet(title, html) {
  sheetCard.innerHTML = `<h2>${esc(title)}</h2>${html}`;
  sheetEl.hidden = false;
  sheetEl.onclick = (e) => { if (e.target === sheetEl) closeSheet(); };
}

function closeSheet() {
  sheetEl.hidden = true;
  sheetCard.innerHTML = '';
  stage.classList.toggle('chat-mode', view === 'chat');
}

/* ---------------- 启动 ---------------- */

tabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-view]');
  if (!btn) return;
  if (live) stopStream();
  view = btn.dataset.view;
  currentChatId = null;
  stage.classList.remove('chat-mode');
  render();
});

window.addEventListener('beforeunload', () => { saveChats(); });

boot().catch((e) => {
  stage.innerHTML = `<div class="empty"><b>启动异常</b>${esc(String(e))}</div>`;
});
