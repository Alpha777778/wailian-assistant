// background.js — 处理评论提交 + 批量导出（在独立 tab 中操作）

// 防止 service worker 被 Chrome 挂起（每20s触发一次存储读取保持活跃）
setInterval(() => chrome.storage.local.get('_keepalive'), 20000);

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
    startBatchExport(msg.domains, msg.semTabId, msg.followOnly !== false, msg.activeOnly === true, msg.mirror || 'sem.3ue.co').catch(console.error);
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

  if (msg.action === 'getAiStatus') {
    sendResponse({ running: aiRunning || csvRunning });
    return;
  }

  if (msg.action === 'testAiConfig') {
    const aiConfig = msg.aiConfig || { url: msg.url, key: msg.key, model: msg.model, mode: 'custom' };
    callAI(
      aiConfig,
      '你是助手，简短回复。',
      '回复"OK"两个字'
    )
      .then(reply => sendResponse({ ok: true, reply: reply.slice(0, 30) }))
      .catch(e  => sendResponse({ ok: false, error: e.message.slice(0, 80) }));
    return true;
  }

  if (msg.action === 'aiAutoSubmit') {
    if (aiRunning) { sendResponse({ ok: false, error: '已在运行中' }); return true; }
    aiSubmitLoop(msg.domains, msg.config, msg.aiConfig).catch(console.error);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'stopAiSubmit') {
    aiStop = true;
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'startCsvSubmit') {
    if (csvRunning) { sendResponse({ ok: false, error: '已在运行中' }); return true; }
    csvSubmitLoop(msg.domains, msg.config, msg.aiConfig).catch(console.error);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'stopCsvSubmit') {
    csvStop = true;
    if (csvNextResolve) { csvNextResolve(); csvNextResolve = null; }
    sendResponse({ ok: true });
    return;
  }

  if (msg.action === 'csvNextDomain') {
    if (csvNextResolve) { csvNextResolve(); csvNextResolve = null; }
    sendResponse({ ok: true });
    return;
  }
});

// 向 popup 推送进度（popup 关着时静默忽略）
function notifyPopup(data) {
  chrome.runtime.sendMessage({ action: 'batchProgress', ...data }).catch(() => {});
}

// ── 批量导出主循环 ─────────────────────────────────────────────────────────────
async function startBatchExport(domains, semTabId, followOnly = true, activeOnly = false, mirror = 'sem.3ue.co') {
  batchRunning = true;
  batchStop = false;
  let doneCount = 0;
  const analysisData = {}; // { competitorDomain: [referringDomain, ...] }

  const sanitizedDomains = sanitizeDomainsForNavigation(domains);
  if (sanitizedDomains.length < domains.length) {
    notifyPopup({ type: 'log', msg: `过滤掉 ${domains.length - sanitizedDomains.length} 个非法域名，剩余 ${sanitizedDomains.length} 个`, logType: 'info' });
  }
  domains = sanitizedDomains;
  if (!domains.length) {
    notifyPopup({ type: 'done', doneCount: 0, total: 0, analysisData: {} });
    chrome.storage.local.set({ batchState: { running: false, domains: [], current: 0, done: 0, total: 0 } });
    batchRunning = false;
    return;
  }

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

    // 点击 Active 过滤（可选）
    if (activeOnly) {
      const activeRes = await chrome.scripting.executeScript({
        target: { tabId: semTabId },
        func: () => {
          const spans = document.querySelectorAll('[data-ui-name="Button.Text"]');
          for (const el of spans) {
            const t = el.textContent.trim();
            if (t === 'Active' || t === '活跃') {
              (el.closest('button') || el.parentElement).click(); return true;
            }
          }
          for (const btn of document.querySelectorAll('button')) {
            const t = btn.textContent.trim();
            if (t === 'Active' || t === '活跃') { btn.click(); return true; }
          }
          return false;
        },
      }).catch(() => [{ result: false }]);

      if (activeRes[0]?.result) {
        notifyPopup({ type: 'log', msg: '  ✓ 已点击 Active 过滤', logType: 'ok' });
      } else {
        notifyPopup({ type: 'log', msg: '  ⚠ 未找到 Active 按钮，跳过', logType: 'info' });
      }
      await sleep(3000);
    }

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
      await sleep(4500);
    } else if (!activeOnly) {
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

    // 先启动下载监听，再点击 Excel（避免竞态：点击后下载可能立即触发 onCreated）
    const dlPromise = waitForXlsDownload(25000, 60000);

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
      notifyPopup({ type: 'log', msg: '  ✓ 已点击 Excel，等待下载完成...', logType: 'ok' });
      const dlResult = await dlPromise;
      if (dlResult.ok) {
        doneCount++;
        notifyPopup({ type: 'log', msg: '  ✓ 下载完成', logType: 'ok' });
      } else if (dlResult.reason === 'no_download_started') {
        notifyPopup({ type: 'log', msg: '  ✗ 25s 内未检测到下载，跳过', logType: 'err' });
      } else {
        notifyPopup({ type: 'log', msg: `  ✗ 下载失败: ${dlResult.reason}`, logType: 'err' });
      }
    } else {
      notifyPopup({ type: 'log', msg: '  ✗ 未找到 Excel 选项（下拉未出现？）', logType: 'err' });
      // dlPromise 会在 25s 后自动超时，无需处理
    }

    chrome.storage.local.set({ batchState: { running: true, domains, current: i + 1, done: doneCount, total: domains.length } });

    if (i < domains.length - 1 && !batchStop) await sleep(2000);
  }

  notifyPopup({ type: 'done', doneCount, total: domains.length, analysisData });
  chrome.storage.local.set({
    batchState: { running: false, domains, current: domains.length, done: doneCount, total: domains.length },
    pendingAnalysis: analysisData,   // popup 关着时存起来，打开后自动触发
  });
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

function waitForTabLoad(tabId, timeout = 30000) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(true); // true = 超时
    }, timeout);
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(false); // false = 正常加载
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 等待下载启动并完成（不过滤文件名，初始 filename 可能为空）
function waitForXlsDownload(startTimeout = 25000, completeTimeout = 120000) {
  return new Promise(resolve => {
    let downloadId = null;
    let startTimer = null;
    let completeTimer = null;

    function cleanup() {
      chrome.downloads.onCreated.removeListener(onCreated);
      chrome.downloads.onChanged.removeListener(onChanged);
      if (startTimer)    clearTimeout(startTimer);
      if (completeTimer) clearTimeout(completeTimer);
    }

    startTimer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: 'no_download_started' });
    }, startTimeout);

    function onCreated(item) {
      // 接受任何新下载（filename 初始可能为空，不做文件名过滤）
      clearTimeout(startTimer);
      downloadId = item.id;
      completeTimer = setTimeout(() => {
        cleanup();
        resolve({ ok: false, reason: 'download_timeout' });
      }, completeTimeout);
    }

    function onChanged(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'complete') {
        cleanup();
        resolve({ ok: true });
      } else if (delta.state?.current === 'interrupted') {
        cleanup();
        resolve({ ok: false, reason: 'interrupted' });
      }
    }

    chrome.downloads.onCreated.addListener(onCreated);
    chrome.downloads.onChanged.addListener(onChanged);
  });
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

// ══════════════════════════════════════════════════════════════════════════════
// AI 自动提交
// ══════════════════════════════════════════════════════════════════════════════

let aiRunning = false;
let aiStop = false;

