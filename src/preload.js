'use strict';

const { ipcRenderer } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
  if (window.self !== window.top) return;

  // 1. 在宿主网页的 head 中注入页面自适应收窄样式（使侧边栏打开时对话框平滑变窄，绝不遮挡视野）
  const hostStyle = document.createElement('style');
  hostStyle.id = 'dsh-page-layout-adapter';
  hostStyle.textContent = `
    html {
      transition: width 0.22s cubic-bezier(0.16, 1, 0.3, 1), margin-right 0.22s cubic-bezier(0.16, 1, 0.3, 1) !important;
    }
    html.dsh-sidebar-expanded {
      margin-right: 400px !important;
      width: calc(100vw - 400px) !important;
      max-width: calc(100vw - 400px) !important;
      overflow-x: hidden !important;
    }
  `;
  document.head.appendChild(hostStyle);

  // 2. 挂载侧边栏 Shadow DOM
  const hostEl = document.createElement('div');
  hostEl.id = 'dsh-sidebar-host';
  document.body.appendChild(hostEl);

  const shadow = hostEl.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    /* 右侧边栏面板（400px 宽度，与网页内容平铺并列，不覆盖对话框） */
    .sidebar {
      position: fixed;
      top: 0;
      right: -400px;
      width: 400px;
      height: 100vh;
      background: #14141b;
      border-left: 1px solid rgba(255, 255, 255, 0.1);
      box-shadow: -6px 0 24px rgba(0, 0, 0, 0.5);
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
      flex-direction: column;
      gap: 8px;
    }
    .header-row {
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
    .project-bar {
      display: flex;
      align-items: center;
      gap: 6px;
      background: #0e0e14;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      padding: 3px 8px;
    }
    .project-icon {
      color: #60a5fa;
      flex-shrink: 0;
    }
    .project-dropdown {
      flex: 1;
      background: transparent;
      border: none;
      color: #93c5fd;
      font-size: 11px;
      font-weight: 500;
      font-family: inherit;
      outline: none;
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .project-dropdown option {
      background: #191923;
      color: #e5e7eb;
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

  // 3. 侧边栏结构
  const sidebar = document.createElement('div');
  sidebar.className = 'sidebar';
  sidebar.innerHTML = `
    <div class="sidebar-header">
      <div class="header-row">
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
          <button class="btn-icon" id="btn-close" title="收起侧边栏 (Ctrl+B)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>
      <div class="project-bar">
        <svg class="project-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        <select id="project-dropdown" class="project-dropdown" title="当前查看的项目"></select>
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
    workspaces: [],
    files: [],
    selectedPath: '',
    currentText: '',
  };

  const elProjectDropdown = shadow.getElementById('project-dropdown');
  const elFilesPane = shadow.getElementById('files-pane');
  const elTitleText = shadow.getElementById('title-text');
  const elPreviewFilename = shadow.getElementById('preview-filename');
  const elPreviewBody = shadow.getElementById('preview-body');
  const elBtnCopy = shadow.getElementById('btn-copy');

  // 用户手动切换下拉框项目
  elProjectDropdown.addEventListener('change', (e) => {
    state.projectDir = e.target.value;
    state.selectedPath = '';
    loadChanges(false);
  });

  // 核心：侧边栏展开时让主网页平滑收缩 400px，收起时平滑复原，绝不遮挡对话框！
  function setOpen(open) {
    state.open = typeof open === 'boolean' ? open : !state.open;
    if (state.open) {
      sidebar.classList.add('open');
      document.documentElement.classList.add('dsh-sidebar-expanded');
      loadChanges(true);
    } else {
      sidebar.classList.remove('open');
      document.documentElement.classList.remove('dsh-sidebar-expanded');
    }
  }

  shadow.getElementById('btn-close').addEventListener('click', () => setOpen(false));
  shadow.getElementById('btn-refresh').addEventListener('click', () => loadChanges(true));

  elBtnCopy.addEventListener('click', () => {
    if (state.currentText) {
      navigator.clipboard.writeText(state.currentText).then(() => {
        const old = elPreviewFilename.textContent;
        elPreviewFilename.textContent = '✓ 已复制！';
        setTimeout(() => { elPreviewFilename.textContent = old; }, 1200);
      });
    }
  });

  async function loadChanges(refreshWorkspaces = true) {
    elFilesPane.innerHTML = '<div class="empty-msg">正在扫描项目变更…</div>';
    try {
      if (refreshWorkspaces || !state.projectDir) {
        const wsList = await ipcRenderer.invoke('dsh:get-workspaces');
        state.workspaces = Array.isArray(wsList) ? wsList : [];

        // 刷新下拉菜单
        elProjectDropdown.innerHTML = '';
        state.workspaces.forEach((ws) => {
          const opt = document.createElement('option');
          opt.value = ws.path;
          opt.textContent = `${ws.title || pathBasename(ws.path)} (${ws.path})`;
          elProjectDropdown.appendChild(opt);
        });

        // 默认自动锁定当前最新活跃的项目（排在第 1 位）
        if (!state.projectDir || refreshWorkspaces) {
          if (state.workspaces.length > 0) {
            state.projectDir = state.workspaces[0].path;
            elProjectDropdown.value = state.projectDir;
          }
        }
      }

      if (!state.projectDir) {
        state.projectDir = await ipcRenderer.invoke('dsh:get-default-path');
        elProjectDropdown.value = state.projectDir;
      }

      const res = await ipcRenderer.invoke('dsh:get-changes', state.projectDir);
      state.files = res.changes || [];
      const count = state.files.length;
      elTitleText.textContent = `项目变更 (${count})`;

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
      } else if (state.selectedPath) {
        const currentSelected = state.files.find((f) => f.path === state.selectedPath);
        if (currentSelected) {
          loadFileContent(currentSelected);
        } else if (state.files.length > 0) {
          state.selectedPath = state.files[0].path;
          loadFileContent(state.files[0]);
        }
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

  // 接收主进程菜单栏（或快捷键 Ctrl+B）直接开合侧边栏
  ipcRenderer.on('dsh:toggle-sidebar', () => {
    setOpen(!state.open);
  });

  // 网页内键盘监听：按 Ctrl+B 直接开合
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      setOpen(!state.open);
    }
  });
});
