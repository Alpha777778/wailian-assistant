// popup.js — 外链助手 v2.0

const $ = id => document.getElementById(id);

// ── 标签页切换 ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
    chrome.storage.local.set({ activeTab: tab.dataset.tab });
  });
});

// ── 日志 ──────────────────────────────────────────────────────────────────────
const LOG_MAX = 80;
const LOG_STORE = { 'log-discover': 'logDiscover', 'log-ai-submit': 'logAiSubmit' };

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
      resolve(true);
    }, timeout);
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── 全局停止 ──────────────────────────────────────────────────────────────────
function setGlobalStop(visible) {
  $('btn-global-stop').style.display = visible ? '' : 'none';
}

$('btn-global-stop').addEventListener('click', async () => {
  chrome.runtime.sendMessage({ action: 'stopBatchExport' });
  chrome.runtime.sendMessage({ action: 'stopAiSubmit' });
  setGlobalStop(false);
  setStatus('正在停止所有任务...');
  // 恢复各面板按钮状态
  $('btn-one-click').disabled = false;
  $('btn-one-click').textContent = '一键开始';
  $('btn-batch-stop').disabled = true;
  $('btn-ai-submit').disabled = false;
  $('btn-ai-stop').disabled = true;
});

// ── 配置面板 ──────────────────────────────────────────────────────────────────
$('btn-save-config').addEventListener('click', async () => {
  const cfg = {
    mirror:  $('cfg-mirror').value.trim() || 'sem.3ue.co',
    author:  $('cfg-author').value.trim(),
    aiUrl:   $('cfg-ai-url').value.trim(),
    aiKey:   $('cfg-ai-key').value.trim(),
    aiModel: $('cfg-ai-model').value.trim(),
  };
  const old = await getConfig();
  if (old.brief)     cfg.brief     = old.brief;
  if (old.briefName) cfg.briefName = old.briefName;
  await saveConfig(cfg);
  setStatus('✓ 配置已保存');
});

$('btn-test-ai').addEventListener('click', async () => {
  const url   = $('cfg-ai-url').value.trim();
  const key   = $('cfg-ai-key').value.trim();
  const model = $('cfg-ai-model').value.trim();
  const result = $('ai-test-result');

  if (!url || !key || !model) {
    result.style.color = '#ef4444';
    result.textContent = '请先填写 URL / 密钥 / 模型';
    return;
  }

  $('btn-test-ai').disabled = true;
  result.style.color = '#6b7280';
  result.textContent = '测试中...';

  chrome.runtime.sendMessage(
    { action: 'testAiConfig', url, key, model },
    (resp) => {
      $('btn-test-ai').disabled = false;
      if (resp && resp.ok) {
        result.style.color = '#059669';
        result.textContent = `✓ 成功 · 回复: ${resp.reply}`;
      } else {
        result.style.color = '#ef4444';
        result.textContent = `✗ ${resp?.error || '无响应'}`;
      }
    }
  );
});

async function loadConfigToForm() {
  const cfg = await getConfig();
  if (cfg.mirror)  $('cfg-mirror').value   = cfg.mirror;
  if (cfg.author)  $('cfg-author').value   = cfg.author;
  if (cfg.aiUrl)   $('cfg-ai-url').value   = cfg.aiUrl;
  if (cfg.aiKey)   $('cfg-ai-key').value   = cfg.aiKey;
  if (cfg.aiModel) $('cfg-ai-model').value = cfg.aiModel;
  if (cfg.brief)   $('brief-filename').textContent = cfg.briefName || '已上传';
}

// ── 网站资料 txt 上传 ──────────────────────────────────────────────────────────
$('btn-upload-brief').addEventListener('click', () => $('file-brief').click());
$('file-brief').addEventListener('change', async () => {
  const file = $('file-brief').files[0];
  if (!file) return;
  const text = await file.text();
  const cfg = await getConfig();
  cfg.brief = text.slice(0, 4000); // 最多存 4000 字
  cfg.briefName = file.name;
  await saveConfig(cfg);
  $('brief-filename').textContent = file.name;
  $('file-brief').value = '';
  setStatus('✓ 网站资料已上传');
});

