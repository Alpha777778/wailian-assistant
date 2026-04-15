// background.js — 处理评论提交 + 批量导出（在独立 tab 中操作）

let batchRunning = false;
let batchStop = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'submitComment') {
    submitToUrl(msg.url, msg.config)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true;
  }

  if (msg.action === 'startBatchExport') {
    if (batchRunning) { sendResponse({ ok: false, error: '已在运行中' }); return true; }
    startBatchExport(msg.domains, msg.semTabId, msg.followOnly !== false, msg.mirror || 'sem.3ue.co').catch(console.error);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'stopBatchExport') {
    batchStop = true;
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'getBatchStatus') {
    sendResponse({ running: batchRunning });
    return;
  }
});

// 向 popup 推送进度（popup 关着时静默忽略）
function notifyPopup(data) {
  chrome.runtime.sendMessage({ action: 'batchProgress', ...data }).catch(() => {});
}

// ── 批量导出主循环 ─────────────────────────────────────────────────────────────
async function startBatchExport(domains, semTabId, followOnly = true, mirror = 'sem.3ue.co') {
  batchRunning = true;
  batchStop = false;
  let doneCount = 0;
  const analysisData = {}; // { competitorDomain: [referringDomain, ...] }

  chrome.storage.local.set({ batchState: { running: true, domains, current: 0, done: 0, total: domains.length } });

  for (let i = 0; i < domains.length; i++) {
    if (batchStop) {
      notifyPopup({ type: 'log', msg: '已停止', logType: 'info' });
      break;
    }

    const domain = domains[i];
    const pct = Math.round((i / domains.length) * 100);
    notifyPopup({ type: 'progress', pct, current: `[${i+1}/${domains.length}] 正在处理: ${domain}` });
    notifyPopup({ type: 'log', msg: `[${i+1}/${domains.length}] ${domain}`, logType: 'info' });
    chrome.storage.local.set({ batchState: { running: true, domains, current: i, done: doneCount, total: domains.length } });

    // 导航到该域名外链页
    const url = `https://${mirror}/analytics/backlinks/backlinks/?q=${encodeURIComponent(domain)}&searchType=domain`;
    try {
      await chrome.tabs.update(semTabId, { url });
    } catch (e) {
      notifyPopup({ type: 'log', msg: `  ✗ 无法导航（镜像站 tab 已关闭？）: ${e.message}`, logType: 'err' });
      break;
    }
    await waitForTabLoad(semTabId);
    await sleep(3000);

    // 点击 Follow 过滤（可选）
    if (followOnly) {
      const followRes = await chrome.scripting.executeScript({
      target: { tabId: semTabId },
      func: () => {
        const spans = document.querySelectorAll('[data-ui-name="Button.Text"]');
        for (const el of spans) {
          if (el.textContent.trim() === 'Follow') {
            (el.closest('button') || el.parentElement).click(); return true;
          }
        }
        for (const btn of document.querySelectorAll('button')) {
          if (btn.textContent.trim() === 'Follow') { btn.click(); return true; }
        }
        return false;
      },
    }).catch(() => [{ result: false }]);

      if (followRes[0]?.result) {
        notifyPopup({ type: 'log', msg: '  ✓ 已点击 Follow 过滤', logType: 'ok' });
      } else {
        notifyPopup({ type: 'log', msg: '  ⚠ 未找到 Follow 按钮，直接导出', logType: 'info' });
      }
      // 等待页面刷新后导出按钮可用
      await sleep(4500);
    } else {
      await sleep(1500);
    }

    // 抓取表格中的引用域名（用于自动交叉分析）
    const scrapeRes = await chrome.scripting.executeScript({
      target: { tabId: semTabId },
      func: (competitorDomain) => {
        const seen = new Set();
        const selectors = [
          'td a[href^="http"]',
          '[role="gridcell"] a[href^="http"]',
          '[role="cell"] a[href^="http"]',
        ];
        for (const sel of selectors) {
          for (const link of document.querySelectorAll(sel)) {
            try {
              const d = new URL(link.href).hostname.replace(/^www\./, '').toLowerCase();
              if (d && d.includes('.') &&
                  !d.includes(competitorDomain) &&
                  !competitorDomain.includes(d)) {
                seen.add(d);
              }
            } catch {}
          }
        }
        return [...seen];
      },
      args: [domain],
    }).catch(() => [{ result: [] }]);

    const referrers = scrapeRes[0]?.result || [];
    if (referrers.length > 0) {
      analysisData[domain] = referrers;
      notifyPopup({ type: 'log', msg: `  ✓ 已抓取 ${referrers.length} 个引用域名`, logType: 'ok' });
    }

    // 点击导出按钮
    const exportRes = await chrome.scripting.executeScript({
      target: { tabId: semTabId },
      func: () => {
        const spans = document.querySelectorAll('[data-ui-name="Button.Text"]');
        for (const el of spans) {
          if (el.textContent.trim() === '导出') {
            (el.closest('button') || el.parentElement).click(); return true;
          }
        }
        for (const btn of document.querySelectorAll('button')) {
          if (btn.textContent.trim() === '导出') { btn.click(); return true; }
        }
        return false;
      },
    }).catch(() => [{ result: false }]);

    if (!exportRes[0]?.result) {
      notifyPopup({ type: 'log', msg: '  ✗ 未找到导出按钮，跳过', logType: 'err' });
      continue;
    }

    // 等下拉菜单出现（增加到 3s）
    await sleep(3000);

    // 点击 Excel 选项
    const xlsRes = await chrome.scripting.executeScript({
      target: { tabId: semTabId },
      func: () => {
        function fire(el) {
          ['mousedown','mouseup','click'].forEach(type =>
            el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }))
          );
        }
        const byAttr = document.querySelector(
          '[data-ui-name="DropdownMenu.Item"][value="xls"], [data-test-export-type="xls"]'
        );
        if (byAttr) { fire(byAttr); return true; }
        for (const el of document.querySelectorAll('[role="menuitem"]')) {
          if (el.textContent.trim() === 'Excel') { fire(el); return true; }
        }
        for (const el of document.querySelectorAll('[data-ui-name="DropdownMenu.Item"]')) {
          if (el.textContent.trim() === 'Excel') { fire(el); return true; }
        }
        return false;
      },
    }).catch(() => [{ result: false }]);

    if (xlsRes[0]?.result) {
      doneCount++;
      notifyPopup({ type: 'log', msg: '  ✓ 已点击 Excel，文件下载中', logType: 'ok' });
    } else {
      notifyPopup({ type: 'log', msg: '  ✗ 未找到 Excel 选项（下拉未出现？）', logType: 'err' });
    }

    chrome.storage.local.set({ batchState: { running: true, domains, current: i + 1, done: doneCount, total: domains.length } });

    if (i < domains.length - 1 && !batchStop) await sleep(4000);
  }

  notifyPopup({ type: 'done', doneCount, total: domains.length, analysisData });
  chrome.storage.local.set({ batchState: { running: false, domains, current: domains.length, done: doneCount, total: domains.length } });
  batchRunning = false;
  batchStop = false;
}