const SYSTEM_ANALYZE = `你是外链提交专家。目标是在各类平台上提交/发布内容，为网站获取外链。分析网页HTML，结合网站资料，返回JSON操作指令。
返回纯JSON（不加markdown代码块）：
{"page_stage":"landing|auth_gate|login|submit_form|comment_form|review_form|other","form_type":"wp_comment|forum_reply|product_submit|directory_submit|review|profile|other","site_url":"从资料中选最合适的落地页URL","navigate_to":null,"fields":[{"selector":"CSS选择器","value":"填写内容","method":"fill|pressSequentially|select|click|radio|checkbox"}],"submit_selector":"提交按钮CSS选择器","has_captcha":false,"requires_login":false,"skip_reason":null}

决策优先级：
1. 优先产品提交 / 工具收录 / 发布文章 / 创建帖子 / 评测页
2. 评论区是最后兜底
3. 只有在站点没有更高价值的发布入口时，才允许返回 wp_comment 或 forum_reply
4. 如果页面同时存在评论框和更高价值入口（如 Create Post / New Post / Write Post / Submit Product / Add Product / List Your Product / Get Listed），必须跳去更高价值入口，不能停留在评论框

平台识别规则：
【Product Hunt / 产品提交平台】
- 目标：提交产品到 Product Hunt，获得产品页外链
- navigate_to 填 https://www.producthunt.com/posts/new
- 提交表单字段：产品名(input[name=name]或#name)、标语(input[name=tagline]或#tagline，60字以内英文)、描述(textarea[name=description]或#description，200字以内)、网站URL(input[name=website]或#website 填site_url)
- 所有字段 method 用 pressSequentially（React受控组件）
- form_type: "product_submit"

【目录站 / 工具收录站（alternativeto/g2/capterra/toolify等）】
- 目标：提交产品收录，获得目录页外链
- 找"Submit a tool"/"Add product"/"List your product"/"Submit"按钮
- form_type: "directory_submit"

【评测/评论平台（g2/capterra/trustpilot等）】
- 目标：写产品评测，评测页会有网站链接
- 找"Write a review"表单
- form_type: "review"

【社区/内容发布平台（DEV/Hashnode/Medium/Substack/Ghost/论坛发帖页等）】
- 如果存在 Create Post / New Post / Write Post / Publish / Editor / Share your story / Submit post 之类入口，优先发帖或发布内容
- 可以把这类流程归入 form_type: "product_submit" 或 "directory_submit"
- 标题、摘要、正文、URL、标签等字段按页面实际表单填写
- 只有确认没有发帖/发布入口时，才退回评论区

【博客/论坛评论】
- 找评论框，填name/email/website/comment
- website字段填site_url
- comment写100-150字自然英文，不放URL
- form_type: "wp_comment"或"forum_reply"

通用规则：
- site_url：从资料URL列表选最匹配的落地页
- 当前页无表单但有可操作子页时：navigate_to填子页URL，fields填空数组
- 检测到cleantalk/jetpack时skip_reason填原因；隐藏字段不填
- 检测到antispam-bee时comment字段method用pressSequentially
- 找不到任何可操作入口时，skip_reason填"无可用入口"
- 严格遵守资料中的"禁止乱写的内容"和"AI写作指令"
- 最终可提交步骤必须尽量返回 submit_selector，方便代码自动提交
- 如果当前页面只有低价值评论表单，但页面顶部/导航存在更高价值发布入口，navigate_to 应该指向更高价值入口

多步流程字段（重要）：
- pre_clicks：填表前先点击的元素数组（如radio选项），不触发页面跳转
- auto_click：填完后自动点击的按钮选择器（用于中间步骤如"Get started"/"Continue"/"Next"）
- wait_ms：auto_click后等待毫秒（默认2000）
- done：true=最终步骤等用户提交；false=还有下一步代码自动继续

Product Hunt多步规则：
- /posts/new 只有URL输入框 → fields=[URL框填site_url]，auto_click="button[type=submit]"，done=false
- /posts/new 出现"Is this a major update?" → pre_clicks=["input[type=radio]:first-of-type"]，auto_click="button[type=submit]"，done=false，fields=[]
- /posts/new 完整表单(有name/tagline/description) → 所有字段pressSequentially，done=true`;

// 随机生成真实感英文名
function randomName() {
  const first = ['James','John','Robert','Michael','William','David','Richard','Joseph','Thomas','Charles','Emma','Olivia','Ava','Isabella','Sophia','Mia','Charlotte','Amelia','Harper','Evelyn'];
  const last  = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Taylor','Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Moore','Young','Allen'];
  return first[Math.floor(Math.random()*first.length)] + ' ' + last[Math.floor(Math.random()*last.length)];
}

// 随机生成 Gmail plus-addressing 邮箱
function randomEmail(name) {
  const base = name.toLowerCase().replace(/\s+/, '.').replace(/[^a-z.]/g, '');
  const num  = Math.floor(Math.random() * 9000) + 1000;
  return `${base}+${num}@gmail.com`;
}

const AUTH_TEXT_RE = /(log[\s-]?in|sign[\s-]?in|sign[\s-]?up|register|create account|create an account|join|my account|continue with|google account|登录|登入|注册|账号|账户)/i;
const SUBMIT_ENTRY_TEXT_RE = /(submit|add tool|add product|list your product|list product|get listed|launch|write a review|leave a review|review this|submit your tool|submit your product|submit your site|add listing|claim listing|comment|reply|leave a reply|post your product|share your startup|directory|listing|create post|new post|write post|publish|editor|share your story|submit post|create article|new article)/i;
const IRRELEVANT_ACTION_RE = /(privacy|terms|policy|cookie|help|docs?|documentation|pricing|about|contact|learn more|read more|logout|log out|forgot password|reset password)/i;

function intentPriority(intent = '') {
  if (intent === 'product') return 5;
  if (intent === 'directory') return 4;
  if (intent === 'review') return 3;
  if (intent === 'generic') return 2;
  if (intent === 'comment') return 1;
  return 0;
}

function classifyActionIntent(candidate) {
  const text = `${candidate?.text || ''} ${candidate?.href || ''}`.toLowerCase();
  if (/add product|submit product|submit tool|submit your product|submit your tool|list your product|list product|get listed|launch|post your product|share your startup|add listing|claim listing|directory/.test(text)) {
    return 'product';
  }
  if (/create post|new post|write post|publish|editor|share your story|submit post|create article|new article/.test(text)) {
    return 'product';
  }
  if (/write a review|leave a review|review this|review/.test(text)) {
    return 'review';
  }
  if (/comment|reply|leave a reply|add comment/.test(text)) {
    return 'comment';
  }
  if (candidate?.kind === 'submit') return 'generic';
  if (candidate?.kind === 'auth') return 'auth';
  return 'other';
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function hostFromUrl(raw) {
  try {
    return new URL(raw).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeUrl(raw, base) {
  if (!raw) return null;
  try {
    return new URL(raw, base).toString();
  } catch {
    return null;
  }
}

const DEFAULT_LOCAL_BRIDGE_URL = 'http://127.0.0.1:8765';
const FILE_LIKE_EXTENSIONS = new Set(['xlsx', 'xls', 'csv', 'tsv', 'txt', 'json', 'xml', 'pdf', 'doc', 'docx']);

function looksLikeFilename(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || /^https?:\/\//i.test(value)) return false;
  const basename = value.split(/[\\/]/).pop() || value;
  const ext = basename.split('.').pop() || '';
  return FILE_LIKE_EXTENSIONS.has(ext);
}

function normalizeNavigableDomain(raw) {
  if (!raw) return null;
  let value = String(raw).trim().replace(/^\uFEFF/, '').replace(/^"|"$/g, '');
  if (!value) return null;
  if (/^mailto:/i.test(value) || value.includes('@')) return null;
  if (looksLikeFilename(value)) return null;

  try {
    if (/^https?:\/\//i.test(value)) {
      value = new URL(value).hostname;
    }
  } catch {
    return null;
  }

  value = value
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, '')
    .trim()
    .toLowerCase();

  if (!value || value.length > 253) return null;
  if (!/^[a-z0-9.-]+$/.test(value)) return null;
  if (!value.includes('.') || value.includes('..')) return null;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) return null;

  const labels = value.split('.');
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,63}$/.test(tld)) return null;
  if (labels.some(label => !label || label.startsWith('-') || label.endsWith('-') || label.length > 63)) return null;

  return value;
}

function sanitizeDomainsForNavigation(domains = []) {
  const seen = new Set();
  const sanitized = [];
  for (const raw of domains) {
    const domain = normalizeNavigableDomain(raw);
    if (!domain || seen.has(domain)) continue;
    seen.add(domain);
    sanitized.push(domain);
  }
  return sanitized;
}

function isLoginPage(signals, instructions, skipReason = '') {
  const reason = `${skipReason || ''} ${instructions?.page_stage || ''}`.toLowerCase();
  const aiSuggestsLogin = !!(
    instructions?.requires_login === true ||
    /login|sign.?in|register|account|登录|注册|账号/.test(reason)
  );

  if (signals?.hasLoggedInUi || signals?.hasLogoutAction) {
    if (!signals?.hasPasswordForm) return false;
    if (signals?.hasActionableForm) return false;
  }

  if (signals?.hasActionableForm && !signals?.hasPasswordForm && signals?.pageStage !== 'auth_gate') {
    return false;
  }

  return !!(
    signals?.hasPasswordForm ||
    signals?.pageStage === 'login' ||
    (signals?.pageStage === 'auth_gate' && !signals?.hasLoggedInUi) ||
    (aiSuggestsLogin && !signals?.hasLoggedInUi && !signals?.hasActionableForm)
  );
}

function hasActionableForm(signals) {
  return !!signals?.hasActionableForm;
}

function hasLoginCredentials(config) {
  return !!(config?.loginEmail && config?.loginPassword);
}

function scoreActionCandidate(candidate, currentUrl) {
  const text = `${candidate.text || ''} ${candidate.href || ''}`.toLowerCase();
  const intent = candidate.intent || classifyActionIntent(candidate);
  let score = candidate.kind === 'submit' ? 80 : 30;
  if (SUBMIT_ENTRY_TEXT_RE.test(text)) score += 25;
  if (AUTH_TEXT_RE.test(text)) score += 10;
  if (intent === 'product') score += 55;
  if (intent === 'review') score += 28;
  if (intent === 'comment') score += 6;
  if (/submit|add|list|launch|claim|directory/.test(text)) score += 12;
  if (/log[\s-]?in|sign[\s-]?in|continue with/.test(text)) score += 40;
  if (/create account|sign[\s-]?up|register|join/.test(text)) score += 12;
  if (/create post|new post|write post|publish|editor/.test(text)) score += 35;
  if (/product|tool|startup|website|site/.test(text)) score += 8;
  if (IRRELEVANT_ACTION_RE.test(text)) score -= 120;
  if (candidate.href && hostFromUrl(candidate.href) === hostFromUrl(currentUrl)) score += 6;
  return score;
}

