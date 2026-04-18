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
    sendResponse({ running: aiRunning });
    return;
  }

  if (msg.action === 'testAiConfig') {
    callAI(
      { url: msg.url, key: msg.key, model: msg.model },
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
{"form_type":"wp_comment|forum_reply|product_submit|directory_submit|review|profile|other","site_url":"从资料中选最合适的落地页URL","navigate_to":null,"fields":[{"selector":"CSS选择器","value":"填写内容","method":"fill|pressSequentially"}],"submit_selector":"提交按钮CSS选择器","has_captcha":false,"skip_reason":null}

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

function notifyAiProgress(data) {
  chrome.runtime.sendMessage({ action: 'aiSubmitProgress', ...data }).catch(() => {});
}

async function callAI(aiConfig, systemPrompt, userPrompt) {
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
  return data.choices[0].message.content.trim();
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
function injectFloatingBtn(tabId, status, index, total, filled) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (status, index, total, filled) => {
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
        `<div style="font-size:11px;margin-top:4px;opacity:.8">点击 → 下一个域名</div>`;
      div.onclick = () => {
        div.style.background = '#374151';
        div.innerHTML = '<div style="padding:4px 0">⏳ 跳转中...</div>';
        chrome.runtime.sendMessage({ action: 'csvNextDomain' });
      };
      document.body.appendChild(div);
    },
    args: [status, index, total, filled],
  }).catch(() => {});
}