async function submitToUrl(url, config) {
  // 打开新 tab
  const tab = await chrome.tabs.create({ url, active: false });

  // 等待页面加载
  await waitForTabLoad(tab.id);
  await sleep(1500);

  // 注入提交脚本
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: submitCommentOnPage,
    args: [config],
  });

  const result = results[0]?.result || { success: false, error: '脚本执行失败' };

  // 等一下再关闭（让表单提交完成）
  await sleep(2000);
  chrome.tabs.remove(tab.id).catch(() => {});

  return result;
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    // 超时保护
    setTimeout(resolve, 15000);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── 注入到博客页面的评论提交函数 ─────────────────────────────────────────────
function submitCommentOnPage(config) {
  const SPAM_SKIP = ['cleantalk', 'hcaptcha', 'jetpack'];

  function findForm() {
    const selectors = [
      '#commentform', 'form#respond', '.comment-form',
      "form[id*='comment']", "form[class*='comment']",
    ];
    for (const sel of selectors) {
      const f = document.querySelector(sel);
      if (f) return f;
    }
    // 找包含 textarea 的 form
    for (const f of document.querySelectorAll('form')) {
      if (f.querySelector('textarea')) return f;
    }
    return null;
  }

  function checkSpam() {
    const html = document.documentElement.innerHTML.toLowerCase();
    return SPAM_SKIP.some(s => html.includes(s));
  }

  function fillField(form, selectors, value) {
    for (const sel of selectors) {
      const el = form.querySelector(sel);
      if (el) {
        el.focus();
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }
    }
    return false;
  }

  // 检查反垃圾系统
  if (checkSpam()) {
    return { success: false, error: '检测到不可绕过的反垃圾系统' };
  }

  const form = findForm();
  if (!form) {
    return { success: false, error: '找不到评论表单' };
  }

  // 填写字段
  fillField(form, ['input[name="author"]', 'input[name="name"]', '#author', '#name'], config.author);
  fillField(form, ['input[name="email"]', 'input[type="email"]', '#email'], config.email);
  fillField(form, ['input[name="url"]', 'input[name="website"]', '#url', '#website'], config.site);

  // 评论内容（逐字符模拟输入，绕过 Antispam Bee）
  const textarea = form.querySelector('textarea[name="comment"], textarea[name="content"], textarea');
  if (!textarea) {
    return { success: false, error: '找不到评论文本框' };
  }
  textarea.focus();
  textarea.value = config.comment;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true }));

  // 提交
  const submitBtn = form.querySelector(
    'input[type="submit"], button[type="submit"], input[name="submit"], button[name="submit"]'
  );

  if (submitBtn) {
    submitBtn.click();
  } else {
    form.submit();
  }

  // 等待一下，检查 rel 属性
  return new Promise(resolve => {
    setTimeout(() => {
      try {
        const siteHost = new URL(config.site).hostname;
        const links = document.querySelectorAll(`a[href*="${siteHost}"]`);
        let linkType = 'pending_moderation';
        if (links.length > 0) {
          const rel = links[0].rel?.toLowerCase() || '';
          if (rel.includes('nofollow') || rel.includes('ugc')) {
            linkType = 'nofollow';
          } else {
            linkType = 'dofollow';
          }
        }
        resolve({ success: true, linkType });
      } catch (e) {
        resolve({ success: true, linkType: 'pending_moderation' });
      }
    }, 2000);
  });
}