function pickBestActionCandidate(signals) {
  const candidates = (signals?.actionCandidates || [])
    .filter(c => c && (c.kind === 'submit' || c.kind === 'auth'))
    .map(c => ({ ...c, intent: c.intent || classifyActionIntent(c), score: scoreActionCandidate(c, signals.url) }))
    .sort((a, b) => b.score - a.score);

  return candidates[0] || null;
}

function shouldPreferHigherValueEntry(signals) {
  if (!hasActionableForm(signals)) return false;
  const currentIntent = signals?.primaryFormIntent || 'generic';
  const bestCandidate = pickBestActionCandidate(signals);
  if (!bestCandidate || bestCandidate.kind !== 'submit') return false;
  return intentPriority(bestCandidate.intent) > intentPriority(currentIntent);
}

async function openActionCandidate(tabId, candidate) {
  if (!candidate) return false;

  if (candidate.href && /^https?:/i.test(candidate.href)) {
    await chrome.tabs.update(tabId, { url: candidate.href, active: true });
    return true;
  }

  const clickRes = await chrome.scripting.executeScript({
    target: { tabId },
    func: (cand) => {
      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const clickable = Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]'));
      const target = clickable.find(el => {
        const text = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
        const href = el.tagName === 'A' ? el.href : null;
        if (cand.href && href === cand.href) return true;
        if (cand.text && text === cand.textNormalized) return true;
        return false;
      });

      if (target) {
        target.click();
        return true;
      }

      if (cand.selector) {
        const bySelector = document.querySelector(cand.selector);
        if (bySelector) {
          bySelector.click();
          return true;
        }
      }

      return false;
    },
    args: [{
      text: candidate.text || '',
      textNormalized: (candidate.text || '').replace(/\s+/g, ' ').trim().toLowerCase(),
      href: candidate.href || null,
      selector: candidate.selector || null,
    }],
  }).catch(() => [{ result: false }]);

  return !!clickRes[0]?.result;
}

