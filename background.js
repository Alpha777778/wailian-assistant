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

const SYSTEM_ANALYZE = `你是外链提交专家。分析网页HTML片段，结合网站资料，返回JSON填表指令。
返回纯JSON（不加markdown代码块）：
{"form_type":"wp_comment|profile|forum|other","site_url":"从资料中选最合适的落地页URL","fields":[{"selector":"CSS选择器","value":"填写内容","method":"fill|pressSequentially"}],"submit_selector":"提交按钮CSS选择器","has_captcha":false,"skip_reason":null}
规则：
- site_url：根据页面主题从资料的URL列表中选最匹配的落地页（AI工具目录选/generate，cover-up相关选对应内页，通用选首页）
- url/website字段填site_url的值
- author/name字段填提供的名字
- email字段填提供的邮箱
- comment/content字段：根据页面文章主题 + 网站资料，写100-150字自然英文评论，不放URL，符合资料中的AI写作指令
- 检测到cleantalk/jetpack时skip_reason填原因
- 隐藏字段（蜜罐）不填
- 检测到antispam-bee时comment字段method用pressSequentially
- 找不到评论表单时skip_reason填"无评论表单"
- 严格遵守资料中的"禁止乱写的内容"和"AI写作指令"`;

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
  function simulateTyping(el, text) {
    el.focus();
    el.value = '';
    for (const char of text) {
      el.value += char;
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
        el.focus();
        el.value = field.value;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
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