// ══════════════════════════════════════════════════════════════════════════════
// 竞品发现面板
// ══════════════════════════════════════════════════════════════════════════════

function getDiscoverDomains() {
  return $('discover-domains').value
    .split('\n').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'));
}

function updateDomainCount() {
  $('discover-domain-count').textContent = `${getDiscoverDomains().length} 个域名`;
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

// ── 一键开始：Google搜索 → 批量导出 → 交叉分析 ──────────────────────────────
$('btn-one-click').addEventListener('click', async () => {
  const keyword = $('discover-keyword').value.trim();
  const existingDomains = getDiscoverDomains();

  if (!keyword && existingDomains.length === 0) {
    logD('请输入关键词或手动填写竞品域名', 'err'); return;
  }

  const cfg = await getConfig();
  const mirror = cfg.mirror || 'sem.3ue.co';
  const allTabs = await chrome.tabs.query({});
  const semTab = allTabs.find(t => t.url && (
    t.url.includes('semrush.com') || t.url.includes(mirror)
  ));
  if (!semTab) {
    logD(`请先手动打开 ${mirror} 并登录，然后再点击`, 'err'); return;
  }

  $('btn-one-click').disabled = true;
  $('btn-batch-stop').disabled = false;

  let domains = existingDomains;

  // Step 1: Google 搜索（有关键词时执行）
  if (keyword) {
    $('btn-one-click').textContent = '搜索中...';
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
      const found = res[0]?.result || [];
      if (found.length > 0) {
        domains = found;
        $('discover-domains').value = domains.join('\n');
        chrome.storage.local.set({ discoverDomains: domains.join('\n') });
        updateDomainCount();
        logD(`已提取 ${domains.length} 个竞品域名`, 'ok');
      } else {
        logD('未提取到域名（Google 验证码？），使用已有域名列表', 'info');
      }
    } catch (e) {
      logD(`搜索失败: ${e.message}，使用已有域名列表`, 'err');
    }
  }

  if (domains.length === 0) {
    logD('没有可用的竞品域名', 'err');
    $('btn-one-click').disabled = false;
    $('btn-one-click').textContent = '一键开始';
    $('btn-batch-stop').disabled = true;
    return;
  }

  // Step 2: 批量导出（background.js 执行，关闭 popup 不中断）
  $('btn-one-click').textContent = '导出中...';
  logD(`开始批量导出 ${domains.length} 个竞品...`, 'info');
  const followOnly = $('opt-follow-only').checked;
  const activeOnly = $('opt-active-only').checked;
  const res = await chrome.runtime.sendMessage({
    action: 'startBatchExport', domains, semTabId: semTab.id, followOnly, activeOnly, mirror,
  });
  if (!res.ok) {
    logD(`启动失败: ${res.error}`, 'err');
    $('btn-one-click').disabled = false;
    $('btn-one-click').textContent = '一键开始';
    $('btn-batch-stop').disabled = true;
  }
  // Step 3: 交叉分析在 done 消息里自动触发
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
    setGlobalStop(true);
  } else if (msg.type === 'done') {
    $('progress-discover').style.width = '100%';
    $('discover-current').textContent = `完成！已触发 ${msg.doneCount}/${msg.total} 个域名导出`;
    $('btn-one-click').disabled = false;
    $('btn-one-click').textContent = '一键开始';
    $('btn-batch-stop').disabled = true;
    setGlobalStop(false);
    chrome.storage.local.remove('pendingAnalysis');
    const data = msg.analysisData || {};
    if (Object.keys(data).length >= 2) {
      setTimeout(() => runAutoAnalysis(data), 1500);
    } else if (Object.keys(data).length === 1) {
      logD('只有 1 个竞品数据，无法交叉分析（需要 2 个以上）', 'info');
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 交叉分析面板
// ══════════════════════════════════════════════════════════════════════════════

let loadedFiles = []; // [{name, rows}]
let analyzeResults = [];
let analyzeTotal = 0; // 本次分析的文件/竞品总数（用于显示和导出）

// 持久化分析结果（rows 太大不存，只存结果和文件名）
function saveAnalyzeState() {
  chrome.storage.local.set({
    analyzeResults,
    analyzeTotal,
    analyzeFileNames: loadedFiles.map(f => f.name),
  });
}

$('btn-clear-files').addEventListener('click', () => {
  loadedFiles = [];
  analyzeResults = [];
  analyzeTotal = 0;
  renderFileChips();
  updateAnalyzeHint();
  $('btn-export-analyze').disabled = true;
  $('result-scroll').innerHTML = '<div class="empty">分析结果将在此显示<br>域名出现在越多文件中，说明越值得发外链</div>';
  $('section-ai-submit').style.display = 'none';
  clearAnalyzeState();
  setStatus('已清空');
});

function clearAnalyzeState() {
  chrome.storage.local.remove(['analyzeResults', 'analyzeFileNames']);
}

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
    const isExcel = /\.(xlsx|xls)$/i.test(file.name);
    const reader = new FileReader();
    if (isExcel) {
      reader.onload = e => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
          loadedFiles.push({ name: file.name, rows });
          renderFileChips();
          updateAnalyzeHint();
        } catch (err) {
          console.error('Excel 解析失败', file.name, err);
        }
      };
      reader.readAsArrayBuffer(file);
    } else {
      reader.onload = e => {
        const rows = parseCSVText(e.target.result);
        loadedFiles.push({ name: file.name, rows });
        renderFileChips();
        updateAnalyzeHint();
      };
      reader.readAsText(file, 'utf-8');
    }
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

// 垃圾域名过滤：搜索引擎、短链、域名工具、邮件子域等
const SPAM_DOMAINS = new Set([
  // 搜索引擎
  'google.com','google.co.jp','google.co.uk','google.com.au','google.de','google.fr',
  'bing.com','yahoo.com','yandex.com','yandex.ru','baidu.com','duckduckgo.com','ask.com',
  // 社交/大平台（不提供外链价值）
  'facebook.com','twitter.com','x.com','instagram.com','tiktok.com','youtube.com',
  'linkedin.com','pinterest.com','reddit.com','tumblr.com','snapchat.com',
  'whatsapp.com','telegram.org','discord.com','twitch.tv',
  // 短链
  'bit.ly','cutt.ly','t.co','tinyurl.com','ow.ly','buff.ly','goo.gl','rb.gy',
  'short.io','linktr.ee','lnkd.in','amzn.to','youtu.be',
  // 域名/SEO工具
  'getwebsiteworth.com','domainwork.space','domainanalysis.org','similarweb.com',
  'semrush.com','ahrefs.com','moz.com','majestic.com','alexa.com',
  'whois.com','who.is','domaintools.com','namecheap.com','godaddy.com',
  'siteadvisor.com','urlvoid.com','virustotal.com','web.archive.org',
  // 电商/应用商店
  'amazon.com','ebay.com','etsy.com','shopify.com',
  'apps.apple.com','play.google.com','microsoft.com',
  // 其他噪音
  'wikipedia.org','wikimedia.org','archive.org','w3.org',
  'cloudflare.com','wordpress.com','blogger.com','medium.com',
]);

// 垃圾子域前缀
const SPAM_SUBDOMAINS = ['mail.','smtp.','pop.','imap.','ftp.','ns1.','ns2.','cpanel.','webmail.'];

// 垃圾 TLD 或域名特征
function isSpamDomain(domain) {
  if (!domain || !domain.includes('.')) return true;
  if (SPAM_DOMAINS.has(domain)) return true;
  // 搜索引擎子域（search.yahoo.com, news.yahoo.com 等）
  if (domain.endsWith('.yahoo.com') || domain.endsWith('.google.com') ||
      domain.endsWith('.bing.com')  || domain.endsWith('.baidu.com')) return true;
  // 邮件/系统子域
  if (SPAM_SUBDOMAINS.some(p => domain.startsWith(p))) return true;
  // IP 地址
  if (/^\d+\.\d+\.\d+\.\d+$/.test(domain)) return true;
  return false;
}

$('btn-run-analyze').addEventListener('click', async () => {
  if (loadedFiles.length < 2) return;

  $('btn-run-analyze').disabled = true;
  $('analyze-hint').textContent = '分析中，请稍候...';
  await new Promise(r => setTimeout(r, 10)); // 让 UI 先刷新

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

  // 排序：只显示出现在 2+ 文件的，过滤垃圾域名
  analyzeResults = Object.entries(domainFileSets)
    .map(([domain, fileSet]) => ({ domain, count: fileSet.size, files: [...fileSet] }))
    .filter(d => d.count >= 2 && !isSpamDomain(d.domain))
    .sort((a, b) => b.count - a.count);

  analyzeTotal = loadedFiles.length;
  renderAnalyzeResults();
  saveAnalyzeState();
  $('btn-export-analyze').disabled = analyzeResults.length === 0;
  $('btn-run-analyze').disabled = false;
  $('analyze-hint').textContent = `分析完成：${analyzeResults.length} 个域名出现在 2+ 个文件中`;
});

function runAutoAnalysis(data) {
  // 切换到交叉分析 tab
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelector('[data-tab="analyze"]').classList.add('active');
  $('panel-analyze').classList.add('active');
  chrome.storage.local.set({ activeTab: 'analyze' });

  const competitors = Object.keys(data);
  const domainFileSets = {};

  for (const [competitor, referrers] of Object.entries(data)) {
    for (const domain of referrers) {
      if (!domainFileSets[domain]) domainFileSets[domain] = new Set();
      domainFileSets[domain].add(competitor);
    }
  }

  analyzeResults = Object.entries(domainFileSets)
    .map(([domain, fileSet]) => ({ domain, count: fileSet.size, files: [...fileSet] }))
    .filter(d => d.count >= 2 && !isSpamDomain(d.domain))
    .sort((a, b) => b.count - a.count);

  analyzeTotal = competitors.length;

  // 只有在没有手动加载文件时才用竞品名填充 loadedFiles（供导出用）
  if (loadedFiles.length === 0) {
    loadedFiles = competitors.map(name => ({ name, rows: [] }));
    renderFileChips();
  }

  renderAnalyzeResults();
  saveAnalyzeState();
  $('btn-export-analyze').disabled = analyzeResults.length === 0;
  $('analyze-hint').textContent =
    `自动分析完成：${analyzeResults.length} 个域名出现在 2+ 个竞品中（共 ${competitors.length} 个竞品）`;
}

function renderAnalyzeResults() {
  const container = $('result-scroll');
  if (analyzeResults.length === 0) {
    container.innerHTML = '<div class="empty">没有找到在多个文件中重复出现的域名<br>请确认文件包含外链来源 URL</div>';
    $('section-ai-submit').style.display = 'none';
    return;
  }

  $('section-ai-submit').style.display = 'block';

  const total = analyzeTotal || loadedFiles.length;
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
  const total = analyzeTotal || loadedFiles.length;
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

// ── AI 自动提交 ────────────────────────────────────────────────────────────────

const logAI = (m, t) => log('log-ai-submit', m, t);

$('btn-ai-submit').addEventListener('click', async () => {
  if (!analyzeResults.length) { logAI('没有交叉验证结果', 'err'); return; }

  const cfg = await getConfig();
  if (!cfg.aiUrl || !cfg.aiKey || !cfg.aiModel) {
    logAI('请先在「配置」标签填写 AI 中转站信息', 'err'); return;
  }
  if (!cfg.brief) {
    logAI('请先在「配置」标签上传网站资料 txt', 'err'); return;
  }

  const domains = analyzeResults.map(r => r.domain);
  $('btn-ai-submit').disabled = true;
  $('btn-ai-stop').disabled = false;
  $('log-ai-submit').innerHTML = '';
  logAI(`开始处理 ${domains.length} 个域名...`, 'info');

  chrome.runtime.sendMessage({
    action: 'aiAutoSubmit',
    domains,
    config: { author: cfg.author || '', brief: cfg.brief },
    aiConfig: { url: cfg.aiUrl, key: cfg.aiKey, model: cfg.aiModel },
  });
});

$('btn-ai-stop').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'stopAiSubmit' });
  logAI('正在停止...', 'info');
});

