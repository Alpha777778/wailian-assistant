// popup.js — 外链助手 v1.0

const $ = id => document.getElementById(id);

// ── 标签页切换 ────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    $('panel-' + tab.dataset.tab).classList.add('active');
    if (tab.dataset.tab === 'saved') renderSavedList();
    if (tab.dataset.tab === 'submit') refreshSubmitStats();
  });
});

// ── 日志 ──────────────────────────────────────────────────────────────────────
function log(boxId, msg, type = '') {
  const box = $(boxId);
  const line = document.createElement('div');
  line.className = type;
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}
const logE = (m, t) => log('log-extract', m, t);
const logS = (m, t) => log('log-submit', m, t);

function setStatus(msg) { $('status-bar').textContent = msg; }

// ── 存储操作 ──────────────────────────────────────────────────────────────────
async function getLinks() {
  return new Promise(r => chrome.storage.local.get('links', d => r(d.links || [])));
}
async function saveLinks(links) {
  return new Promise(r => chrome.storage.local.set({ links }, r));
}
async function getConfig() {
  return new Promise(r => chrome.storage.local.get('config', d => r(d.config || {})));
}
async function saveConfig(cfg) {
  return new Promise(r => chrome.storage.local.set({ config: cfg }, r));
}

// ── 统计更新 ──────────────────────────────────────────────────────────────────
async function refreshBadge() {
  const links = await getLinks();
  const pending = links.filter(l => l.status === 'pending').length;
  $('badge-saved').textContent = links.length;
  $('cnt-pending').textContent = pending;
  $('cnt-done').textContent = links.filter(l => l.status === 'done').length;
  $('cnt-failed').textContent = links.filter(l => l.status === 'failed').length;
  $('cnt-skip').textContent = links.filter(l => l.status === 'skip').length;
  $('btn-start-submit').disabled = pending === 0;
}

async function refreshSubmitStats() { await refreshBadge(); }

// ── 提取面板 ──────────────────────────────────────────────────────────────────
let currentExtracted = [];

$('btn-extract').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url.includes('backlinks/backlinks')) {
    logE('请先打开 SEMrush 反向链接列表页', 'err');
    setStatus('❌ 请打开 SEMrush 反向链接页面');
    return;
  }

  // 从 URL 提取竞品域名
  const urlObj = new URL(tab.url);
  const qParam = urlObj.searchParams.get('q') || '';
  let competitor = '';
  try {
    competitor = new URL(decodeURIComponent(qParam)).hostname.replace(/^www\./, '');
  } catch {
    competitor = qParam.replace(/https?:\/\//, '').split('/')[0];
  }

  logE(`开始提取 [竞品: ${competitor || '未知'}]，自动翻页...`, 'info');
  setStatus('提取中...');
  $('btn-extract').disabled = true;
  currentExtracted = [];
  let pageNum = 0;

  const minAs = parseInt((await getConfig()).minAs || 10);

  let hasNext = true;
  while (hasNext) {
    pageNum++;
    $('cnt-pages').textContent = pageNum;

    try {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: extractBacklinksFromPage,
      });
      const pageLinks = (res[0]?.result || []).map(l => ({
        ...l,
        competitor,          // 记录来源竞品
        status: 'pending',
        extractedAt: new Date().toISOString(),
      }));

      currentExtracted.push(...pageLinks);
      $('cnt-total').textContent = currentExtracted.length;
      $('cnt-blog').textContent = currentExtracted.filter(l => l.isBlog).length;
      $('cnt-content').textContent = currentExtracted.filter(l => l.placement === 'content').length;

      // 如果这一页没有一条达到 minAs，说明后面全是低分，直接停
      const pageQualified = pageLinks.filter(l => l.as >= minAs).length;
      if (pageQualified === 0 && pageLinks.length > 0) {
        logE(`  第 ${pageNum} 页：${pageLinks.length} 条（累计 ${currentExtracted.length}）— 全部低于 AS ${minAs}，停止翻页`, 'info');
        hasNext = false;
      } else {
        logE(`  第 ${pageNum} 页：${pageLinks.length} 条（累计 ${currentExtracted.length}）`);
        const nextRes = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: clickNextPage,
        });
        hasNext = nextRes[0]?.result === true;
        if (hasNext) await sleep(2000);
      }
    } catch (e) {
      logE(`  第 ${pageNum} 页失败: ${e.message}`, 'err');
      hasNext = false;
    }
  }

  // 按 AS 过滤
  const filtered = currentExtracted.filter(l => l.as >= minAs);
  const skipped = currentExtracted.length - filtered.length;
  if (skipped > 0) logE(`  AS < ${minAs} 过滤掉 ${skipped} 条`, 'info');

  // 合并保存（去重，按 sourceUrl）
  const existing = await getLinks();
  const existingUrls = new Set(existing.map(l => l.sourceUrl));
  const newLinks = filtered.filter(l => !existingUrls.has(l.sourceUrl));
  const merged = [...existing, ...newLinks];
  await saveLinks(merged);
  await refreshBadge();

  $('progress-extract').style.width = '100%';
  logE(`完成！新增 ${newLinks.length} 条（已去重），总计 ${merged.length} 条`, 'ok');
  setStatus(`✓ 新增 ${newLinks.length} 条，总计 ${merged.length} 条`);
  $('btn-extract').disabled = false;
});

