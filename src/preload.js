'use strict';

const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  if (window.self !== window.top) return;

  const hostEl = document.createElement('div');
  hostEl.id = 'dsh-sidebar-host';
  document.body.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* 右侧边栏切换按钮（清爽简约的图标按钮，像浏览器侧边栏一样） */
    .sidebar-toggle-btn {
      position: fixed;
      top: 12px;
      right: 14px;
      z-index: 999998;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 5px 10px;
      background: rgba(24, 24, 32, 0.88);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      color: #cfd3dc;
      font-size: 12px;
      font-weight: 500;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      cursor: pointer;
      backdrop-filter: blur(8px);
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
      transition: all 0.18s ease;
      user-select: none;
    }
    .sidebar-toggle-btn:hover {
      background: rgba(38, 38, 50, 0.96);
      color: #ffffff;
      border-color: rgba(255, 255, 255, 0.28);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 16px;
      height: 16px;
      padding: 0 4px;
      border-radius: 8px;
      font-size: 10px;
      font-weight: 700;
      background: #3b82f6;
      color: #fff;
    }
    .badge.empty {
      display: none;
    }

    /* 右侧侧边栏面板 */
    .sidebar {
      position: fixed;
      top: 0;
      right: -440px;
      width: 440px;
      height: 100vh;
      max-width: 90vw;
      background: #14141b;
      border-left: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: -6px 0 24px rgba(0, 0, 0, 0.6);
      z-index: 999999;
      display: flex;
      flex-direction: column;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Microsoft YaHei", sans-serif;
      color: #d1d5db;
      transition: right 0.22s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .sidebar.open {
      right: 0;
    }

    /* 侧边栏顶部工具条 */
    .sidebar-header {
      padding: 10px 14px;
      background: #191923;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    .header-title {
      font-size: 13px;
      font-weight: 600;
      color: #f3f4f6;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .btn-icon {
      width: 26px;
      height: 26px;
      border-radius: 4px;
      background: transparent;
      border: 1px solid transparent;
      color: #9ca3af;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: all 0.15s ease;
    }
    .btn-icon:hover {
      background: rgba(255, 255, 255, 0.08);
      color: #fff;
    }

    /* 上半部分：变更文件列表 */
    .files-pane {
      max-height: 42%;
      min-height: 120px;
      overflow-y: auto;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      padding: 6px;
      display: flex;
      flex-direction: column;
      gap: 2px;
      background: #111117;
    }
    .file-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 12px;
      transition: all 0.12s ease;
      user-select: none;
    }
    .file-row:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    .file-row.active {
      background: rgba(59, 130, 246, 0.2);
      border-left: 2px solid #3b82f6;
    }
    .file-info {
      display: flex;
      align-items: center;
      gap: 6px;
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
      flex: 1;
    }
    .file-path {
      color: #e5e7eb;
      overflow: hidden;
      text-overflow: ellipsis;
      direction: rtl;
      text-align: left;
    }
    .file-tag {
      font-size: 10px;
      font-weight: 700;
      padding: 1px 5px;
      border-radius: 3px;
      margin-left: 6px;
      flex-shrink: 0;
    }
    .file-tag.added { background: #064e3b; color: #34d399; }
    .file-tag.modified { background: #78350f; color: #fbbf24; }
    .file-tag.deleted { background: #7f1d1d; color: #f87171; }

    /* 下半部分：文件内容预览 */
    .preview-pane {
      flex: 1;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      background: #0d0d12;
    }
    .preview-header {
      padding: 6px 12px;
      background: #15151e;
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 12px;
      color: #9ca3af;
      font-family: monospace;
    }
    .preview-body {
      flex: 1;
      overflow: auto;
      padding: 10px;
      font-family: "Cascadia Code", Consolas, "Courier New", monospace;
      font-size: 12px;
      line-height: 1.5;
      color: #e5e7eb;
      white-space: pre;
    }
    .code-table {
      border-collapse: collapse;
      width: 100%;
    }
    .code-table td {
      padding: 0;
      vertical-align: top;
    }
    .line-num {
      color: #4b5563;
      user-select: none;
      padding-right: 12px;
      text-align: right;
      min-width: 32px;
    }
    .empty-msg {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #6b7280;
      font-size: 12px;
      text-align: center;
      padding: 20px;
    }
  `;
  shadow.appendChild(style);

  // 1. 顶部切换按钮
  const toggleBtn = document.createElement('div');
  toggleBtn.className = 'sidebar-toggle-btn';
  toggleBtn.title = '项目文件变更侧边栏';
  toggleBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
      <line x1="15" y1="3" x2="15" y2="21"></line>
    </svg>
    <span>变更</span>
    <span class="badge empty" id="badge">0</span>
  `;
  shadow.appendChild(toggleBtn);

  // 2. 侧边栏
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="header-title">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
          <line x1="15" y1="3" x2="15" y2="21"></line>
        </svg>
        <span id="title-text">项目文件变更</span>
      </div>
      <div class="header-actions">
        <button class="btn-icon" id="btn-refresh" title="刷新变更">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"></path>
          </svg>
        </button>
        <button class="btn-icon" id="btn-close" title="收起侧边栏">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    </div>
    <div class="files-pane" id="files-pane">
      <div class="empty-msg">正在检查变更…</div>
    </div>
    <div class="preview-pane">
      <div class="preview-header">
        <span id="preview-filename">点击上方文件查看内容</span>
        <button class="btn-icon" id="btn-copy" title="复制内容" style="display:none;">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
          </svg>
        </button>
      </div>
      <div class="preview-body" id="preview-body">
        <div class="empty-msg">点击上方任意文件即可预览内容</div>
      </div>
    </div>
  `;
  shadow.appendChild(sidebar);

  const state = {
    open: false,
    projectDir: '',
    files: [],
    selectedPath: '',
    currentText: '',
  };

  const elBadge = shadow.getElementById('badge');
  const elFilesPane = shadow.getElementById('files-pane');
  const elTitleText = shadow.getElementById('title-text');
  const elPreviewFilename = shadow.getElementById('preview-filename');
  const elPreviewBody = shadow.getElementById('preview-body');
  const elBtnCopy = shadow.getElementById('btn-copy');

  function setOpen(open) {
    state.open = open;
    if (state.open) {
      sidebar.classList.add('open');
      toggleBtn.style.opacity = '0';
      loadChanges();
    } else {
      sidebar.classList.remove('open');
      toggleBtn.style.opacity = '1';
    }
  }

  toggleBtn.addEventListener('click', () => setOpen(true));
  shadow.getElementById('btn-close').addEventListener('click', () => setOpen(false));
  shadow.getElementById('btn-refresh').addEventListener('click', loadChanges);

  elBtnCopy.addEventListener('click', () => {
    if (state.currentText) {
      navigator.clipboard.writeText(state.currentText).then(() => {
        const old = elPreviewFilename.textContent;
        elPreviewFilename.textContent = '✓ 已复制！';
        setTimeout(() => { elPreviewFilename.textContent = old; }, 1200);
      });
    }
  });

  async function loadChanges() {
    elFilesPane.innerHTML = '<div class="empty-msg">正在扫描项目变更…</div>';
    try {
      if (!state.projectDir) {
        state.projectDir = await ipcRenderer.invoke('dsh:get-default-path');
      }
      const res = await ipcRenderer.invoke('dsh:get-changes', state.projectDir);
      state.files = res.changes || [];
      const count = state.files.length;
      elTitleText.textContent = `项目变更 (${count})`;

      if (count > 0) {
        elBadge.textContent = count;
        elBadge.classList.remove('empty');
      } else {
        elBadge.classList.add('empty');
      }

      if (count === 0) {
        elFilesPane.innerHTML = '<div class="empty-msg">当前项目没有文件变更</div>';
        elPreviewBody.innerHTML = '<div class="empty-msg">没有待查看的变更文件</div>';
        elPreviewFilename.textContent = '暂无变更';
        elBtnCopy.style.display = 'none';
        return;
      }

      elFilesPane.innerHTML = '';
      state.files.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'file-row';
        if (f.path === state.selectedPath) row.classList.add('active');

        const tagClass = f.status === 'deleted' ? 'deleted' : (f.status === 'added' ? 'added' : 'modified');
        const tagText = f.status === 'deleted' ? '删' : (f.status === 'added' ? '增' : '改');

        row.innerHTML = `
          <div class="file-info">
            <span class="file-path" title="${f.path}">${escapeHtml(f.path)}</span>
          </div>
          <span class="file-tag ${tagClass}">${tagText}</span>
        `;

        row.addEventListener('click', () => {
          shadow.querySelectorAll('.file-row').forEach((r) => r.classList.remove('active'));
          row.classList.add('active');
          state.selectedPath = f.path;
          loadFileContent(f);
        });

        elFilesPane.appendChild(row);
      });

      // 默认加载第一个变更文件
      if (!state.selectedPath && state.files.length > 0) {
        state.selectedPath = state.files[0].path;
        const firstRow = elFilesPane.querySelector('.file-row');
        if (firstRow) firstRow.classList.add('active');
        loadFileContent(state.files[0]);
      }
    } catch (e) {
      elFilesPane.innerHTML = `<div class="empty-msg">扫描失败: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  async function loadFileContent(file) {
    elPreviewFilename.textContent = file.path;
    elBtnCopy.style.display = 'none';
    state.currentText = '';

    if (file.status === 'deleted') {
      elPreviewBody.innerHTML = '<div class="empty-msg" style="color:#f87171;">该文件已被删除</div>';
      return;
    }

    elPreviewBody.innerHTML = '<div class="empty-msg">正在加载文件内容…</div>';
    try {
      const res = await ipcRenderer.invoke('dsh:get-file-content', file.fullPath);
      if (res.type === 'text') {
        state.currentText = res.content;
        elBtnCopy.style.display = 'inline-flex';
        renderCode(res.content);
      } else if (res.type === 'image') {
        elPreviewBody.innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;"><img src="${res.dataUrl}" style="max-width:100%;max-height:100%;border-radius:4px;" /></div>`;
      } else {
        elPreviewBody.innerHTML = `<div class="empty-msg">${escapeHtml(res.message || '二进制文件，无法预览')}</div>`;
      }
    } catch (err) {
      elPreviewBody.innerHTML = `<div class="empty-msg" style="color:#f87171;">加载失败: ${escapeHtml(err.message || String(err))}</div>`;
    }
  }

  function renderCode(text) {
    const lines = String(text).split('\n');
    let html = '<table class="code-table"><tbody>';
    for (let i = 0; i < lines.length; i++) {
      const num = i + 1;
      const code = lines[i] === '' ? ' ' : escapeHtml(lines[i]);
      html += `<tr><td class="line-num">${num}</td><td>${code}</td></tr>`;
    }
    html += '</tbody></table>';
    elPreviewBody.innerHTML = html;
  }

  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // 接收主进程菜单栏或其他通知直接开关侧边栏
  ipcRenderer.on('dsh:toggle-sidebar', () => {
    setOpen(!state.open);
  });

  // 初始静默拉取一次角标数字
  ipcRenderer.invoke('dsh:get-default-path').then((dir) => {
    state.projectDir = dir;
    ipcRenderer.invoke('dsh:get-changes', dir).then((res) => {
      const count = (res.changes || []).length;
      if (count > 0) {
        elBadge.textContent = count;
        elBadge.classList.remove('empty');
      }
    }).catch(() => {});
  }).catch(() => {});
});