$('btn-export-ai-log').addEventListener('click', async () => {
  const stored = await new Promise(r => chrome.storage.local.get('logAiSubmit', r));
  const entries = stored.logAiSubmit || [];
  if (!entries.length) { setStatus('没有日志可导出'); return; }
  const text = entries.map(e => e.text).join('\n');
  const blob = new Blob(['\uFEFF' + text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `AI提交日志_${new Date().toISOString().substring(0, 10)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`✓ 已导出 ${entries.length} 条日志`);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action !== 'aiSubmitProgress') return;
  if (msg.type === 'log') {
    logAI(msg.msg, msg.logType || '');
    setGlobalStop(true);
  } else if (msg.type === 'done') {
    logAI(msg.msg || `完成！成功提交 ${msg.done}/${msg.total} 个`, 'ok');
    $('btn-ai-submit').disabled = false;
    $('btn-ai-stop').disabled = true;
    setGlobalStop(false);
  }
});

// ── 初始化 ────────────────────────────────────────────────────────────────────
(async () => {
  await loadConfigToForm();

  const stored = await new Promise(r => chrome.storage.local.get([
    'discoverDomains', 'discoverKeyword', 'logDiscover', 'logAiSubmit', 'statusBar',
    'batchState', 'pendingAnalysis', 'analyzeResults', 'analyzeFileNames', 'analyzeTotal', 'activeTab',
  ], r));

  if (stored.statusBar) setStatus(stored.statusBar);
  else setStatus('就绪');

  if (stored.logDiscover?.length) restoreLog('log-discover', stored.logDiscover);
  if (stored.logAiSubmit?.length)  restoreLog('log-ai-submit', stored.logAiSubmit);
  if (stored.discoverKeyword) $('discover-keyword').value = stored.discoverKeyword;
  if (stored.discoverDomains) {
    $('discover-domains').value = stored.discoverDomains;
    updateDomainCount();
  }

  // 恢复激活的标签页
  if (stored.activeTab) {
    const activeTabEl = document.querySelector(`[data-tab="${stored.activeTab}"]`);
    if (activeTabEl) {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      activeTabEl.classList.add('active');
      $('panel-' + stored.activeTab).classList.add('active');
    }
  }

  // 恢复交叉分析结果
  if (stored.analyzeResults?.length) {
    analyzeResults = stored.analyzeResults;
    analyzeTotal = stored.analyzeTotal || 0;
    loadedFiles = (stored.analyzeFileNames || []).map(name => ({ name, rows: [] }));
    renderFileChips();
    renderAnalyzeResults();
    $('btn-export-analyze').disabled = false;
    $('btn-run-analyze').disabled = loadedFiles.length < 2;
    $('analyze-hint').textContent = `已恢复上次分析结果：${analyzeResults.length} 个域名`;
  }

  // 查询后台任务运行状态
  const [batchStatus, aiStatus] = await Promise.all([
    new Promise(r => chrome.runtime.sendMessage({ action: 'getBatchStatus' }, resp => r(resp || {}))),
    new Promise(r => chrome.runtime.sendMessage({ action: 'getAiStatus' },   resp => r(resp || {}))),
  ]);

  const bs = stored.batchState;
  if (batchStatus.running && bs) {
    $('btn-one-click').disabled = true;
    $('btn-one-click').textContent = '导出中...';
    $('btn-batch-stop').disabled = false;
    $('discover-current').textContent = `后台运行中... [${bs.current}/${bs.total}] 已完成 ${bs.done} 个`;
    $('progress-discover').style.width = Math.round((bs.current / bs.total) * 100) + '%';
    setGlobalStop(true);
  }

  if (aiStatus.running) {
    $('btn-ai-submit').disabled = true;
    $('btn-ai-stop').disabled = false;
    setGlobalStop(true);
    // 切换到交叉分析 tab 让用户看到日志
    logAI('AI 提交任务后台运行中，点击「停止任务」可中止', 'info');
  }

  // 批量导出完成时 popup 未打开 → 打开后自动触发交叉分析
  const pending = stored.pendingAnalysis;
  if (pending && Object.keys(pending).length >= 2) {
    chrome.storage.local.remove('pendingAnalysis');
    logD(`检测到上次批量导出结果（${Object.keys(pending).length} 个竞品），自动开始交叉分析...`, 'info');
    setTimeout(() => runAutoAnalysis(pending), 800);
  }
})();