async function extractPageSignals(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const AUTH_RE = /(log[\s-]?in|sign[\s-]?in|sign[\s-]?up|register|create account|join|my account|continue with|google account|登录|注册|账号|账户)/i;
      const SUBMIT_RE = /(submit|add tool|add product|list your product|list product|get listed|launch|write a review|leave a review|review this|submit your tool|submit your product|submit your site|add listing|claim listing|comment|reply|leave a reply|post your product|share your startup|directory|listing|create post|new post|write post|publish|editor|share your story|submit post|create article|new article)/i;
      const NOISE_RE = /(privacy|terms|policy|cookie|help|docs?|documentation|pricing|about|contact|learn more|read more|logout|log out|forgot password|reset password)/i;
      const LOGOUT_RE = /(logout|log out|sign out|退出登录|登出)/i;
      const LOGGED_IN_RE = /(profile|my profile|dashboard|settings|notifications|new post|create post|write post|editor|publish|compose|account settings|我的主页|个人中心|设置|通知|发布)/i;
      const SEARCH_RE = /(search|algolia|query|keyword|find)/i;
      const NEWSLETTER_RE = /(newsletter|subscribe|subscription|weekly|updates|email list)/i;
      const ACTIONABLE_FIELD_RE = /(comment|review|reply|message|description|details|content|body|bio|website|url|link|title|name|product|tool|company|startup|listing|directory|headline|tagline)/i;
      const AUTH_FIELD_RE = /(login|sign[\s-]?in|register|sign[\s-]?up|password|username|account|email address)/i;
      const PRODUCT_TEXT_RE = /(product|tool|startup|website|listing|directory|launch|submit|publish|post|article|story|editor|tagline|headline|company|app)/i;
      const COMMENT_TEXT_RE = /(comment|reply|discussion|message|leave a reply|top comments)/i;
      const REVIEW_TEXT_RE = /(review|rating|stars?|feedback|testimonial)/i;

      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
      };

      const cssEscape = (value) => {
        if (window.CSS?.escape) return window.CSS.escape(value);
        return String(value).replace(/["\\#.:>+~*^$|=,[\\]()]/g, '\\$&');
      };
      const isHeaderNavElement = (el) => !!el?.closest('header, nav, [role="navigation"], [class*="header"], [class*="nav"], [id*="header"], [id*="nav"], .topbar, .navbar');

      const getSelector = (el) => {
        if (!el) return null;
        if (el.id) return `#${cssEscape(el.id)}`;
        const tag = el.tagName.toLowerCase();
        const name = el.getAttribute('name');
        const type = el.getAttribute('type');
        if (name) return `${tag}[name="${String(name).replace(/"/g, '\\"')}"]`;
        if (type) return `${tag}[type="${String(type).replace(/"/g, '\\"')}"]`;
        if (el.getAttribute('data-testid')) return `${tag}[data-testid="${String(el.getAttribute('data-testid')).replace(/"/g, '\\"')}"]`;
        return tag;
      };

      const getFieldLabel = (el) => {
        const aria = el.getAttribute('aria-label');
        if (aria) return normalize(aria);
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return normalize(placeholder);
        const label = el.id ? document.querySelector(`label[for="${cssEscape(el.id)}"]`) : null;
        if (label) return normalize(label.textContent);
        const wrap = el.closest('label');
        if (wrap) return normalize(wrap.textContent);
        return '';
      };

      const forms = Array.from(document.querySelectorAll('form')).map(form => {
        const fields = Array.from(form.querySelectorAll('input, textarea, select')).map(el => ({
          selector: getSelector(el),
          tag: el.tagName.toLowerCase(),
          type: (el.getAttribute('type') || el.tagName || '').toLowerCase(),
          name: el.getAttribute('name') || '',
          label: getFieldLabel(el),
          required: el.required || el.getAttribute('aria-required') === 'true',
        }));
        const normalizedFields = fields.map(field => {
          const text = `${field.name} ${field.label} ${field.type}`.toLowerCase();
          const isVisibleField = !['hidden', 'submit', 'button', 'reset', 'image'].includes(field.type);
          const isSearchField = field.type === 'search' || SEARCH_RE.test(text);
          const isAuthField = field.type === 'password' || AUTH_FIELD_RE.test(text);
          const isUrlField = field.type === 'url' || /website|url|link/.test(text);
          const isContentField = field.tag === 'textarea' || /comment|review|reply|description|message|content|details|bio/.test(text);
          const isTitleField = /title|name|product|tool|company|startup|headline|tagline/.test(text);
          return {
            ...field,
            text,
            isVisibleField,
            isSearchField,
            isAuthField,
            isUrlField,
            isContentField,
            isTitleField,
          };
        });
        const visibleFields = normalizedFields.filter(field => field.isVisibleField);
        const textishFields = visibleFields.filter(field =>
          ['text', 'email', 'url', 'tel', 'search', 'number', 'textarea', 'select', ''].includes(field.type) ||
          field.tag === 'textarea' || field.tag === 'select'
        );
        const formText = normalize(form.innerText || form.textContent || '').toLowerCase();
        const formContext = `${formText} ${form.getAttribute('action') || ''} ${form.getAttribute('method') || ''}`.trim();
        const searchLike = SEARCH_RE.test(formContext) || (visibleFields.length > 0 && visibleFields.every(field => field.isSearchField));
        const authLike = normalizedFields.some(field => field.isAuthField) || AUTH_RE.test(formContext);
        const newsletterLike =
          NEWSLETTER_RE.test(formContext) ||
          (visibleFields.length <= 2 && visibleFields.some(field => field.type === 'email') && !normalizedFields.some(field => field.isUrlField || field.isContentField));
        const hasUrlField = normalizedFields.some(field => field.isUrlField);
        const hasContentField = normalizedFields.some(field => field.isContentField);
        const hasTitleField = normalizedFields.some(field => field.isTitleField);
        const commentLike =
          COMMENT_TEXT_RE.test(formContext) ||
          (
            hasContentField &&
            normalizedFields.some(field => /comment|reply|message/.test(field.text)) &&
            normalizedFields.some(field => /name|email|website|url/.test(field.text))
          );
        const reviewLike =
          REVIEW_TEXT_RE.test(formContext) ||
          normalizedFields.some(field => /rating|stars?|review/.test(field.text));
        const publishLike =
          /create post|new post|write post|publish|editor|story|article|draft/.test(formContext) ||
          (hasTitleField && hasContentField && !commentLike);
        const productLike =
          (hasUrlField && (hasTitleField || PRODUCT_TEXT_RE.test(formContext))) ||
          (publishLike && PRODUCT_TEXT_RE.test(formContext));
        const actionableFieldCount = normalizedFields.filter(field =>
          field.isVisibleField && (field.isUrlField || field.isContentField || field.isTitleField || ACTIONABLE_FIELD_RE.test(field.text))
        ).length;
        const actionable =
          !authLike &&
          !searchLike &&
          !newsletterLike &&
          (
            productLike ||
            publishLike ||
            reviewLike ||
            commentLike ||
            (visibleFields.length >= 3 && actionableFieldCount >= 2)
          );
        const intent = reviewLike
          ? 'review'
          : (productLike || publishLike)
            ? 'product'
            : commentLike
              ? 'comment'
              : actionable
                ? 'generic'
                : 'other';
        return {
          selector: getSelector(form),
          action: form.getAttribute('action') || '',
          method: (form.getAttribute('method') || 'get').toLowerCase(),
          fieldCount: fields.length,
          hasPassword: fields.some(f => f.type === 'password'),
          hasTextarea: fields.some(f => f.tag === 'textarea'),
          hasFileInput: fields.some(f => f.type === 'file'),
          searchLike,
          authLike,
          newsletterLike,
          actionable,
          intent,
          fields: fields.slice(0, 16),
          html: form.outerHTML.slice(0, 4000),
        };
      }).slice(0, 8);

      const actionCandidates = [];
      const seen = new Set();
      const clickables = Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]'));
      const loggedInIndicators = new Set();
      for (const el of clickables) {
        if (!isVisible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
        const href = el.tagName === 'A'
          ? (() => { try { return new URL(el.getAttribute('href') || el.href, location.href).toString(); } catch { return null; } })()
          : null;
        const haystack = `${text} ${href || ''}`.toLowerCase();
        if (LOGOUT_RE.test(haystack)) loggedInIndicators.add('logout');
        if (isHeaderNavElement(el) && LOGGED_IN_RE.test(haystack) && !AUTH_RE.test(haystack)) loggedInIndicators.add('nav-account');
        if (isHeaderNavElement(el) && /\/dashboard|\/settings|\/notifications|\/new|\/editor|\/me\b|\/profile/i.test(href || '')) {
          loggedInIndicators.add('nav-href');
        }
      }

      for (const img of Array.from(document.querySelectorAll('header img, nav img, [role="navigation"] img, .topbar img, .navbar img'))) {
        if (!isVisible(img)) continue;
        const meta = normalize([
          img.alt,
          img.getAttribute('aria-label'),
          img.className,
          img.getAttribute('data-testid'),
          img.src,
        ].join(' ')).toLowerCase();
        if (/avatar|profile|user|account/.test(meta)) loggedInIndicators.add('avatar');
      }

      for (const el of Array.from(document.querySelectorAll('a[href], button, [role="button"], input[type="submit"], input[type="button"]'))) {
        if (!isVisible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
        if (!text || text.length > 120) continue;
        const href = el.tagName === 'A'
          ? (() => { try { return new URL(el.getAttribute('href') || el.href, location.href).toString(); } catch { return null; } })()
          : null;
        const haystack = `${text} ${href || ''}`.toLowerCase();
        if (NOISE_RE.test(haystack)) continue;
        let kind = null;
        if (SUBMIT_RE.test(haystack)) kind = 'submit';
        else if (AUTH_RE.test(haystack)) kind = 'auth';
        if (!kind) continue;
        const key = `${kind}::${text}::${href || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const intent =
          /add product|submit product|submit tool|submit your product|submit your tool|list your product|list product|get listed|launch|post your product|share your startup|add listing|claim listing|directory|create post|new post|write post|publish|editor|share your story|submit post|create article|new article/.test(haystack)
            ? 'product'
            : /write a review|leave a review|review this|review/.test(haystack)
              ? 'review'
              : /comment|reply|leave a reply|add comment/.test(haystack)
                ? 'comment'
                : kind;
        actionCandidates.push({
          kind,
          intent,
          text,
          href,
          selector: getSelector(el),
          tag: el.tagName.toLowerCase(),
        });
      }

      const hasPasswordForm = forms.some(form => form.hasPassword) || !!document.querySelector('input[type="password"]');
      const actionableForms = forms
        .filter(form => form.actionable)
        .sort((a, b) => {
          const score = (intent) => intent === 'product' ? 4 : intent === 'review' ? 3 : intent === 'generic' ? 2 : intent === 'comment' ? 1 : 0;
          return score(b.intent) - score(a.intent);
        });
      const hasActionableForm = actionableForms.length > 0;
      const textLower = document.body.innerText.toLowerCase();
      const htmlLower = document.documentElement.outerHTML.toLowerCase();
      const hasCaptcha = /(captcha|recaptcha|hcaptcha|turnstile)/i.test(textLower) || /(captcha|recaptcha|hcaptcha|turnstile)/i.test(htmlLower);
      const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(el => normalize(el.textContent)).filter(Boolean).slice(0, 10);
      const submitCandidateCount = actionCandidates.filter(item => item.kind === 'submit').length;
      const authCandidateCount = actionCandidates.filter(item => item.kind === 'auth').length;
      const hasLogoutAction = loggedInIndicators.has('logout');
      const hasLoggedInUi = hasLogoutAction || loggedInIndicators.size > 0;

      let pageStage = 'unknown';
      if (hasPasswordForm) pageStage = 'login';
      else if (authCandidateCount > 0 && !hasActionableForm && submitCandidateCount === 0 && !hasLoggedInUi) pageStage = 'auth_gate';
      else if (hasActionableForm) pageStage = 'form';
      else if (submitCandidateCount > 0) pageStage = 'entry';
      else if (authCandidateCount > 0 && !hasLoggedInUi) pageStage = 'auth_gate';

      const snippetParts = [
        `<title>${document.title}</title>`,
        headings.map(text => `<h>${text}</h>`).join('\n'),
        forms.map(form => form.html).join('\n\n'),
        actionCandidates.slice(0, 12).map(item => `ACTION ${item.kind}: ${item.text} ${item.href || ''}`).join('\n'),
        document.body.innerText.slice(0, 3000),
      ].filter(Boolean);

      return {
        url: location.href,
        title: document.title,
        pageStage,
        hasPasswordForm,
        hasActionableForm,
        actionableFormCount: actionableForms.length,
        primaryFormIntent: actionableForms[0]?.intent || 'other',
        submitCandidateCount,
        authCandidateCount,
        hasLoggedInUi,
        hasLogoutAction,
        loggedInIndicators: [...loggedInIndicators],
        hasCaptcha,
        headings,
        forms,
        actionCandidates: actionCandidates.slice(0, 20),
        htmlSnippet: snippetParts.join('\n\n').slice(0, 18000),
      };
    },
  }).catch(() => [{ result: null }]);

  return res[0]?.result || null;
}

function buildAnalyzePrompt(config, name, email, signals) {
  const safeSignals = {
    url: signals?.url || '',
    title: signals?.title || '',
    pageStage: signals?.pageStage || 'unknown',
    hasPasswordForm: !!signals?.hasPasswordForm,
    hasActionableForm: !!signals?.hasActionableForm,
    actionableFormCount: signals?.actionableFormCount || 0,
    primaryFormIntent: signals?.primaryFormIntent || 'other',
    submitCandidateCount: signals?.submitCandidateCount || 0,
    authCandidateCount: signals?.authCandidateCount || 0,
    hasLoggedInUi: !!signals?.hasLoggedInUi,
    hasLogoutAction: !!signals?.hasLogoutAction,
    loggedInIndicators: signals?.loggedInIndicators || [],
    hasCaptcha: !!signals?.hasCaptcha,
    headings: signals?.headings || [],
    forms: (signals?.forms || []).map(form => ({
      selector: form.selector,
      action: form.action,
      method: form.method,
      fieldCount: form.fieldCount,
      hasPassword: form.hasPassword,
      hasTextarea: form.hasTextarea,
      hasFileInput: form.hasFileInput,
      fields: form.fields,
    })),
    actionCandidates: signals?.actionCandidates || [],
  };

  return `评论者信息：名字=${name} 邮箱=${email}\n\n网站资料：\n${config.brief}\n\n页面信号(JSON)：\n${JSON.stringify(safeSignals, null, 2)}\n\n页面片段HTML：\n${signals?.htmlSnippet || ''}`;
}

function parseAIInstructions(raw) {
  if (!raw) throw new Error('AI 返回为空');
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI 返回格式错误');
  }
}

async function analyzeSignalsWithAI(config, aiConfig, signals) {
  const name = config.author || randomName();
  const email = randomEmail(name);
  const raw = await callAI(aiConfig, SYSTEM_ANALYZE, buildAnalyzePrompt(config, name, email, signals));
  return parseAIInstructions(raw);
}

async function autoAdvanceToActionablePage(tabId, signals, onLog) {
  let current = signals;
  const visited = new Set([signals?.url || '']);

  for (let hop = 0; hop < 3; hop++) {
    if (!current) return current;
    if (current.hasPasswordForm) return current;
    if (hasActionableForm(current) && !shouldPreferHigherValueEntry(current)) return current;

    const candidate = pickBestActionCandidate(current);
    if (!candidate) return current;

    onLog?.(`  → 自动识别入口：${candidate.text || candidate.href || candidate.selector}`, 'info');
    const moved = await openActionCandidate(tabId, candidate);
    if (!moved) return current;

    const timedOut = await waitForTabLoad(tabId, 20000);
    await sleep(900);
    current = await extractPageSignals(tabId);

    if (!current) return signals;
    if (timedOut) return current;
    if (visited.has(current.url)) return current;
    visited.add(current.url);
  }

  return current;
}

function notifyAiProgress(data) {
  chrome.runtime.sendMessage({ action: 'aiSubmitProgress', ...data }).catch(() => {});
}

function normalizeAiConfig(aiConfig = {}) {
  const hasCustomConfig = !!(aiConfig.url || aiConfig.key);
  const mode = aiConfig.mode === 'custom' || aiConfig.mode === 'local-codex' || aiConfig.mode === 'local-claude'
    ? aiConfig.mode
    : hasCustomConfig
      ? 'custom'
      : (aiConfig.provider === 'claude' ? 'local-claude' : 'local-codex');
  const provider = aiConfig.provider || (mode === 'local-claude' ? 'claude' : 'codex');
  return {
    mode,
    provider,
    bridgeUrl: String(aiConfig.bridgeUrl || DEFAULT_LOCAL_BRIDGE_URL).trim() || DEFAULT_LOCAL_BRIDGE_URL,
    url: String(aiConfig.url || '').trim(),
    key: String(aiConfig.key || '').trim(),
    model: String(aiConfig.model || '').trim(),
  };
}

function buildLocalBridgeEndpoint(raw) {
  let base = String(raw || DEFAULT_LOCAL_BRIDGE_URL).trim() || DEFAULT_LOCAL_BRIDGE_URL;
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  base = base.replace(/\/$/, '');
  if (base.endsWith('/v1/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function readChatMessageContent(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('\n')
      .trim();
  }
  return '';
}

async function callOpenAiCompatible(aiConfig, systemPrompt, userPrompt) {
  const url = aiConfig.url.replace(/\/$/, '') + '/chat/completions';
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${aiConfig.key}`
    },
    body: JSON.stringify({
      model: aiConfig.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt }
      ],
      temperature: 0.2,
      max_tokens: 800
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 120)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const body = await resp.text();
    throw new Error(`返回非JSON（${ct || 'unknown'}）— URL 可能填错了。内容: ${body.slice(0, 80)}`);
  }
  const data = await resp.json();
  const text = readChatMessageContent(data?.choices?.[0]?.message?.content);
  if (!text) throw new Error('AI 返回为空');
  return text;
}

