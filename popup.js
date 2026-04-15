// popup.js — 外链助手 v2.0

const $ = id => document.getElementById(id);

// ── 标签页切换 ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ── 日志 ──────────────────────────────────────────────────────────────────────
const LOG_MAX = 80;
const LOG_STORE = { 'log-discover': 'logDiscover' };

function log(boxId, msg, type = '') {
  const box = $(boxId);
  const line = document.createElement('div');
  line.className = type;
  const text = `[${new Date().toLocaleTimeString()}] ${msg}`;
  line.textContent = text;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
  const key = LOG_STORE[boxId];
  if (key) {
    chrome.storage.local.get(key, d => {
      const arr = d[key] || [];
      arr.push({ text, type });
      if (arr.length > LOG_MAX) arr.splice(0, arr.length - LOG_MAX);
      chrome.storage.local.set({ [key]: arr });
    });
  }
}

function restoreLog(boxId, entries) {
  const box = $(boxId);
  box.innerHTML = '';
  for (const e of entries) {
    const line = document.createElement('div');
    line.className = e.type || '';
    line.textContent = e.text;
    box.appendChild(line);
  }
  box.scrollTop = box.scrollHeight;
}

const logD = (m, t) => log('log-discover', m, t);

function setStatus(msg) {
  $('status-bar').textContent = msg;
  chrome.storage.local.set({ statusBar: msg });
}