// 通用填表脚本（React nativeInputValueSetter 兼容）
async function execFillScript(tabId, instr) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (instr) => {
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
        if (field.method === 'radio' || field.method === 'checkbox') {
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

async function csvSubmitLoop(domains, config, aiConfig) {
  csvRunning = true;
  csvStop = false;

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
    notifyCsv({ type: 'log', msg: `[${i+1}/${domains.length}] ${domain}`, logType: 'info' });

    // 导航
    try {
      await chrome.tabs.update(workerTab.id, { url, active: true });
    } catch (e) {
      notifyCsv({ type: 'log', msg: `  ✗ 无法导航: ${e.message}`, logType: 'err' });
      await injectFloatingBtn(workerTab.id, '导航失败，点击跳过', i+1, domains.length, false);
      await waitForNext();
      continue;
    }

    const timedOut = await waitForTabLoad(workerTab.id, 30000);
    if (timedOut) {
      notifyCsv({ type: 'log', msg: `  ✗ 加载超时(30s)`, logType: 'err' });
      await injectFloatingBtn(workerTab.id, '页面加载超时，点击跳过', i+1, domains.length, false);
      await waitForNext();
      continue;
    }
    await sleep(1500);

    // 提取页面 HTML
    notifyCsv({ type: 'log', msg: `  → 提取页面内容...`, logType: 'info' });
    const htmlRes = await chrome.scripting.executeScript({
      target: { tabId: workerTab.id },
      func: () => new Promise(resolve => {
        window.scrollTo(0, document.body.scrollHeight);
        setTimeout(() => {
          const parts = [`<title>${document.title}</title>`];
          const desc = document.querySelector('meta[name="description"]');
          if (desc) parts.push(desc.outerHTML);
          for (const form of document.querySelectorAll('form')) {
            parts.push(form.outerHTML.slice(0, 5000));
          }
          for (const sel of ['#comments','#respond','.comments-area','.comment-section','[id*="comment"]','[class*="comment"]']) {
            const el = document.querySelector(sel);
            if (el) { parts.push(el.outerHTML.slice(0, 4000)); break; }
          }
          resolve(parts.join('\n\n').slice(0, 16000));
        }, 1500);
      }),
    }).catch(() => [{ result: '' }]);
    const html = htmlRes[0]?.result || '';

    // AI 分析
    notifyCsv({ type: 'log', msg: `  → AI 分析中...`, logType: 'info' });
    let instructions = null;
    let skipReason = null;
    let needsLogin = false;

    try {
      const name  = config.author || randomName();
      const email = randomEmail(name);
      const userPrompt = `评论者信息：名字=${name} 邮箱=${email}\n\n网站资料：\n${config.brief}\n\n页面HTML：\n${html}`;
      const raw = await callAI(aiConfig, SYSTEM_ANALYZE, userPrompt);
      try { instructions = JSON.parse(raw); }
      catch { const m = raw.match(/\{[\s\S]*\}/); if (m) instructions = JSON.parse(m[0]); }

      if (instructions?.skip_reason) {
        skipReason = instructions.skip_reason;
        needsLogin = /login|sign.?in|登录|注册|account/i.test(skipReason);
      }
    } catch (e) {
      notifyCsv({ type: 'log', msg: `  ✗ AI分析失败: ${e.message}`, logType: 'err' });
      skipReason = 'AI分析失败';
    }

    // 如果AI建议跳转子页（如Product Hunt提交页、论坛帖子等）
    if (instructions?.navigate_to && !instructions.skip_reason) {
      const subUrl = instructions.navigate_to;
      notifyCsv({ type: 'log', msg: `  → 跳转子页: ${subUrl}`, logType: 'info' });
      await chrome.tabs.update(workerTab.id, { url: subUrl, active: true });
      const t2 = await waitForTabLoad(workerTab.id, 30000);
      if (t2) {
        notifyCsv({ type: 'log', msg: `  ✗ 子页加载超时`, logType: 'err' });
        await injectFloatingBtn(workerTab.id, '子页加载超时，点击跳过 →', i+1, domains.length, false);
        await waitForNext();
        continue;
      }
      await sleep(2000);
      // 重新提取子页HTML并分析
      const h2Res = await chrome.scripting.executeScript({
        target: { tabId: workerTab.id },
        func: () => new Promise(resolve => {
          window.scrollTo(0, document.body.scrollHeight);
          setTimeout(() => {
            const parts = [`<title>${document.title}</title>`];
            for (const form of document.querySelectorAll('form')) parts.push(form.outerHTML.slice(0, 5000));
            for (const sel of ['[class*="comment"]','[class*="reply"]','[class*="submit"]','[class*="form"]','textarea','input[type=text]']) {
              const el = document.querySelector(sel);
              if (el) { parts.push(el.closest('form,section,div')?.outerHTML?.slice(0,4000) || ''); break; }
            }
            resolve(parts.join('\n\n').slice(0, 16000));
          }, 2000);
        }),
      }).catch(() => [{ result: '' }]);
      const html2 = h2Res[0]?.result || '';
      notifyCsv({ type: 'log', msg: `  → 子页AI分析中...`, logType: 'info' });
      try {
        const name2 = config.author || randomName();
        const email2 = randomEmail(name2);
        const raw2 = await callAI(aiConfig, SYSTEM_ANALYZE,
          `评论者信息：名字=${name2} 邮箱=${email2}\n\n网站资料：\n${config.brief}\n\n页面HTML：\n${html2}`);
        try { instructions = JSON.parse(raw2); }
        catch { const m = raw2.match(/\{[\s\S]*\}/); if (m) instructions = JSON.parse(m[0]); }
        skipReason = instructions?.skip_reason || null;
        needsLogin = skipReason ? /login|sign.?in|登录|注册|account/i.test(skipReason) : false;
      } catch (e) {
        skipReason = 'AI子页分析失败';
      }
    }

    if (needsLogin) {
      notifyCsv({ type: 'log', msg: `  ⚠ 需要登录，等待你操作...`, logType: 'info' });
      await injectFloatingBtn(workerTab.id, '需要登录，请登录后点击继续 →', i+1, domains.length, false);
      await waitForNext();
      if (csvStop) break;
      // 登录后重新分析
      notifyCsv({ type: 'log', msg: `  → 登录后重新分析...`, logType: 'info' });
      const html2Res = await chrome.scripting.executeScript({
        target: { tabId: workerTab.id },
        func: () => new Promise(resolve => {
          window.scrollTo(0, document.body.scrollHeight);
          setTimeout(() => {
            const parts = [`<title>${document.title}</title>`];
            for (const form of document.querySelectorAll('form')) parts.push(form.outerHTML.slice(0, 5000));
            resolve(parts.join('\n\n').slice(0, 16000));
          }, 1500);
        }),
      }).catch(() => [{ result: '' }]);
      const html2 = html2Res[0]?.result || '';
      try {
        const name2  = config.author || randomName();
        const email2 = randomEmail(name2);
        const raw2 = await callAI(aiConfig, SYSTEM_ANALYZE,
          `评论者信息：名字=${name2} 邮箱=${email2}\n\n网站资料：\n${config.brief}\n\n页面HTML：\n${html2}`);
        try { instructions = JSON.parse(raw2); }
        catch { const m = raw2.match(/\{[\s\S]*\}/); if (m) instructions = JSON.parse(m[0]); }
        skipReason = instructions?.skip_reason || null;
      } catch (e) {
        skipReason = 'AI重新分析失败';
      }
    }

    if (skipReason && !needsLogin) {
      notifyCsv({ type: 'log', msg: `  ⊘ 跳过: ${skipReason}`, logType: 'info' });
      await injectFloatingBtn(workerTab.id, `跳过: ${skipReason}`, i+1, domains.length, false);
      await waitForNext();
      continue;
    }

    // 通用多步填表循环（最多6步，支持任意网站的多步流程）
    if (instructions && !instructions.skip_reason) {
      let stepInstr = instructions;
      let stepNum = 0;
      const MAX_STEPS = 6;

      while (stepInstr && !stepInstr.skip_reason && stepNum < MAX_STEPS) {
        stepNum++;
        // 净化 URL 双重协议
        for (const f of (stepInstr.fields || [])) {
          if (f.value) f.value = f.value.replace(/^(https?:\/\/){2,}/, 'https://');
        }
        const fc = stepInstr.fields?.length || 0;
        const hasAutoClick = !!stepInstr.auto_click;
        notifyCsv({ type: 'log', msg: `  ✓ 步骤${stepNum}: ${stepInstr.form_type}，${fc}个字段${hasAutoClick ? '，自动继续' : ''}`, logType: 'ok' });

        await execFillScript(workerTab.id, stepInstr);

        if (stepInstr.done === false && hasAutoClick) {
          // 自动点击继续按钮，进入下一步
          await chrome.scripting.executeScript({
            target: { tabId: workerTab.id },
            func: (sel) => { const el = document.querySelector(sel); if (el) el.click(); },
            args: [stepInstr.auto_click],
          }).catch(() => {});
          const waitMs = stepInstr.wait_ms || 2000;
          await sleep(waitMs);
          await waitForTabLoad(workerTab.id, 15000);
          await sleep(1500);
          // 重新提取页面并分析
          const hRes = await chrome.scripting.executeScript({
            target: { tabId: workerTab.id },
            func: () => {
              const parts = [`<title>${document.title}</title>`];
              for (const form of document.querySelectorAll('form')) parts.push(form.outerHTML.slice(0, 5000));
              for (const sel of ['[class*="submit"]','[class*="form"]','textarea','input[type=text]','input[type=url]']) {
                const el = document.querySelector(sel);
                if (el) { parts.push(el.closest('form,section,div')?.outerHTML?.slice(0,4000) || ''); break; }
              }
              return parts.join('\n\n').slice(0, 16000);
            },
          }).catch(() => [{ result: '' }]);
          const html = hRes[0]?.result || '';
          try {
            const n = config.author || randomName();
            const e = randomEmail(n);
            const raw = await callAI(aiConfig, SYSTEM_ANALYZE,
              `评论者信息：名字=${n} 邮箱=${e}\n\n网站资料：\n${config.brief}\n\n页面HTML：\n${html}`);
            try { stepInstr = JSON.parse(raw); }
            catch { const m = raw.match(/\{[\s\S]*\}/); if (m) stepInstr = JSON.parse(m[0]); else break; }
          } catch (e2) {
            notifyCsv({ type: 'log', msg: `  ✗ 步骤${stepNum+1}分析失败: ${e2.message}`, logType: 'err' });
            break;
          }
        } else {
          break; // done=true 或无 auto_click，等用户提交
        }
      }

      await injectFloatingBtn(workerTab.id, '已填写表单，请手动提交后点击下一步 →', i+1, domains.length, true);
    } else {
      await injectFloatingBtn(workerTab.id, '未找到表单，点击跳过 →', i+1, domains.length, false);
    }

    // 等待用户点击悬浮按钮
    await waitForNext();
  }

  chrome.tabs.remove(workerTab.id).catch(() => {});
  notifyCsv({ type: 'done', total: domains.length, msg: `完成！共处理 ${domains.length} 个域名` });
  csvRunning = false;
  csvStop = false;
}

function waitForNext() {
  return new Promise(resolve => { csvNextResolve = resolve; });
}