async function callLocalBridge(aiConfig, systemPrompt, userPrompt) {
  const url = buildLocalBridgeEndpoint(aiConfig.bridgeUrl);
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: aiConfig.provider,
      model: aiConfig.model || undefined,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    })
  });
  if (!resp.ok) {
    const body = await resp.text();
    let message = body;
    try {
      const data = JSON.parse(body);
      message = data?.error || body;
    } catch {}
    throw new Error(`本机桥接失败 ${resp.status}: ${String(message || '').slice(0, 160)}`);
  }
  const ct = resp.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const body = await resp.text();
    throw new Error(`本机桥接返回非JSON（${ct || 'unknown'}）: ${body.slice(0, 120)}`);
  }
  const data = await resp.json();
  const text = readChatMessageContent(data?.choices?.[0]?.message?.content);
  if (!text) throw new Error('本机桥接返回为空');
  return text;
}

async function callAI(aiConfig, systemPrompt, userPrompt) {
  const normalized = normalizeAiConfig(aiConfig);
  if (normalized.mode === 'custom') {
    return callOpenAiCompatible(normalized, systemPrompt, userPrompt);
  }
  return callLocalBridge(normalized, systemPrompt, userPrompt);
}

// 注入到目标页面：根据 AI 指令填表并提交
function fillFormFromInstructions(instructions) {
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

  function setReactValue(el, text) {
    el.focus();
    const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeSetter;
    if (setter) setter.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input',  { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function simulateTyping(el, text) {
    el.focus();
    const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeSetter;
    if (setter) setter.call(el, ''); else el.value = '';
    for (const char of text) {
      const cur = el.value;
      if (setter) setter.call(el, cur + char); else el.value = cur + char;
      el.dispatchEvent(new KeyboardEvent('keydown',  { bubbles: true, key: char }));
      el.dispatchEvent(new KeyboardEvent('keypress', { bubbles: true, key: char }));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup',    { bubbles: true, key: char }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  try {
    for (const field of (instructions.fields || [])) {
      const el = document.querySelector(field.selector);
      if (!el) continue;
      if (field.method === 'pressSequentially') {
        simulateTyping(el, field.value);
      } else {
        setReactValue(el, field.value);
      }
    }

    const submitEl = document.querySelector(instructions.submit_selector || '[type=submit]');
    if (submitEl) submitEl.click();

    return new Promise(resolve => {
      setTimeout(() => {
        try {
          const siteUrl = instructions.site_url || '';
          if (siteUrl) {
            const host = new URL(siteUrl).hostname;
            const links = document.querySelectorAll(`a[href*="${host}"]`);
            if (links.length > 0) {
              const rel = links[0].rel?.toLowerCase() || '';
              const linkType = (rel.includes('nofollow') || rel.includes('ugc')) ? 'nofollow' : 'dofollow';
              resolve({ success: true, linkType });
              return;
            }
          }
          resolve({ success: true, linkType: 'pending' });
        } catch (e) {
          resolve({ success: true, linkType: 'pending' });
        }
      }, 3000);
    });
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function aiSubmitLoop(domains, config, aiConfig) {
  aiRunning = true;
  aiStop = false;
  let done = 0;
  let skipped = 0;
  let failed = 0;

  // 创建一个固定复用的标签页
  const workerTab = await chrome.tabs.create({ url: 'about:blank', active: false });
  notifyAiProgress({ type: 'log', msg: `开始处理 ${domains.length} 个域名（复用 tab #${workerTab.id}）`, logType: 'info' });

  for (let i = 0; i < domains.length; i++) {
    if (aiStop) {
      notifyAiProgress({ type: 'log', msg: '已停止', logType: 'info' });
      break;
    }

    const domain = domains[i];
    const url = `https://${domain}`;
    const name  = config.author || randomName();
    const email = randomEmail(name);

    notifyAiProgress({ type: 'log', msg: `[${i+1}/${domains.length}] ${domain}`, logType: 'info' });

    try {
      notifyAiProgress({ type: 'log', msg: `  → 加载页面...`, logType: 'info' });
      await chrome.tabs.update(workerTab.id, { url });
      const timedOut = await waitForTabLoad(workerTab.id, 30000);
      if (timedOut) {
        notifyAiProgress({ type: 'log', msg: `  ✗ 加载超时(30s)，跳过`, logType: 'err' });
        skipped++;
        continue;
      }
      await sleep(800);

      notifyAiProgress({ type: 'log', msg: `  → 提取表单HTML...`, logType: 'info' });
      const htmlRes = await chrome.scripting.executeScript({
        target: { tabId: workerTab.id },
        func: () => new Promise(resolve => {
          window.scrollTo(0, document.body.scrollHeight);
          setTimeout(() => {
            const parts = [];
            parts.push(`<title>${document.title}</title>`);
            const desc = document.querySelector('meta[name="description"]');
            if (desc) parts.push(desc.outerHTML);
            for (const form of document.querySelectorAll('form')) {
              parts.push(form.outerHTML.slice(0, 5000));
            }
            for (const sel of ['#comments','#respond','.comments-area','.comment-section','.comment-form','[id*="comment"]','[class*="comment"]']) {
              const el = document.querySelector(sel);
              if (el) { parts.push(el.outerHTML.slice(0, 4000)); break; }
            }
            const combined = parts.join('\n\n');
            resolve(combined.slice(0, 18000) || document.documentElement.outerHTML.slice(0, 12000));
          }, 1800);
        })
      });
      const html = htmlRes[0]?.result || '';
      const formCount = (html.match(/<form/gi) || []).length;
      notifyAiProgress({ type: 'log', msg: `  → 已提取 ${html.length} 字符，发现 ${formCount} 个表单，AI分析中...`, logType: 'info' });

      const userPrompt = `评论者信息：名字=${name} 邮箱=${email}\n\n网站资料：\n${config.brief}\n\n页面HTML：\n${html}`;
      const raw = await callAI(aiConfig, SYSTEM_ANALYZE, userPrompt);

      let instructions;
      try {
        instructions = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) instructions = JSON.parse(match[0]);
        else throw new Error('AI 返回格式错误');
      }

      if (instructions.skip_reason) {
        notifyAiProgress({ type: 'log', msg: `  ⊘ 跳过: ${instructions.skip_reason}`, logType: 'info' });
        skipped++;
        continue;
      }

      const fieldCount = instructions.fields?.length || 0;
      notifyAiProgress({ type: 'log', msg: `  → 表单类型: ${instructions.form_type}，${fieldCount} 个字段，填写提交...`, logType: 'info' });

      const fillRes = await chrome.scripting.executeScript({
        target: { tabId: workerTab.id },
        func: fillFormFromInstructions,
        args: [instructions]
      });

      const result = fillRes[0]?.result || { success: false, error: '脚本执行失败' };
      if (result.success) {
        done++;
        notifyAiProgress({ type: 'log', msg: `  ✓ 提交成功 (${result.linkType}) — ${name} / ${email}`, logType: 'ok' });
      } else {
        failed++;
        notifyAiProgress({ type: 'log', msg: `  ✗ 填表失败: ${result.error}`, logType: 'err' });
      }

    } catch (e) {
      failed++;
      notifyAiProgress({ type: 'log', msg: `  ✗ 错误: ${e.message}`, logType: 'err' });
    }

    if (i < domains.length - 1 && !aiStop) await sleep(2000);
  }

  chrome.tabs.remove(workerTab.id).catch(() => {});
  notifyAiProgress({ type: 'done', done, total: domains.length,
    msg: `完成！成功 ${done} / 跳过 ${skipped} / 失败 ${failed}，共 ${domains.length} 个` });
  aiRunning = false;
  aiStop = false;
}

// ══════════════════════════════════════════════════════════════════════════════
// CSV 辅助提交（AI填表，用户手动提交，悬浮按钮控制节奏）
// ══════════════════════════════════════════════════════════════════════════════

let csvRunning = false;
let csvStop = false;
let csvNextResolve = null;

function notifyCsv(data) {
  chrome.runtime.sendMessage({ action: 'csvSubmitProgress', ...data }).catch(() => {});
}

// 注入悬浮按钮到页面
function injectFloatingBtn(tabId, status, index, total, filled, actionLabel = '点击 → 下一个域名') {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (status, index, total, filled, actionLabel) => {
      document.getElementById('__wl_float_btn')?.remove();
      const div = document.createElement('div');
      div.id = '__wl_float_btn';
      div.style.cssText = [
        'position:fixed', 'bottom:24px', 'right:24px', 'z-index:2147483647',
        'background:' + (filled ? '#059669' : '#4f46e5'),
        'color:#fff', 'padding:12px 18px', 'border-radius:14px',
        'cursor:pointer', 'font-size:13px', 'font-weight:700',
        'box-shadow:0 4px 24px rgba(0,0,0,.25)',
        'font-family:-apple-system,sans-serif',
        'max-width:260px', 'line-height:1.5', 'user-select:none',
      ].join(';');
      div.innerHTML =
        `<div style="font-size:10px;opacity:.7;margin-bottom:3px">[${index}/${total}] 外链助手</div>` +
        `<div>${status}</div>` +
        `<div style="font-size:11px;margin-top:4px;opacity:.8">${actionLabel}</div>`;
      div.onclick = () => {
        div.style.background = '#374151';
        div.innerHTML = '<div style="padding:4px 0">⏳ 跳转中...</div>';
        chrome.runtime.sendMessage({ action: 'csvNextDomain' });
      };
      document.body.appendChild(div);
    },
    args: [status, index, total, filled, actionLabel],
  }).catch(() => {});
}

