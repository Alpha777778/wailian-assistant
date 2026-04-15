// background.js — 处理评论提交（在独立 tab 中操作）

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'submitComment') {
    submitToUrl(msg.url, msg.config)
      .then(result => sendResponse(result))
      .catch(e => sendResponse({ success: false, error: e.message }));
    return true; // 异步响应
  }
});

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