// ── 导出 Excel（CSV）─────────────────────────────────────────────────────────
function exportToCSV(links, filename) {
  const headers = ['来源URL', '竞品域名', 'AS分', '放置位置', '是否博客', '目标URL', '状态', '提取时间'];
  const rows = links.map(l => [
    l.sourceUrl,
    l.competitor || '',
    l.as,
    l.placement === 'content' ? '正文' : l.placement === 'nav' ? '导航' : '其他',
    l.isBlog ? '是' : '否',
    l.targetUrl || '',
    l.status === 'done' ? '已提交' : l.status === 'failed' ? '失败' : l.status === 'skip' ? '跳过' : '待提交',
    l.extractedAt ? l.extractedAt.substring(0, 10) : '',
  ]);

  const csv = '\uFEFF' + [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
    .join('\n');

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

$('btn-save-csv').addEventListener('click', async () => {
  if (currentExtracted.length === 0) {
    logE('请先提取外链', 'err'); return;
  }
  exportToCSV(currentExtracted, `外链_${new Date().toISOString().substring(0,10)}.csv`);
  logE(`已导出 ${currentExtracted.length} 条到 Excel`, 'ok');
});

$('btn-export-all').addEventListener('click', async () => {
  const links = await getLinks();
  if (!links.length) return;
  exportToCSV(links, `外链全部_${new Date().toISOString().substring(0,10)}.csv`);
});

$('btn-export-pending').addEventListener('click', async () => {
  const links = (await getLinks()).filter(l => l.status === 'pending');
  if (!links.length) return;
  exportToCSV(links, `外链待提交_${new Date().toISOString().substring(0,10)}.csv`);
});

$('btn-clear-all').addEventListener('click', async () => {
  if (!confirm('确定清空所有已保存的外链？')) return;
  await saveLinks([]);
  await refreshBadge();
  renderSavedList();
});

// ── 已保存列表渲染 ────────────────────────────────────────────────────────────
async function renderSavedList() {
  const links = await getLinks();
  const container = $('saved-list');

  if (!links.length) {
    container.innerHTML = '<div class="empty">暂无保存的外链<br>提取后自动保存</div>';
    return;
  }

  // 按竞品分组
  const groups = {};
  for (const l of links) {
    const key = l.competitor || '未知来源';
    if (!groups[key]) groups[key] = [];
    groups[key].push(l);
  }

  container.innerHTML = '';
  for (const [competitor, items] of Object.entries(groups)) {
    const done = items.filter(l => l.status === 'done').length;
    const pending = items.filter(l => l.status === 'pending').length;

    const group = document.createElement('div');
    group.className = 'competitor-group';

    const header = document.createElement('div');
    header.className = 'competitor-header';
    header.innerHTML = `
      <span>🎯 ${competitor}</span>
      <span class="competitor-count">${items.length} 条 · 待提交 ${pending} · 已完成 ${done}</span>
    `;
    group.appendChild(header);

    // 展开/折叠
    const body = document.createElement('div');
    body.style.display = 'none';
    header.addEventListener('click', () => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    });

    for (const l of items.slice(0, 50)) {
      const item = document.createElement('div');
      item.className = 'link-item';

      const statusTag = l.status === 'done'
        ? '<span class="tag tag-green">已提交</span>'
        : l.status === 'failed'
        ? '<span class="tag tag-red">失败</span>'
        : l.status === 'skip'
        ? '<span class="tag tag-gray">跳过</span>'
        : '<span class="tag tag-blue">待提交</span>';

      const placementTag = l.placement === 'content'
        ? '<span class="tag tag-yellow">正文</span>'
        : '';

      const blogTag = l.isBlog ? '<span class="tag tag-green">博客</span>' : '';

      item.innerHTML = `
        <div class="link-as">${l.as}</div>
        <div class="link-body">
          <div class="link-url" title="${l.sourceUrl}">${l.sourceUrl}</div>
          <div class="link-meta">${statusTag}${placementTag}${blogTag}</div>
        </div>
      `;
      body.appendChild(item);
    }

    if (items.length > 50) {
      const more = document.createElement('div');
      more.style.cssText = 'padding:6px 10px;font-size:10px;color:#4a5568;text-align:center';
      more.textContent = `... 还有 ${items.length - 50} 条`;
      body.appendChild(more);
    }

    group.appendChild(body);
    container.appendChild(group);
  }
}

// ── 提交面板 ──────────────────────────────────────────────────────────────────
let isSubmitting = false;

$('btn-start-submit').addEventListener('click', async () => {
  if (isSubmitting) {
    isSubmitting = false;
    $('btn-start-submit').textContent = '开始提交';
    $('btn-start-submit').className = 'btn btn-success';
    logS('已停止', 'info');
    return;
  }

  const cfg = await getConfig();
  if (!cfg.author || !cfg.email || !cfg.site) {
    logS('请先在"配置"标签页填写评论者信息', 'err');
    return;
  }

  const links = await getLinks();
  const minAs = parseInt(cfg.minAs || 10);
  const batch = parseInt(cfg.batch || 20);
  const delay = parseInt(cfg.delay || 45);

  const queue = links
    .filter(l => l.status === 'pending' && l.as >= minAs)
    .slice(0, batch);

  if (!queue.length) {
    logS('没有待提交的外链（检查 AS 分过滤条件）', 'err');
    return;
  }

  isSubmitting = true;
  $('btn-start-submit').textContent = '停止';
  $('btn-start-submit').className = 'btn btn-danger';
  logS(`开始提交 ${queue.length} 条，间隔 ${delay}s`, 'info');

  let done = 0;
  for (let i = 0; i < queue.length; i++) {
    if (!isSubmitting) break;

    const link = queue[i];
    const pct = Math.round((i / queue.length) * 100);
    $('progress-submit').style.width = pct + '%';
    logS(`[${i+1}/${queue.length}] ${link.sourceUrl.substring(0, 55)}`, 'info');

    const comment = cfg.comment || randomComment();
    try {
      const result = await chrome.runtime.sendMessage({
        action: 'submitComment',
        url: link.sourceUrl,
        config: { author: cfg.author, email: cfg.email, site: cfg.site, comment },
      });

      // 更新状态
      const allLinks = await getLinks();
      const idx = allLinks.findIndex(l => l.sourceUrl === link.sourceUrl);
      if (idx !== -1) {
        allLinks[idx].status = result.success ? 'done' : 'failed';
        allLinks[idx].linkType = result.linkType || '';
        allLinks[idx].submittedAt = new Date().toISOString();
        if (!result.success) allLinks[idx].error = result.error;
        await saveLinks(allLinks);
      }

      if (result.success) {
        done++;
        logS(`  ✓ 成功 [${result.linkType || 'pending'}]`, 'ok');
      } else {
        logS(`  ✗ ${result.error}`, 'err');
      }
    } catch (e) {
      logS(`  ✗ ${e.message}`, 'err');
    }

    await refreshBadge();

    if (i < queue.length - 1 && isSubmitting) {
      const d = delay + Math.floor(Math.random() * 30);
      logS(`  等待 ${d}s...`);
      await sleep(d * 1000);
    }
  }

  $('progress-submit').style.width = '100%';
  isSubmitting = false;
  $('btn-start-submit').textContent = '开始提交';
  $('btn-start-submit').className = 'btn btn-success';
  logS(`完成！本次提交 ${done} 条`, 'ok');
  setStatus(`✓ 本次提交 ${done} 条`);
});

$('btn-reset-failed').addEventListener('click', async () => {
  const links = await getLinks();
  links.forEach(l => { if (l.status === 'failed') l.status = 'pending'; });
  await saveLinks(links);
  await refreshBadge();
  logS('已重置失败记录为待提交', 'info');
});

// ── 配置面板 ──────────────────────────────────────────────────────────────────
$('btn-save-config').addEventListener('click', async () => {
  const cfg = {
    author: $('cfg-author').value.trim(),
    email: $('cfg-email').value.trim(),
    site: $('cfg-site').value.trim(),
    comment: $('cfg-comment').value.trim(),
    minAs: $('cfg-min-as').value,
    delay: $('cfg-delay').value,
    batch: $('cfg-batch').value,
  };
  await saveConfig(cfg);
  setStatus('✓ 配置已保存');
  await refreshBadge();
});

async function loadConfigToForm() {
  const cfg = await getConfig();
  if (cfg.author) $('cfg-author').value = cfg.author;
  if (cfg.email) $('cfg-email').value = cfg.email;
  if (cfg.site) $('cfg-site').value = cfg.site;
  if (cfg.comment) $('cfg-comment').value = cfg.comment;
  if (cfg.minAs) $('cfg-min-as').value = cfg.minAs;
  if (cfg.delay) $('cfg-delay').value = cfg.delay;
  if (cfg.batch) $('cfg-batch').value = cfg.batch;
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function randomComment() {
  const list = [
    '非常感谢这篇深度文章！内容很有价值，特别是实操部分让我受益匪浅。期待更多类似内容。',
    '写得很好，把核心要点都讲清楚了。我在实践中也遇到过类似问题，这篇文章给了很好的思路。',
    '很有价值的分享！已收藏，会推荐给同行。感谢作者的用心整理。',
    '这篇文章解答了我长期以来的疑惑，感谢分享！期待更多类似内容。',
    'Great article! Very informative and well-written. Thanks for sharing your insights.',
    'This is exactly what I was looking for. Very helpful content, bookmarked!',
  ];
  return list[Math.floor(Math.random() * list.length)];
}

// ── 注入到 SEMrush 页面：点击下一页 ──────────────────────────────────────────
function clickNextPage() {
  const btn = document.querySelector('[data-test-pagination-next-btn]');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
}

// ── 注入到 SEMrush 页面的提取函数 ────────────────────────────────────────────
function extractBacklinksFromPage() {
  const BLOG_PATTERNS = [
    /\/\d{4}\/\d{2}\//,/\/blog\//,/\/post\//,/\/article\//,/\/p\/\d+/,
    /\.html$/,/\/\d{4}-\d{2}-\d{2}/,/blogspot\.com/,/wordpress\.com/,
    /velog\.io/,/dev\.to/,/medium\.com/,/substack\.com/,
  ];
  const EXCLUDE = [
    'reddit.com','twitter.com','x.com','facebook.com','youtube.com',
    'linkedin.com','quora.com','stackoverflow.com','github.com',
    'amazon.com','wikipedia.org','semrush.com','apple.com',
    'google.com','yahoo.com','bing.com','play.google.com','apps.apple.com',
  ];
  function isSearchPage(url) {
    try {
      const u = new URL(url);
      return u.pathname.includes('/search') || u.searchParams.has('q') ||
             u.searchParams.has('query') || u.searchParams.has('p');
    } catch { return false; }
  }
  function isBlogUrl(url) {
    try {
      const u = new URL(url);
      const d = u.hostname.toLowerCase();
      if (EXCLUDE.some(e => d.includes(e))) return false;
      if (isSearchPage(url)) return false;
      return BLOG_PATTERNS.some(p => p.test(u.pathname + url));
    } catch { return false; }
  }

  const rows = document.querySelectorAll('[data-test-tbody-tr]');
  const results = [];
  for (const row of rows) {
    const asCell = row.querySelector('[name="ascore"]');
    const as = asCell ? parseInt(asCell.textContent.trim()) || 0 : 0;

    const sourceCell = row.querySelector('[name="source"]');
    const sourceLinks = sourceCell ? sourceCell.querySelectorAll('a[href^="http"]') : [];
    const sourceUrl = sourceLinks.length >= 2 ? sourceLinks[1].href : (sourceLinks[0]?.href || '');
    if (!sourceUrl) continue;

    const targetCell = row.querySelector('[name="target"]');
    const targetLinks = targetCell ? targetCell.querySelectorAll('a[href^="http"]') : [];
    const targetUrl = targetLinks.length >= 2 ? targetLinks[1].href : (targetLinks[0]?.href || '');

    const tags = Array.from(row.querySelectorAll('[data-ui-name="Tag"]')).map(el => el.textContent.trim());
    if (tags.some(t => t.includes('丢失'))) continue;

    const placement = tags.includes('内容') ? 'content' : tags.includes('导航') ? 'nav' : 'other';

    if (isSearchPage(sourceUrl)) continue;
    try {
      const d = new URL(sourceUrl).hostname.toLowerCase();
      if (EXCLUDE.some(e => d.includes(e))) continue;
    } catch { continue; }

    let score = as;
    if (placement === 'content') score += 20;
    if (isBlogUrl(sourceUrl)) score += 15;

    results.push({ as, score, sourceUrl, targetUrl, placement, isBlog: isBlogUrl(sourceUrl) });
  }
  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── 竞品发现面板 ──────────────────────────────────────────────────────────────
const logD = (m, t) => log('log-discover', m, t);
let discoverRunning = false;
let discoverStop = false;

function getDiscoverDomains() {
  return $('discover-domains').value
    .split('\n').map(s => s.trim()).filter(s => s.length > 0 && !s.startsWith('#'));
}

function updateDomainCount() {
  const n = getDiscoverDomains().length;
  $('discover-domain-count').textContent = `${n} 个域名`;
  $('btn-batch-extract').disabled = n === 0 || discoverRunning;
}

$('discover-domains').addEventListener('input', () => {
  updateDomainCount();
  chrome.storage.local.set({ discoverDomains: $('discover-domains').value });
});

$('discover-keyword').addEventListener('input', () => {
  chrome.storage.local.set({ discoverKeyword: $('discover-keyword').value });
});

// 等待 tab 加载完成（带超时）
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

// 注入到 Google 页面：提取前10有机结果域名
function extractGoogleDomains() {
  const EXCLUDE = ['google.', 'youtube.com', 'facebook.com', 'twitter.com',
                   'instagram.com', 'linkedin.com', 'wikipedia.org', 'amazon.com',
                   'x.com', 'tiktok.com', 'pinterest.com'];
  const domains = [];
  const seen = new Set();

  // 多种选择器兼容不同 Google 布局
  const anchors = document.querySelectorAll(
    '#search .g a[href^="http"], #rso a[href^="http"], .yuRUbf a[href^="http"]'
  );
  for (const a of anchors) {
    try {
      const u = new URL(a.href);
      const domain = u.hostname.replace(/^www\./, '');
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

// 批量提取
$('btn-batch-extract').addEventListener('click', async () => {
  const domains = getDiscoverDomains();
  if (domains.length === 0) { logD('请先添加竞品域名', 'err'); return; }

  // 找已打开的镜像站 tab
  const allTabs = await chrome.tabs.query({});
  const semTab = allTabs.find(t => t.url && (
    t.url.includes('semrush.com') || t.url.includes('3ue.co')
  ));
  if (!semTab) {
    logD('请先手动打开 SEMrush 镜像站（sem.3ue.co）并登录，然后再点击此按钮', 'err');
    return;
  }

  discoverRunning = true;
  discoverStop = false;
  $('btn-batch-extract').disabled = true;
  $('btn-batch-stop').disabled = false;

  let doneCount = 0;

  for (let i = 0; i < domains.length; i++) {
    if (discoverStop) { logD('已停止', 'info'); break; }

    const domain = domains[i];
    const pct = Math.round((i / domains.length) * 100);
    $('progress-discover').style.width = pct + '%';
    $('discover-current').textContent = `[${i+1}/${domains.length}] 正在处理: ${domain}`;
    logD(`[${i+1}/${domains.length}] ${domain}`, 'info');

    // 导航到该域名的外链页
    const backlinkUrl = `https://sem.3ue.co/analytics/backlinks/backlinks/?q=${encodeURIComponent(domain)}&searchType=domain`;
    await chrome.tabs.update(semTab.id, { url: backlinkUrl });
    await waitForTabLoad(semTab.id);
    await sleep(3000);

    // 点击 Follow 过滤
    const followRes = await chrome.scripting.executeScript({
      target: { tabId: semTab.id },
      func: () => {
        const all = document.querySelectorAll('button, [role="button"], span[class*="Button"], div[class*="Button"]');
        for (const el of all) {
          if (el.textContent.trim() === 'Follow') { el.click(); return true; }
        }
        return false;
      },
    });
    if (followRes[0]?.result) {
      logD('  ✓ 已点击 Follow 过滤', 'ok');
      await sleep(1500);
    } else {
      logD('  ⚠ 未找到 Follow 按钮，直接导出', 'info');
    }

    // 等待导出按钮可点击（Follow 过滤后需要几秒刷新）
    await sleep(4000);

    // 点击导出按钮：精确匹配 data-ui-name="Button.Text" 且文本为"导出"
    const exportRes = await chrome.scripting.executeScript({
      target: { tabId: semTab.id },
      func: () => {
        // 优先用 data-ui-name 精确匹配
        const spans = document.querySelectorAll('[data-ui-name="Button.Text"]');
        for (const el of spans) {
          if (el.textContent.trim() === '导出') {
            // 点击其父级 button 元素
            const btn = el.closest('button') || el.parentElement;
            btn.click();
            return true;
          }
        }
        // 兜底：找所有 button，文本严格等于"导出"
        for (const btn of document.querySelectorAll('button')) {
          if (btn.textContent.trim() === '导出') { btn.click(); return true; }
        }
        return false;
      },
    });
    if (!exportRes[0]?.result) {
      logD('  ✗ 未找到导出按钮，跳过', 'err');
      continue;
    }
    await sleep(1000);

    // 点击下拉菜单中的 Excel 选项
    const xlsRes = await chrome.scripting.executeScript({
      target: { tabId: semTab.id },
      func: () => {
        // 找所有可见的菜单项/列表项
        const candidates = document.querySelectorAll(
          '[role="menuitem"], [role="option"], li, [data-ui-name="MenuItem"], button'
        );
        for (const el of candidates) {
          if (el.textContent.trim() === 'Excel') { el.click(); return true; }
        }
        // 兜底：找含 Excel 文字的任意元素（排除已有的导出按钮）
        const all = document.querySelectorAll('span, div, a');
        for (const el of all) {
          if (el.textContent.trim() === 'Excel' && el.offsetParent !== null) {
            el.click(); return true;
          }
        }
        return false;
      },
    });
    if (xlsRes[0]?.result) {
      doneCount++;
      logD(`  ✓ 已触发 Excel 导出`, 'ok');
    } else {
      logD('  ✗ 未找到 Excel 选项', 'err');
    }

    // 等待下载开始再处理下一个
    if (i < domains.length - 1 && !discoverStop) await sleep(4000);
  }

  $('progress-discover').style.width = '100%';
  $('discover-current').textContent = `完成！已触发 ${doneCount}/${domains.length} 个域名导出`;
  logD(`批量导出完成，${doneCount} 个域名已触发下载，文件保存在下载目录`, 'ok');

  discoverRunning = false;
  discoverStop = false;
  $('btn-batch-extract').disabled = false;
  $('btn-batch-stop').disabled = true;
});

$('btn-batch-stop').addEventListener('click', () => {
  discoverStop = true;
  logD('正在停止，等待当前域名完成...', 'info');
});

// ── 初始化 ────────────────────────────────────────────────────────────────────
(async () => {
  await loadConfigToForm();
  await refreshBadge();
  setStatus('就绪 — 打开 SEMrush 反向链接页面后点击"提取外链"');

  // 恢复竞品发现面板的内容
  const stored = await new Promise(r => chrome.storage.local.get(['discoverDomains', 'discoverKeyword'], r));
  if (stored.discoverKeyword) $('discover-keyword').value = stored.discoverKeyword;
  if (stored.discoverDomains) {
    $('discover-domains').value = stored.discoverDomains;
    updateDomainCount();
  }
})();