// 通用填表脚本（React nativeInputValueSetter 兼容）
async function execFillScript(tabId, instr) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (instr) => {
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      const nativeSelectSetter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set;
      function setReactValue(el, text) {
        el.focus();
        const setter =
          el.tagName === 'TEXTAREA'
            ? nativeTextareaSetter
            : el.tagName === 'SELECT'
              ? nativeSelectSetter
              : nativeSetter;
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      function simulateTyping(el, text) {
        el.focus();
        const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeSetter;
        if (setter) setter.call(el, ''); else el.value = '';
        for (const char of text) {
          const cur = el.value;
          if (setter) setter.call(el, cur + char); else el.value = cur + char;
          el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: char }));
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent('keyup',   { bubbles: true, key: char }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // pre_clicks：先点击radio/checkbox等不触发跳转的元素
      for (const sel of (instr.pre_clicks || [])) {
        const el = document.querySelector(sel);
        if (el) el.click();
      }
      // 填写字段
      for (const field of (instr.fields || [])) {
        const el = document.querySelector(field.selector);
        if (!el) continue;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        if (field.method === 'radio' || field.method === 'checkbox') {
          el.click();
        } else if (field.method === 'select' && el.tagName === 'SELECT') {
          setReactValue(el, field.value);
        } else if (field.method === 'click') {
          el.click();
        } else if (field.method === 'pressSequentially') {
          simulateTyping(el, field.value);
        } else {
          setReactValue(el, field.value);
        }
      }
    },
    args: [instr],
  }).catch(() => {});
}

async function attemptSubmitForm(tabId, instructions) {
  const trigger = await chrome.scripting.executeScript({
    target: { tabId },
    func: (instr) => {
      const selector = instr.submit_selector || 'button[type="submit"], input[type="submit"]';
      const submitEl = document.querySelector(selector);
      if (!submitEl) return { clicked: false, reason: '未找到提交按钮', beforeUrl: location.href };
      const label = (submitEl.innerText || submitEl.textContent || submitEl.value || submitEl.getAttribute('aria-label') || '').trim();
      submitEl.scrollIntoView({ block: 'center', inline: 'center' });
      submitEl.click();
      return { clicked: true, label, beforeUrl: location.href };
    },
    args: [instructions],
  }).catch(() => [{ result: { clicked: false, reason: '提交脚本执行失败', beforeUrl: '' } }]);

  const triggerResult = trigger[0]?.result || { clicked: false, reason: '提交脚本执行失败', beforeUrl: '' };
  if (!triggerResult.clicked) {
    return { ok: false, manual: true, reason: triggerResult.reason || '未点击提交按钮' };
  }

  await waitForTabLoad(tabId, 12000);
  await sleep(1500);

  const afterSignals = await extractPageSignals(tabId);
  const check = await chrome.scripting.executeScript({
    target: { tabId },
    func: (beforeUrl) => {
      const body = (document.body?.innerText || '').toLowerCase();
      const successPatterns = [
        /thank you/i, /thanks for/i, /success/i, /submitted/i, /published/i,
        /pending review/i, /awaiting approval/i, /saved/i, /draft saved/i,
        /your comment is awaiting moderation/i, /comment submitted/i,
      ];
      const errorPatterns = [
        /required/i, /this field is required/i, /please fill/i, /invalid/i,
        /captcha/i, /recaptcha/i, /hcaptcha/i, /turnstile/i,
        /already associated/i, /already exists/i, /already been submitted/i,
        /already listed/i, /duplicate/i, /error/i, /failed/i,
      ];
      const successText = successPatterns.find(pattern => pattern.test(body));
      const errorText = errorPatterns.find(pattern => pattern.test(body));
      return {
        afterUrl: location.href,
        urlChanged: location.href !== beforeUrl,
        successText: successText ? successText.toString() : null,
        errorText: errorText ? errorText.toString() : null,
      };
    },
    args: [triggerResult.beforeUrl],
  }).catch(() => [{ result: { afterUrl: '', urlChanged: false, successText: null, errorText: null } }]);

  const status = check[0]?.result || {};
  if (status.errorText) {
    return { ok: false, manual: true, reason: `提交后页面提示错误: ${status.errorText}`, signals: afterSignals };
  }
  if (afterSignals?.hasCaptcha || instructions?.has_captcha) {
    return { ok: false, manual: true, reason: '检测到验证码，需要人工处理', signals: afterSignals };
  }
  if (status.urlChanged || status.successText || !hasActionableForm(afterSignals)) {
    return {
      ok: true,
      manual: false,
      reason: status.successText ? `自动提交成功: ${status.successText}` : '自动提交完成',
      signals: afterSignals,
    };
  }

  return { ok: false, manual: true, reason: '自动提交结果不明确，保留人工确认', signals: afterSignals };
}