// ── 存储操作 ──────────────────────────────────────────────────────────────────
async function getConfig() {
  return new Promise(r => chrome.storage.local.get('config', d => r(d.config || {})));
}
async function saveConfig(cfg) {
  return new Promise(r => chrome.storage.local.set({ config: cfg }, r));
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitForTabLoad(tabId, timeout = 15000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── 配置面板 ──────────────────────────────────────────────────────────────────
$('btn-save-config').addEventListener('click', async () => {
  const cfg = {
    mirror: $('cfg-mirror').value.trim() || 'sem.3ue.co',
    author: $('cfg-author').value.trim(),
    email:  $('cfg-email').value.trim(),
    site:   $('cfg-site').value.trim(),
  };
  await saveConfig(cfg);
  setStatus('✓ 配置已保存');
});

async function loadConfigToForm() {
  const cfg = await getConfig();
  if (cfg.mirror) $('cfg-mirror').value = cfg.mirror;
  if (cfg.author) $('cfg-author').value = cfg.author;
  if (cfg.email)  $('cfg-email').value  = cfg.email;
  if (cfg.site)   $('cfg-site').value   = cfg.site;
}

// ══════════════════════════════════════════════════════════════════════════════
// 竞品发现面板
// ══════════════════════════════════════════════════════════════════════════════

function getDiscoverDomains() {
  return $('discover-domains').value
    .split('\n').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'));
}

function updateDomainCount() {
  const n = getDiscoverDomains().length;
  $('discover-domain-count').textContent = `${n} 个域名`;
  $('btn-batch-extract').disabled = n === 0;
}

$('discover-domains').addEventListener('input', () => {
  updateDomainCount();
  chrome.storage.local.set({ discoverDomains: $('discover-domains').value });
});

$('discover-keyword').addEventListener('input', () => {
  chrome.storage.local.set({ discoverKeyword: $('discover-keyword').value });
});

// 注入到 Google 页面：提取前10有机结果域名
function extractGoogleDomains() {
  const EXCLUDE = ['google.', 'youtube.com', 'facebook.com', 'twitter.com',
                   'instagram.com', 'linkedin.com', 'wikipedia.org', 'amazon.com',
                   'x.com', 'tiktok.com', 'pinterest.com'];
  const domains = [];
  const seen = new Set();
  const anchors = document.querySelectorAll(
    '#search .g a[href^="http"], #rso a[href^="http"], .yuRUbf a[href^="http"]'
  );
  for (const a of anchors) {
    try {
      const domain = new URL(a.href).hostname.replace(/^www\./, '');
      if (!EXCLUDE.some(e => domain.includes(e)) && !seen.has(domain)) {
        seen.add(domain);
        domains.push(domain);
      }
    } catch {}
    if (domains.length >= 10) break;
  }
  return domains;
}

// Google 搜索 → 提取前10域名
$('btn-google-search').addEventListener('click', async () => {
  const keyword = $('discover-keyword').value.trim();
  if (!keyword) { logD('请输入关键词', 'err'); return; }

  $('btn-google-search').disabled = true;
  $('btn-google-search').textContent = '搜索中...';
  logD(`正在搜索: ${keyword}`, 'info');

  try {
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(keyword)}&num=20`;
    const newTab = await chrome.tabs.create({ url: searchUrl, active: false });
    await waitForTabLoad(newTab.id);
    await sleep(2500);

    const res = await chrome.scripting.executeScript({
      target: { tabId: newTab.id },
      func: extractGoogleDomains,
    });
    chrome.tabs.remove(newTab.id);

    const domains = res[0]?.result || [];
    if (domains.length === 0) {
      logD('未提取到域名，Google 可能需要验证码，请手动填写', 'err');
    } else {
      $('discover-domains').value = domains.join('\n');
      chrome.storage.local.set({ discoverDomains: domains.join('\n') });
      updateDomainCount();
      logD(`已提取 ${domains.length} 个竞品域名`, 'ok');
    }
  } catch (e) {
    logD(`搜索失败: ${e.message}`, 'err');
  }

  $('btn-google-search').disabled = false;
  $('btn-google-search').textContent = 'Google 搜索';
});

// 批量导出 — 委托给 background.js 执行，popup 关闭不中断
$('btn-batch-extract').addEventListener('click', async () => {
  const domains = getDiscoverDomains();
  if (domains.length === 0) { logD('请先添加竞品域名', 'err'); return; }

  const cfg = await getConfig();
  const mirror = cfg.mirror || 'sem.3ue.co';
  const followOnly = $('opt-follow-only').checked;

  const allTabs = await chrome.tabs.query({});
  const semTab = allTabs.find(t => t.url && (
    t.url.includes('semrush.com') || t.url.includes(mirror)
  ));
  if (!semTab) {
    logD(`请先手动打开 ${mirror} 并登录，然后再点击此按钮`, 'err');
    return;
  }

  const res = await chrome.runtime.sendMessage({
    action: 'startBatchExport', domains, semTabId: semTab.id, followOnly, mirror,
  });
  if (res.ok) {
    $('btn-batch-extract').disabled = true;
    $('btn-batch-stop').disabled = false;
    logD(`已启动批量导出（${domains.length} 个域名，${followOnly ? '仅 Follow' : '全部'}）— 关闭此窗口不会中断`, 'info');
  } else {
    logD(`启动失败: ${res.error}`, 'err');
  }
});

$('btn-batch-stop').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ action: 'stopBatchExport' });
  logD('正在停止，等待当前域名完成...', 'info');
});

// 接收 background.js 推送的进度
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'batchProgress') return;
  if (msg.type === 'log') {
    logD(msg.msg, msg.logType);
  } else if (msg.type === 'progress') {
    $('progress-discover').style.width = msg.pct + '%';
    $('discover-current').textContent = msg.current;
  } else if (msg.type === 'done') {
    $('progress-discover').style.width = '100%';
    $('discover-current').textContent = `完成！已触发 ${msg.doneCount}/${msg.total} 个域名导出`;
    $('btn-batch-extract').disabled = false;
    $('btn-batch-stop').disabled = true;
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 交叉分析面板
// ══════════════════════════════════════════════════════════════════════════════

let loadedFiles = []; // [{name, rows}]
let analyzeResults = [];

// 拖拽区域
const dropZone = $('drop-zone');
const fileInput = $('file-input');

dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  handleFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => {
  handleFiles([...fileInput.files]);
  fileInput.value = '';
});

function handleFiles(files) {
  for (const file of files) {
    if (loadedFiles.find(f => f.name === file.name)) continue;
    const reader = new FileReader();
    reader.onload = e => {
      const rows = parseCSVText(e.target.result);
      loadedFiles.push({ name: file.name, rows });
      renderFileChips();
      updateAnalyzeHint();
    };
    reader.readAsText(file, 'utf-8');
  }
}

function parseCSVText(text) {
  // 去 BOM
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return [];

  function splitLine(line) {
    const result = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { inQ = !inQ; }
      else if (c === ',' && !inQ) { result.push(cur.trim()); cur = ''; }
      else { cur += c; }
    }
    result.push(cur.trim());
    return result;
  }

  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] || ''; });
    rows.push(row);
  }
  return rows;
}

function renderFileChips() {
  const container = $('file-chips');
  container.innerHTML = '';
  for (const f of loadedFiles) {
    const chip = document.createElement('div');
    chip.className = 'file-chip';
    chip.innerHTML = `<span>${f.name}</span><span class="rm" data-name="${f.name}">×</span>`;
    container.appendChild(chip);
  }
  container.querySelectorAll('.rm').forEach(btn => {
    btn.addEventListener('click', () => {
      loadedFiles = loadedFiles.filter(f => f.name !== btn.dataset.name);
      renderFileChips();
      updateAnalyzeHint();
    });
  });
}

function updateAnalyzeHint() {
  const n = loadedFiles.length;
  $('analyze-hint').textContent = n < 2
    ? `已加载 ${n} 个文件，还需至少 ${2 - n} 个`
    : `已加载 ${n} 个文件，可以开始分析`;
  $('btn-run-analyze').disabled = n < 2;
}

function extractRootDomain(val) {
  if (!val) return null;
  try {
    const url = val.startsWith('http') ? val : 'https://' + val;
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch { return null; }
}

$('btn-run-analyze').addEventListener('click', () => {
  if (loadedFiles.length < 2) return;

  // 对每个文件，找出现最多的域名（竞品自身域名），排除它
  const domainFileSets = {}; // domain -> Set of file names

  for (const file of loadedFiles) {
    // 统计每个域名在本文件出现次数，找出最高频的（竞品域名）
    const domainCount = {};
    const allDomains = [];

    for (const row of file.rows) {
      for (const val of Object.values(row)) {
        if (val && val.startsWith('http')) {
          const d = extractRootDomain(val);
          if (d) {
            domainCount[d] = (domainCount[d] || 0) + 1;
            allDomains.push(d);
          }
        }
      }
    }

    // 找出现次数最多的域名（竞品自身），排除
    const maxCount = Math.max(...Object.values(domainCount));
    const excludeDomains = new Set(
      Object.entries(domainCount).filter(([, c]) => c >= maxCount * 0.5).map(([d]) => d)
    );

    // 统计来源域名（排除竞品自身）
    const seenInFile = new Set();
    for (const row of file.rows) {
      for (const val of Object.values(row)) {
        if (val && val.startsWith('http')) {
          const d = extractRootDomain(val);
          if (d && !excludeDomains.has(d) && !seenInFile.has(d)) {
            seenInFile.add(d);
            if (!domainFileSets[d]) domainFileSets[d] = new Set();
            domainFileSets[d].add(file.name);
          }
        }
      }
    }
  }

  // 排序：只显示出现在 2+ 文件的
  analyzeResults = Object.entries(domainFileSets)
    .map(([domain, fileSet]) => ({ domain, count: fileSet.size, files: [...fileSet] }))
    .filter(d => d.count >= 2)
    .sort((a, b) => b.count - a.count);

  renderAnalyzeResults();
  $('btn-export-analyze').disabled = analyzeResults.length === 0;
  $('analyze-hint').textContent = `分析完成：${analyzeResults.length} 个域名出现在 2+ 个文件中`;
});

function renderAnalyzeResults() {
  const container = $('result-scroll');
  if (analyzeResults.length === 0) {
    container.innerHTML = '<div class="empty">没有找到在多个文件中重复出现的域名<br>请确认文件包含外链来源 URL</div>';
    return;
  }

  const total = loadedFiles.length;
  let html = `<table class="result-table">
    <thead><tr>
      <th>#</th>
      <th>域名</th>
      <th>出现文件数</th>
    </tr></thead><tbody>`;

  analyzeResults.forEach((r, i) => {
    const badgeClass = r.count === total ? 'top' : r.count >= total * 0.6 ? 'hot' : '';
    html += `<tr>
      <td style="color:#94a3b8">${i + 1}</td>
      <td style="font-family:monospace">${r.domain}</td>
      <td><span class="cnt-badge ${badgeClass}">${r.count} / ${total}</span></td>
    </tr>`;
  });

  html += '</tbody></table>';
  container.innerHTML = html;
}

$('btn-export-analyze').addEventListener('click', () => {
  if (!analyzeResults.length) return;
  const total = loadedFiles.length;
  const csv = '\uFEFF' + ['域名,出现文件数,总文件数,文件列表',
    ...analyzeResults.map(r =>
      `"${r.domain}",${r.count},${total},"${r.files.join(' | ')}"`
    )
  ].join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `交叉分析_${new Date().toISOString().substring(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// ── 初始化 ────────────────────────────────────────────────────────────────────
(async () => {
  await loadConfigToForm();

  const stored = await new Promise(r => chrome.storage.local.get([
    'discoverDomains', 'discoverKeyword', 'logDiscover', 'statusBar', 'batchState',
  ], r));

  if (stored.statusBar) setStatus(stored.statusBar);
  else setStatus('就绪');

  if (stored.logDiscover?.length) restoreLog('log-discover', stored.logDiscover);
  if (stored.discoverKeyword) $('discover-keyword').value = stored.discoverKeyword;
  if (stored.discoverDomains) {
    $('discover-domains').value = stored.discoverDomains;
    updateDomainCount();
  }

  const bs = stored.batchState;
  if (bs?.running) {
    $('btn-batch-extract').disabled = true;
    $('btn-batch-stop').disabled = false;
    $('discover-current').textContent = `后台运行中... [${bs.current}/${bs.total}] 已完成 ${bs.done} 个`;
    $('progress-discover').style.width = Math.round((bs.current / bs.total) * 100) + '%';
  }
})();