async function tryAutoLoginStep(tabId, config) {
  const result = await chrome.scripting.executeScript({
    target: { tabId },
    func: (credentials) => {
      const normalize = (text) => (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const isVisible = (el) => {
        if (!el) return false;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
      };
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      const setReactValue = (el, text) => {
        const setter = el.tagName === 'TEXTAREA' ? nativeTextareaSetter : nativeSetter;
        el.focus();
        if (setter) setter.call(el, text); else el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Tab' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Tab' }));
      };
      const fillIfNeeded = (el, text) => {
        if (!el || !text) return false;
        if ((el.value || '').trim() === text.trim()) return false;
        setReactValue(el, text);
        return true;
      };
      const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(isVisible);
      const emailInput = inputs.find(el => {
        const meta = normalize([
          el.type,
          el.name,
          el.id,
          el.placeholder,
          el.getAttribute('aria-label'),
          el.autocomplete,
        ].join(' '));
        return el.tagName === 'INPUT' && (
          el.type === 'email' ||
          /email|e-mail|user|username|login|identifier|account/.test(meta)
        );
      }) || null;
      const passwordInput = inputs.find(el => el.tagName === 'INPUT' && el.type === 'password') || null;
      const scopeForm = passwordInput?.form || emailInput?.form || null;
      const clickables = Array.from((scopeForm || document).querySelectorAll('button, input[type="submit"], a[href], [role="button"]')).filter(isVisible);
      const pickButton = (...patterns) => clickables.find(el => {
        const text = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || '');
        return patterns.some(pattern => pattern.test(text));
      }) || null;
      let changed = false;
      let stage = 'unknown';

      if (emailInput) {
        changed = fillIfNeeded(emailInput, credentials.loginEmail) || changed;
        stage = passwordInput ? 'email_password' : 'email_only';
      }
      if (passwordInput) {
        changed = fillIfNeeded(passwordInput, credentials.loginPassword) || changed;
        stage = emailInput ? 'email_password' : 'password_only';
      }

      let clicked = false;
      const loginButton = pickButton(
        /log[\s-]?in|sign[\s-]?in|continue|next|submit|登录|继续|下一步|验证/i,
        /create account|register|sign[\s-]?up|join/i
      );
      if (loginButton) {
        loginButton.click();
        clicked = true;
      } else if (scopeForm?.requestSubmit) {
        scopeForm.requestSubmit();
        clicked = true;
      } else if (scopeForm) {
        scopeForm.submit();
        clicked = true;
      }

      return {
        stage,
        hasEmailInput: !!emailInput,
        hasPasswordInput: !!passwordInput,
        changed,
        clicked,
      };
    },
    args: [{
      loginEmail: config.loginEmail || '',
      loginPassword: config.loginPassword || '',
    }],
  }).catch(() => [{ result: null }]);

  return result[0]?.result || null;
}

async function tryAutoLogin(tabId, config, logStep) {
  if (!hasLoginCredentials(config)) {
    return { attempted: false, success: false, reason: '未配置登录凭据', signals: null };
  }

  let attempted = false;
  for (let round = 0; round < 4; round++) {
    const signals = await extractPageSignals(tabId);
    if (!signals) {
      return { attempted, success: false, reason: '页面状态提取失败', signals: null };
    }
    if (!isLoginPage(signals, null, '')) {
      return { attempted, success: true, reason: '已退出登录页', signals };
    }

    const step = await tryAutoLoginStep(tabId, config);
    if (!step || (!step.changed && !step.clicked)) {
      return { attempted, success: false, reason: '未识别到可自动填写的登录表单', signals };
    }

    attempted = true;
    logStep(`  → 自动登录: ${step.stage}${step.clicked ? '，已提交' : ''}`, 'info');
    await waitForTabLoad(tabId, 20000);
    await sleep(900);
  }

  const signals = await extractPageSignals(tabId);
  return {
    attempted,
    success: !!(signals && !isLoginPage(signals, null, '')),
    reason: '自动登录后仍停留在登录流程',
    signals,
  };
}

async function csvSubmitLoop(domains, config, aiConfig) {
  csvRunning = true;
  csvStop = false;

  const sanitizedDomains = sanitizeDomainsForNavigation(domains);
  if (sanitizedDomains.length < domains.length) {
    notifyCsv({ type: 'log', msg: `已丢弃 ${domains.length - sanitizedDomains.length} 个非法域名，剩余 ${sanitizedDomains.length} 个`, logType: 'info' });
  }
  domains = sanitizedDomains;

  // 过滤掉不应该提交外链的平台域名
  const SKIP_DOMAINS = /^(producthunt\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com|reddit\.com|pinterest\.com|snapchat\.com|whatsapp\.com|telegram\.org|discord\.com|github\.com|google\.|bing\.com|yahoo\.com|baidu\.com|amazon\.com|apple\.com|microsoft\.com|cloudflare\.com|wordpress\.com|shopify\.com|medium\.com|substack\.com|quora\.com|stackoverflow\.com)$/i;
  const filtered = domains.filter(d => !SKIP_DOMAINS.test(d.replace(/^https?:\/\//, '').split('/')[0]));
  if (filtered.length < domains.length) {
    notifyCsv({ type: 'log', msg: `过滤掉 ${domains.length - filtered.length} 个平台域名，剩余 ${filtered.length} 个`, logType: 'info' });
  }
  domains = filtered;
  if (!domains.length) {
    notifyCsv({ type: 'done', total: 0, msg: '没有可处理的域名' });
    csvRunning = false;
    return;
  }

  let workerTab;
  try {
    workerTab = await chrome.tabs.create({ url: 'about:blank', active: true });
  } catch (e) {
    notifyCsv({ type: 'done', total: 0, msg: `✗ 无法创建标签页: ${e.message}` });
    csvRunning = false;
    return;
  }
  notifyCsv({ type: 'log', msg: `开始处理 ${domains.length} 个域名，tab #${workerTab.id}`, logType: 'info' });

  for (let i = 0; i < domains.length; i++) {
    if (csvStop) { notifyCsv({ type: 'log', msg: '已停止', logType: 'info' }); break; }

    const domain = domains[i];
    const url = /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
    const logStep = (msg, logType = 'info') => notifyCsv({ type: 'log', msg, logType });
    notifyCsv({ type: 'log', msg: `[${i+1}/${domains.length}] ${domain}`, logType: 'info' });

    // 导航
    try {
      await chrome.tabs.update(workerTab.id, { url, active: true });
    } catch (e) {
      notifyCsv({ type: 'log', msg: `  ✗ 无法导航: ${e.message}`, logType: 'err' });
      continue;
    }

    const timedOut = await waitForTabLoad(workerTab.id, 30000);
    if (timedOut) {
      notifyCsv({ type: 'log', msg: `  ✗ 加载超时(30s)`, logType: 'err' });
      continue;
    }
    await sleep(700);

    let signals = await extractPageSignals(workerTab.id);
    if (!signals) {
      logStep('  ✗ 页面信号提取失败，自动跳过', 'err');
      continue;
    }

    logStep(`  → 页面阶段: ${signals.pageStage}${signals.hasCaptcha ? ' / captcha' : ''}`, 'info');
    if (signals.primaryFormIntent && signals.primaryFormIntent !== 'other') {
      logStep(`  → 当前表单意图: ${signals.primaryFormIntent}`, 'info');
    }
    if (signals.hasLoggedInUi) {
      logStep(`  → 已登录态信号: ${(signals.loggedInIndicators || []).join(', ') || 'detected'}`, 'info');
    }
    signals = await autoAdvanceToActionablePage(workerTab.id, signals, logStep);
    logStep(`  → 自动跳转后阶段: ${signals?.pageStage || 'unknown'}`, 'info');

    if (!signals) {
      logStep('  ✗ 页面状态丢失，自动跳过', 'err');
      continue;
    }

    let instructions = null;
    let skipReason = null;
    let needsLogin = false;

    if (isLoginPage(signals, null, '')) {
      needsLogin = true;
    } else if (!hasActionableForm(signals) && !signals.submitCandidateCount) {
      logStep('  ⊘ 未发现可提交入口，自动跳过', 'info');
      continue;
    }

    const analyzeCurrentSignals = async () => {
      instructions = await analyzeSignalsWithAI(config, aiConfig, signals);
      skipReason = instructions?.skip_reason || null;
      needsLogin = isLoginPage(signals, instructions, skipReason);
    };

    if (!needsLogin) {
      logStep('  → AI 分析页面结构...', 'info');
      try {
        await analyzeCurrentSignals();
      } catch (e) {
        logStep(`  ✗ AI分析失败: ${e.message}`, 'err');
        skipReason = 'AI分析失败';
      }
    }

    if (instructions?.navigate_to && !instructions.skip_reason) {
      const subUrl = normalizeUrl(instructions.navigate_to, signals.url);
      if (subUrl) {
        logStep(`  → 跳转子页: ${subUrl}`, 'info');
        await chrome.tabs.update(workerTab.id, { url: subUrl, active: true });
        const subTimedOut = await waitForTabLoad(workerTab.id, 30000);
        if (subTimedOut) {
          logStep('  ✗ 子页加载超时', 'err');
          continue;
        }
        await sleep(900);
        signals = await extractPageSignals(workerTab.id);
        signals = await autoAdvanceToActionablePage(workerTab.id, signals, logStep);
        if (isLoginPage(signals, null, '')) {
          needsLogin = true;
        } else if (!hasActionableForm(signals) && !signals?.submitCandidateCount) {
          logStep('  ⊘ 子页没有可提交入口，自动跳过', 'info');
          continue;
        } else {
          try {
            await analyzeCurrentSignals();
          } catch (e) {
            logStep(`  ✗ 子页AI分析失败: ${e.message}`, 'err');
            skipReason = 'AI子页分析失败';
          }
        }
      }
    }

    if (needsLogin) {
      const autoLogin = await tryAutoLogin(workerTab.id, config, logStep);
      if (autoLogin.success) {
        logStep('  ✓ 自动登录完成，继续识别提交入口', 'ok');
        signals = autoLogin.signals || await extractPageSignals(workerTab.id);
        needsLogin = false;
      } else {
        if (autoLogin.attempted) {
          logStep(`  ⚠ 自动登录未完成: ${autoLogin.reason}`, 'info');
        }
        logStep('  ⚠ 检测到登录页，等待你登录后继续', 'info');
        await injectFloatingBtn(workerTab.id, '检测到登录页，请先登录', i+1, domains.length, false, '点击 → 检查登录状态');
        await waitForNext({
          tabId: workerTab.id,
          autoResumeLogin: true,
          loginPrompt: {
            status: '检测到登录页，请先登录',
            index: i + 1,
            total: domains.length,
            filled: false,
            actionLabel: '点击 → 检查登录状态',
          },
        });
        if (csvStop) break;

        signals = await extractPageSignals(workerTab.id);
        signals = await autoAdvanceToActionablePage(workerTab.id, signals, logStep);
        if (!signals) {
          logStep('  ✗ 登录后页面状态提取失败，自动跳过', 'err');
          continue;
        }
      }
      if (csvStop) break;

      if (!hasActionableForm(signals) && !signals.submitCandidateCount) {
        logStep('  ⊘ 登录后仍未发现提交入口，自动跳过', 'info');
        continue;
      }

      try {
        logStep('  → 登录后重新分析页面...', 'info');
        await analyzeCurrentSignals();
      } catch (e) {
        logStep(`  ✗ 登录后分析失败: ${e.message}`, 'err');
        skipReason = '登录后分析失败';
      }

      if (isLoginPage(signals, instructions, skipReason)) {
        skipReason = '登录后仍停留在登录页';
        needsLogin = true;
      }
    }

    if (skipReason && !hasActionableForm(signals) && !needsLogin) {
      logStep(`  ⊘ 跳过: ${skipReason}，自动下一个`, 'info');
      continue;
    }

    if (needsLogin) {
      await injectFloatingBtn(workerTab.id, '仍在登录页，请完成登录', i+1, domains.length, false, '点击 → 检查登录状态');
      await waitForNext({
        tabId: workerTab.id,
        autoResumeLogin: true,
        loginPrompt: {
          status: '仍在登录页，请完成登录',
          index: i + 1,
          total: domains.length,
          filled: false,
          actionLabel: '点击 → 检查登录状态',
        },
      });
      if (csvStop) break;
      i -= 1;
      continue;
    }

    if (instructions && !instructions.skip_reason) {
      let stepInstr = instructions;
      let stepNum = 0;
      const MAX_STEPS = 6;
      let autoSkipped = false;

      while (stepInstr && !stepInstr.skip_reason && stepNum < MAX_STEPS) {
        stepNum++;
        for (const f of (stepInstr.fields || [])) {
          if (f.value) f.value = f.value.replace(/^(https?:\/\/){2,}/, 'https://');
        }

        const fieldCount = stepInstr.fields?.length || 0;
        const hasAutoClick = !!stepInstr.auto_click;
        logStep(`  ✓ 步骤${stepNum}: ${stepInstr.form_type}，${fieldCount}个字段${hasAutoClick ? '，自动继续' : ''}`, 'ok');

        await execFillScript(workerTab.id, stepInstr);

        if (stepInstr.done === false && hasAutoClick) {
          await chrome.scripting.executeScript({
            target: { tabId: workerTab.id },
            func: (selector) => {
              const el = document.querySelector(selector);
              if (el) el.click();
            },
            args: [stepInstr.auto_click],
          }).catch(() => {});

          await sleep(stepInstr.wait_ms || 2000);
          await waitForTabLoad(workerTab.id, 15000);
          await sleep(800);

          signals = await extractPageSignals(workerTab.id);
          if (isLoginPage(signals, null, '')) {
            const autoLogin = await tryAutoLogin(workerTab.id, config, logStep);
            if (!autoLogin.success) {
              logStep('  ⚠ 中间步骤进入登录页，等你登录后继续', 'info');
              await injectFloatingBtn(workerTab.id, '中间步骤进入登录页，请先登录', i+1, domains.length, false, '点击 → 检查登录状态');
              await waitForNext({
                tabId: workerTab.id,
                autoResumeLogin: true,
                loginPrompt: {
                  status: '中间步骤进入登录页，请先登录',
                  index: i + 1,
                  total: domains.length,
                  filled: false,
                  actionLabel: '点击 → 检查登录状态',
                },
              });
            } else {
              logStep('  ✓ 中间步骤自动登录完成', 'ok');
            }
            if (csvStop) break;
            signals = await extractPageSignals(workerTab.id);
          }

          const errCheck = await chrome.scripting.executeScript({
            target: { tabId: workerTab.id },
            func: () => {
              const body = document.body?.innerText || '';
              const errPatterns = [
                /already associated/i, /already exists/i, /already been submitted/i,
                /already listed/i, /duplicate/i, /this url is already/i,
                /product already/i, /reach out to us/i,
              ];
              for (const pattern of errPatterns) {
                if (pattern.test(body)) return body.slice(0, 200);
              }
              return null;
            },
          }).catch(() => [{ result: null }]);

          const errText = errCheck[0]?.result;
          if (errText) {
            logStep(`  ⊘ 页面报错，自动跳过: ${errText.slice(0, 80)}`, 'info');
            autoSkipped = true;
            break;
          }

          try {
            stepInstr = await analyzeSignalsWithAI(config, aiConfig, signals);
          } catch (e) {
            logStep(`  ✗ 步骤${stepNum + 1}分析失败: ${e.message}`, 'err');
            break;
          }
        } else {
          break;
        }
      }

      if (autoSkipped) continue;
      const shouldAutoSubmit = true;
      if (!signals?.hasCaptcha && !instructions?.has_captcha && shouldAutoSubmit) {
        logStep('  → 尝试自动提交最终表单...', 'info');
        const submitResult = await attemptSubmitForm(workerTab.id, stepInstr || instructions);
        if (submitResult.ok) {
          logStep(`  ✓ ${submitResult.reason}`, 'ok');
          continue;
        }
        logStep(`  ⚠ ${submitResult.reason}`, 'info');
      }

      const filledLabel = signals?.hasCaptcha || instructions?.has_captcha
        ? '已填写表单，如有验证码请先处理，提交后点击下一步 →'
        : '已填写表单，请检查后提交，完成后点击下一步 →';
      await injectFloatingBtn(workerTab.id, filledLabel, i+1, domains.length, true, '点击 → 提交完成，下一个域名');
    } else if (hasActionableForm(signals)) {
      logStep('  ⚠ 已识别到表单，当前等待你人工检查并提交', 'info');
      await injectFloatingBtn(workerTab.id, '已识别到表单，请检查后提交', i+1, domains.length, true, '点击 → 提交完成，下一个域名');
    } else {
      logStep('  ⊘ 未识别到入口，自动跳过', 'info');
      continue;
    }

    // 等待用户点击悬浮按钮
    await waitForNext();
  }

  chrome.tabs.remove(workerTab.id).catch(() => {});
  notifyCsv({ type: 'done', total: domains.length, msg: `完成！共处理 ${domains.length} 个域名` });
  csvRunning = false;
  csvStop = false;
}

function waitForNext(options = {}) {
  return new Promise(resolve => {
    let settled = false;
    let polling = false;
    let timer = null;
    let manualCheckRequested = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      csvNextResolve = null;
      resolve();
    };

    const runLoginCheck = async () => {
      if (settled || csvStop || polling || !options.tabId) return;
      polling = true;
      try {
        const signals = await extractPageSignals(options.tabId);
        if (signals && !isLoginPage(signals, null, '')) {
          finish();
        } else if (options.loginPrompt) {
          await injectFloatingBtn(
            options.tabId,
            options.loginPrompt.status,
            options.loginPrompt.index,
            options.loginPrompt.total,
            options.loginPrompt.filled,
            options.loginPrompt.actionLabel,
          );
        }
      } catch {}
      polling = false;
    };

    csvNextResolve = () => {
      if (options.autoResumeLogin) {
        manualCheckRequested = true;
        runLoginCheck();
        return;
      }
      finish();
    };

    if (options.autoResumeLogin && options.tabId) {
      timer = setInterval(async () => {
        if (manualCheckRequested) {
          manualCheckRequested = false;
        }
        await runLoginCheck();
      }, options.intervalMs || 2000);
    }
  });
}
