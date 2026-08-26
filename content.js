/**
 * 115 磁力分析助手 - 内容脚本
 *
 * 在任意网页注入右上角「分析」按钮：
 *  1. 点击后分析页面内所有磁力链接（提取名称 + 大小，按大小从大到小排序）
 *  2. 同时从网页内容中获取「以字母/数字开头的完整标题」（磁力链接文字 / dn /
 *     title 类元素 / 标题元素等，不使用 document.title），显示在弹框最上面
 *  3. 弹框按行展示，每条带「转存」按钮；无磁力链接时提示「无资源」
 *  4. 点击「转存」→ 后台使用 115 Cookie 调用 add_task_url；同时把页面最大图片
 *     下载到本地；转存成功后后台等待 115 下载完成，自动进入“云下载”目录把最大
 *     文件重命名为网页内容标题，进度通过 jobUpdate 消息气泡提示
 *
 * 所有 UI 都放在 Shadow DOM 中，避免被页面样式干扰。
 */
(() => {
  "use strict";
  if (window.__MAGNET115_INJECTED__) return;
  window.__MAGNET115_INJECTED__ = true;

  /* ================= 工具函数 ================= */

  /** 从 magnet 链接中提取参数（兼容无 ? 号或大小写差异） */
  function getParam(href, key) {
    try {
      const re = new RegExp("[?&]" + key + "=([^&#]+)", "i");
      const m = href.match(re);
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) {
      return null;
    }
  }

  /** 字节数格式化 */
  function formatBytes(bytes) {
    if (!isFinite(bytes) || bytes < 0) return "未知大小";
    if (bytes < 1024) return bytes + " B";
    const units = ["KB", "MB", "GB", "TB", "PB"];
    let v = bytes;
    let i = -1;
    do {
      v /= 1024;
      i++;
    } while (v >= 1024 && i < units.length - 1);
    return v.toFixed(2) + " " + units[i];
  }

  /** 把 "2.10 GB" 之类的文本解析成字节数；解析失败返回 -1 */
  function parseSizeBytes(text) {
    const m = String(text || "").match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!m) return -1;
    const n = parseFloat(m[1]);
    const mult = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824, TB: 1099511627776 }[m[2].toUpperCase()];
    return Math.round(n * mult);
  }

  /** 提取磁力链接对应的大小（优先 xl 参数，其次链接附近文本） */
  function extractSize(href, a) {
    const xl = getParam(href, "xl");
    if (xl && /^\d+$/.test(xl)) return formatBytes(parseInt(xl, 10));
    if (a.title) {
      const m = a.title.match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)(?:\/s)?/i);
      if (m) return m[1] + " " + m[2].toUpperCase();
    }
    let node = a;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const m = (node.textContent || "").match(/(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)(?:\/s)?/i);
      if (m) return m[1] + " " + m[2].toUpperCase();
    }
    return "未知大小";
  }

  /** 提取磁力链接名称（优先 dn 参数，其次链接文本） */
  function extractName(href, a) {
    const dn = getParam(href, "dn");
    if (dn) return dn;
    const text = (a.textContent || "").trim().replace(/\s+/g, " ");
    if (text) return text;
    return "未知名称";
  }

  /** 去重 key：优先按 BTIH 哈希，其次按完整链接 */
  function keyOf(href) {
    const xt = getParam(href, "xt") || "";
    const m = xt.match(/urn:btih:([a-zA-Z0-9]+)/i);
    if (m) return "btih:" + m[1].toLowerCase();
    return href;
  }

  /**
   * 站点专属标题候选（用户规范）：
   *  - javdb.com：<h2 class="title is-4"> 内含 <savdiv class="sav-id infoExistent">（番号）与
   *    <strong class="current-title">（影片标题），取 h2 完整文本 → "AKDLD-363 【...】若葉結希"
   *  - javbus.com：<h3> 内含 <savdiv class="sav-id infoFirst">（番号）+ 标题文字，
   *    取 h3 完整文本 → "START-607 おねだり...恋渕ももな"
   *  - 两者都只保留「以字母/数字开头」的内容（组合后以番号开头，自然满足）
   */
  function getSiteSpecificTitleCandidates() {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const out = [];
    // 找到 .current-title 或 .sav-id 元素，取其所在标题容器（h1~h6）的完整文本
    for (const sel of [".current-title", ".sav-id"]) {
      for (const el of document.querySelectorAll(sel)) {
        const container = el.closest("h1,h2,h3,h4,h5,h6") || el.parentElement;
        if (!container) continue;
        const t = clean(container.textContent);
        if (t && /^[A-Za-z0-9]/.test(t)) out.push(t);
      }
    }
    // 去重（保持顺序）
    return out.filter((t, i) => out.indexOf(t) === i);
  }

  /**
   * 站点专属图片地址（用户规范）：
   *  - javdb.com：div.video-meta-panel 内部的图片地址
   *  - javbus.com：a.bigImage 内部的图片地址，相对路径拼接在 https://www.javbus.com 之后
   * 兼容懒加载：img 的 data-src / data-original / data-lazy-src 等属性
   */
  function getSiteSpecificImageUrl() {
    const host = location.hostname.toLowerCase();
    const imgSrc = (img) =>
      (img &&
        (img.currentSrc ||
          img.src ||
          img.getAttribute("data-src") ||
          img.getAttribute("data-original") ||
          img.getAttribute("data-lazy-src"))) ||
      "";
    if (host === "javdb.com" || host.endsWith(".javdb.com")) {
      const panel = document.querySelector("div.video-meta-panel");
      if (panel) {
        const img = panel.querySelector("img");
        if (img) return imgSrc(img) || null;
      }
    }
    if (host === "javbus.com" || host.endsWith(".javbus.com")) {
      const a = document.querySelector("a.bigImage");
      if (a) {
        const img = a.querySelector("img");
        let src = imgSrc(img) || a.getAttribute("href") || "";
        if (!src) return null;
        if (/^\/\//.test(src)) src = "https:" + src;
        else if (/^\//.test(src)) src = "https://www.javbus.com" + src;
        return src;
      }
    }
    return null;
  }

  /** 从图片 URL 中提取扩展名（如 .jpg），没有则返回空串 */
  function getImageExtension(url) {
    try {
      const path = String(url || "").split(/[?#]/)[0];
      const m = path.match(/\.(jpe?g|png|gif|webp|bmp|svg|heic|dng)$/i);
      return m ? m[0] : "";
    } catch (e) {
      return "";
    }
  }

  /** 从图片 URL 取原始文件名（含扩展名），下载/上传时保持不重命名 */
  function getImageOriginalName(url) {
    try {
      const path = String(url || "").split(/[?#]/)[0];
      const name = decodeURIComponent(path.split("/").pop() || "");
      return name || "image.jpg";
    } catch (e) {
      return "image.jpg";
    }
  }

  /** 清理用于文件名的非法字符 */
  function sanitizeTitleForFile(name) {
    return (
      String(name || "")
        .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
        .replace(/\s+/g, " ")
        .replace(/^[. ]+|[. ]+$/g, "")
        .slice(0, 100) || "未命名"
    );
  }

  /**
   * 从网页内容中获取「以字母/数字开头的完整标题」（不使用 document.title）：
   * 按优先级收集候选文本——站点专属（h2.current-title / h3.sav-id.infoFirst）→
   * 磁力链接文字 / dn 参数 / title 类元素 / 标题元素 / 普通链接 / 文本块，
   * 过滤出以 [A-Za-z0-9] 开头、长度合适的“标题”，每类取最长的一个，按优先级返回。
   */
  function getContentTitle() {
    const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
    const isTitleLike = (t) => t.length >= 4 && t.length <= 300 && /^[A-Za-z0-9]/.test(t);
    const isShortTitleLike = (t) => t.length >= 3 && t.length <= 300 && /^[A-Za-z0-9]/.test(t);

    const siteTexts = getSiteSpecificTitleCandidates();
    const magnetTexts = [];
    const dnNames = [];
    const titleElTexts = [];
    const headingTexts = [];
    const linkTexts = [];
    const blockTexts = [];

    // 1) 磁力链接的文字（资源标题的最强候选）
    for (const a of document.querySelectorAll('a[href^="magnet:" i]')) {
      const t = clean(a.textContent);
      if (t) magnetTexts.push(t);
      const dn = getParam(a.getAttribute("href") || "", "dn");
      if (dn) dnNames.push(clean(dn));
    }
    // 2) title/name 类元素
    for (const el of document.querySelectorAll(
      '[id*="title" i], [class*="title" i], [itemprop="name"], [class*="subject" i], [class*="name" i]'
    )) {
      const t = clean(el.textContent);
      if (t) titleElTexts.push(t);
    }
    // 3) 标题元素
    for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6")) {
      const t = clean(el.textContent);
      if (t) headingTexts.push(t);
    }
    // 4) 普通链接文字
    for (const a of document.querySelectorAll("a")) {
      const t = clean(a.textContent);
      if (t) linkTexts.push(t);
    }
    // 5) 文本块
    for (const el of document.querySelectorAll("p, td, li, article, section")) {
      const t = clean(el.textContent);
      if (t) blockTexts.push(t);
    }

    const longest = (arr, filter) =>
      arr.filter(filter || isTitleLike).sort((a, b) => b.length - a.length)[0] || "";
    return (
      longest(siteTexts, isShortTitleLike) ||
      longest(magnetTexts) ||
      longest(dnNames) ||
      longest(titleElTexts) ||
      longest(headingTexts) ||
      longest(linkTexts) ||
      longest(blockTexts) ||
      ""
    );
  }

  /** 分析页面中所有磁力链接，并按大小从大到小排序（未知大小排最后） */
  function analyzePage() {
    const anchors = Array.from(document.querySelectorAll('a[href^="magnet:" i]'));
    const seen = new Set();
    const items = [];
    for (const a of anchors) {
      const href = (a.getAttribute("href") || "").trim();
      if (!href) continue;
      const key = keyOf(href);
      if (seen.has(key)) continue;
      seen.add(key);
      const sizeText = extractSize(href, a);
      const xl = getParam(href, "xl");
      items.push({
        url: href,
        name: extractName(href, a),
        size: sizeText,
        bytes: xl && /^\d+$/.test(xl) ? parseInt(xl, 10) : parseSizeBytes(sizeText),
      });
    }
    items.sort((a, b) => b.bytes - a.bytes); // 从大到小；未知(-1)沉底
    return items;
  }

  /** blob URL 转 data URL（blob 无法被后台直接下载） */
  function blobToDataUrl(blobUrl) {
    return new Promise((resolve) => {
      fetch(blobUrl)
        .then((r) => r.blob())
        .then(
          (blob) =>
            new Promise((res2) => {
              const fr = new FileReader();
              fr.onload = () => res2(fr.result);
              fr.onerror = () => res2(null);
              fr.readAsDataURL(blob);
            })
        )
        .then(resolve)
        .catch(() => resolve(null));
    });
  }

  /**
   * 找出页面最大的图片（按渲染尺寸宽×高，优先已加载完成的真实尺寸）
   * 返回 { url }；找不到返回 null
   */
  async function findLargestImage() {
    // 0) 站点专属图片地址（javdb / javbus）优先
    const specific = getSiteSpecificImageUrl();
    if (specific) return await normalizeImageUrl(specific);

    const imgs = Array.from(document.images || []);
    const byArea = (list) =>
      list
        .filter(Boolean)
        .map((img) => {
          const area = (img.naturalWidth || 0) * (img.naturalHeight || 0);
          const w = img.width || img.naturalWidth || 0;
          const hh = img.height || img.naturalHeight || 0;
          const attrArea = w * hh;
          const src = img.currentSrc || img.src || "";
          return { img, area, attrArea, src };
        })
        .sort((a, b) => b.area - a.area);

    // 1) 已加载完成的图片，按真实尺寸（自然尺寸）取最大
    const loaded = byArea(imgs.filter((i) => i.naturalWidth > 0 && i.naturalHeight > 0));
    if (loaded.length) {
      // 优先 http(s) 的真实图片
      const pick =
        loaded.find((x) => /^https?:/i.test(x.src)) ||
        loaded.find((x) => x.src) ||
        loaded[0];
      return await normalizeImageUrl(pick.src);
    }

    // 2) 未加载完成的：按 width/height 属性估算
    const byAttr = byArea(imgs).sort((a, b) => b.attrArea - a.attrArea);
    if (byAttr.length) {
      const pick = byAttr.find((x) => /^https?:/i.test(x.src)) || byAttr.find((x) => x.src) || byAttr[0];
      if (pick && pick.src) return await normalizeImageUrl(pick.src);
    }
    return null;
  }

  /** 把候选图片 URL 规范化：blob: 转 data:，空值返回 null */
  async function normalizeImageUrl(src) {
    if (!src) return null;
    if (/^blob:/i.test(src)) {
      const dataUrl = await blobToDataUrl(src);
      return dataUrl ? { url: dataUrl } : null;
    }
    if (/^(https?:|data:)/i.test(src)) return { url: src };
    return null;
  }

  /** chrome.runtime.sendMessage 的 Promise 封装（处理 lastError） */
  function sendMessage(msg) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(msg, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(resp);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  /** 简单 DOM 构建器：h("div", { class: "x", text: "内容" }, child...) */
  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else if (k === "title") node.title = v;
        else node.setAttribute(k, v);
      }
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  /* ================= 样式（Shadow DOM 内） ================= */
  const STYLE = `
    * { box-sizing: border-box; margin: 0; padding: 0; }

    .m115-fab {
      position: fixed; top: 16px; right: 16px; z-index: 2147483647;
      min-width: 76px; padding: 10px 20px;
      font: 600 14px/1 "PingFang SC","Microsoft YaHei",Arial,sans-serif;
      color: #fff; background: linear-gradient(135deg, #1677ff, #0958d9);
      border: none; border-radius: 22px;
      box-shadow: 0 4px 16px rgba(9, 88, 217, .45);
      cursor: pointer; user-select: none;
      transition: transform .15s ease, box-shadow .15s ease;
    }
    .m115-fab:hover { transform: translateY(-2px) scale(1.04); box-shadow: 0 6px 20px rgba(9,88,217,.55); }
    .m115-fab:active { transform: translateY(0) scale(.97); }

    .m115-mask {
      position: fixed; inset: 0; z-index: 2147483646;
      background: rgba(0, 0, 0, .45);
    }

    .m115-panel {
      position: fixed; top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483647;
      width: min(640px, calc(100vw - 32px));
      max-height: min(76vh, 600px);
      display: flex; flex-direction: column;
      background: #fff; color: #1f2329;
      border-radius: 14px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, .3);
      font: 13px/1.6 "PingFang SC","Microsoft YaHei",Arial,sans-serif;
      overflow: hidden;
    }

    .m115-header {
      display: flex; align-items: center; gap: 10px;
      padding: 13px 16px;
      border-bottom: 1px solid #eee;
      background: #f7f9fc;
    }
    .m115-title { font-size: 15px; font-weight: 700; flex: 0 0 auto; }
    .m115-count { color: #1677ff; font-weight: 600; font-size: 12px; }
    .m115-cookie { flex: 1; text-align: right; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .m115-cookie.ok { color: #389e0d; }
    .m115-cookie.bad { color: #cf1322; }
    .m115-close {
      flex: 0 0 auto; width: 26px; height: 26px;
      border: none; border-radius: 50%;
      background: #e5e6eb; color: #4e5969;
      font-size: 15px; line-height: 1; cursor: pointer;
    }
    .m115-close:hover { background: #ff4d4f; color: #fff; }

    .m115-pagetitle {
      padding: 10px 16px;
      font-size: 13px; font-weight: 600; color: #1677ff;
      background: #eef6ff;
      border-bottom: 1px solid #e6f0ff;
      word-break: break-all;
    }
    .m115-pagetitle .m115-pt-label { color: #86909c; font-weight: 400; }

    .m115-imageinfo {
      padding: 8px 16px;
      font-size: 12px; color: #4e5969;
      background: #fbfdff;
      border-bottom: 1px solid #f0f2f5;
      word-break: break-all;
    }
    .m115-toolbtn {
      flex: 0 0 auto;
      padding: 4px 10px;
      border: 1px solid #d9d9d9; border-radius: 6px;
      background: #fff; color: #4e5969;
      font-size: 12px; cursor: pointer;
    }
    .m115-toolbtn:hover { border-color: #1677ff; color: #1677ff; }
    .m115-toolbtn.danger { color: #cf1322; }
    .m115-toolbtn.danger:hover { border-color: #cf1322; color: #cf1322; }
    .m115-logrow {
      display: flex; gap: 10px;
      padding: 7px 16px;
      border-bottom: 1px solid #f2f3f5;
      font-size: 12px;
      font-family: Menlo, Consolas, "Courier New", monospace;
      word-break: break-all;
    }
    .m115-logrow:hover { background: #fafbfc; }
    .m115-logtime { flex: 0 0 auto; color: #86909c; }
    .m115-logmsg { flex: 1; color: #1f2329; }
    .m115-logrow.ok .m115-logmsg { color: #389e0d; }
    .m115-logrow.error .m115-logmsg { color: #cf1322; }
    .m115-logrow.info .m115-logmsg { color: #1677ff; }

    .m115-body { flex: 1; overflow-y: auto; padding: 6px 0; min-height: 80px; }
    .m115-empty { text-align: center; color: #86909c; padding: 56px 0; font-size: 15px; }

    .m115-row {
      display: flex; align-items: center; gap: 12px;
      padding: 10px 16px;
      border-bottom: 1px solid #f2f3f5;
    }
    .m115-row:hover { background: #f7f9fc; }
    .m115-info { flex: 1; min-width: 0; }
    .m115-name {
      font-weight: 600; color: #1d2129;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .m115-size {
      display: inline-block; margin-top: 3px;
      font-size: 12px; color: #4e5969;
      background: #f2f3f5; border-radius: 4px; padding: 1px 8px;
    }
    .m115-btn {
      flex: 0 0 auto; min-width: 68px;
      padding: 6px 14px;
      border: none; border-radius: 6px;
      background: #00b42a; color: #fff;
      font-size: 13px; font-weight: 600; cursor: pointer;
      transition: background .15s ease;
    }
    .m115-btn:hover { background: #009a24; }
    .m115-btn:disabled { background: #b1b3b8; cursor: not-allowed; }

    .m115-toast {
      position: fixed; top: 20px; left: 50%;
      transform: translateX(-50%) translateY(-16px);
      z-index: 2147483647;
      max-width: min(80vw, 640px);
      padding: 10px 20px;
      border-radius: 8px;
      color: #fff; font-size: 13px; font-weight: 600;
      box-shadow: 0 6px 20px rgba(0, 0, 0, .25);
      opacity: 0; pointer-events: none;
      transition: opacity .2s ease, transform .2s ease;
      word-break: break-all;
    }
    .m115-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .m115-toast.success { background: #00b42a; }
    .m115-toast.error { background: #f53f3f; }
    .m115-toast.info { background: #1677ff; }
  `;

  /* ================= 构建 UI ================= */

  // 宿主节点：固定定位、最高层级，避免页面 CSS 影响
  const host = document.createElement("div");
  host.id = "magnet115-helper-host";
  host.style.cssText =
    "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  (document.documentElement || document.body).appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });
  const styleEl = h("style");
  styleEl.textContent = STYLE;
  shadow.appendChild(styleEl);

  // 右上角「分析」按钮
  const fab = h("button", { class: "m115-fab", text: "分析" });

  // 弹框
  const mask = h("div", { class: "m115-mask" });
  const panel = h("div", { class: "m115-panel" });
  const header = h(
    "div",
    { class: "m115-header" },
    h("span", { class: "m115-title", text: "磁力链接分析" }),
    h("span", { class: "m115-count" }),
    h("span", { class: "m115-cookie" }),
    h("button", { class: "m115-toolbtn", text: "日志" }),
    h("button", { class: "m115-toolbtn danger", text: "清空", style: "display:none" }),
    h("button", { class: "m115-close", text: "✕" })
  );
  const pageTitleEl = h("div", { class: "m115-pagetitle" });
  const imageInfoEl = h("div", { class: "m115-imageinfo" });
  const body = h("div", { class: "m115-body" });
  panel.append(header, pageTitleEl, imageInfoEl, body);

  // 提示气泡
  const toast = h("div", { class: "m115-toast" });

  mask.style.display = "none";
  panel.style.display = "none";
  shadow.append(fab, mask, panel, toast);

  const countEl = header.querySelector(".m115-count");
  const cookieEl = header.querySelector(".m115-cookie");
  const closeBtn = header.querySelector(".m115-close");
  const headerTitleEl = header.querySelector(".m115-title");
  const logBtn = header.querySelector(".m115-toolbtn");
  const clearLogBtn = header.querySelector(".m115-toolbtn.danger");

  // 最近一次分析的结果（标题 + 最大图片 + 图片文件名 + 页面来源），供转存时使用
  let lastAnalysis = { title: "", imageUrl: "", imageName: "", referer: "" };
  // 最近一次渲染的数据（用于从日志视图返回时恢复）
  let lastRender = { items: [], title: "", imageUrl: "", imageName: "" };
  let logMode = false; // 当前是否处于日志视图

  /* ================= 交互逻辑 ================= */

  let toastTimer = null;
  function showToast(msg, type) {
    toast.textContent = msg;
    toast.className = "m115-toast " + (type || "info");
    void toast.offsetWidth; // 强制重排以触发过渡
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 5000);
  }

  function openPanel() {
    mask.style.display = "";
    panel.style.display = "";
  }

  function closePanel() {
    mask.style.display = "none";
    panel.style.display = "none";
    // 关闭时若处于日志视图，重置为分析视图状态
    if (logMode) {
      logMode = false;
      headerTitleEl.textContent = "磁力链接分析";
      logBtn.textContent = "日志";
      clearLogBtn.style.display = "none";
    }
  }

  /** 渲染：页面标题（最上面）+ 图片地址 + 磁力链接列表（从大到小）；无资源时提示「无资源」 */
  function render(items, title, imageUrl, imageName) {
    // 页面标题
    pageTitleEl.textContent = "";
    if (title) {
      pageTitleEl.style.display = "";
      pageTitleEl.appendChild(h("span", { class: "m115-pt-label", text: "📄 标题：" }));
      pageTitleEl.appendChild(document.createTextNode(title));
    } else {
      pageTitleEl.style.display = "none";
    }

    // 图片地址（便于排查图片下载失败问题；下载/上传使用原始文件名，上传后再重命名）
    imageInfoEl.textContent = "";
    if (imageUrl) {
      imageInfoEl.appendChild(h("span", { class: "m115-pt-label", text: "🖼️ 图片地址：" }));
      imageInfoEl.appendChild(document.createTextNode(imageUrl));
      if (imageName) {
        imageInfoEl.appendChild(document.createTextNode("（下载名：" + imageName + "）"));
      }
    } else {
      imageInfoEl.appendChild(h("span", { class: "m115-pt-label", text: "🖼️ 图片：未检测到" }));
    }

    // 列表
    body.textContent = "";
    if (!items.length) {
      countEl.textContent = "";
      body.appendChild(h("div", { class: "m115-empty", text: "无资源" }));
      return;
    }
    countEl.textContent = "共发现 " + items.length + " 个磁力链接（按大小排序）";
    for (const it of items) {
      const info = h(
        "div",
        { class: "m115-info" },
        h("div", { class: "m115-name", title: it.name, text: it.name }),
        h("span", { class: "m115-size", text: it.size })
      );
      const btn = h("button", { class: "m115-btn", text: "转存" });
      btn.addEventListener("click", () => doTransfer(it, btn));
      const row = h("div", { class: "m115-row" }, info, btn);
      body.appendChild(row);
    }
  }

  /**
   * 转存：通知后台添加离线任务；
   * 图片处理：页面上下文获取字节（同源自动携带页面 Referer，绕过防盗链）→ 交给后台
   * 静默保存到本地（原始文件名，不重命名）→ 自动上传到 115 下载目录 → 上传后重命名。
   */
  async function doTransfer(item, btn) {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.textContent = "转存中…";
    showToast("正在转存，请稍候…", "info");
    sendMessage({ type: "logEvent", msg: "点击转存：" + item.url + "（名称：" + item.name + "）" }).catch(() => {});

    // 页面上下文获取图片字节：
    // 1) 先让后台注册 webRequest 注入：强制给该图片请求加上 Referer = 当前页面地址
    //    （用户规范：Referer: cur_url）。内容脚本 fetch 可能不携带页面来源，
    //    或页面引用策略会剥掉 Referer，webRequest 注入最可靠
    // 2) fetch 并记录实际使用的 URL / Referer / 结果到日志，便于核对
    let imageBytes = null;
    if (lastAnalysis.imageUrl) {
      const imageUrl = lastAnalysis.imageUrl;
      const referer = location.href; // 当前页面地址 = Referer
      // 注册 DNR 注入（返回规则 id，取完后注销）
      let imgRuleId = null;
      try {
        const reg = await sendMessage({
          type: "registerImageHeaders",
          url: imageUrl,
          referer: referer,
          timeout: 30000,
        }).catch(() => null);
        imgRuleId = reg && reg.ruleId ? reg.ruleId : null;
      } catch (e) {
        /* 注入注册失败不阻塞 */
      }
      try {
        const r = await fetch(imageUrl, {
          credentials: "include",
          referrer: referer,
          referrerPolicy: "unsafe-url",
        });
        if (r.ok) {
          const ct = r.headers.get("content-type") || "";
          if (!ct || /^image\//i.test(ct)) {
            imageBytes = await r.arrayBuffer();
            sendMessage({
              type: "logEvent",
              msg: "图片下载成功：url=" + imageUrl + "，Referer=" + referer + "（HTTP 200，" + imageBytes.byteLength + " 字节）",
            }).catch(() => {});
          } else {
            sendMessage({ type: "logEvent", msg: "页面内图片不是图片类型：" + ct }).catch(() => {});
          }
        } else {
          sendMessage({
            type: "logEvent",
            msg: "图片下载失败：url=" + imageUrl + "，Referer=" + referer + "（HTTP " + r.status + "），转后台兜底",
          }).catch(() => {});
        }
      } catch (e) {
        // 跨域图片会被 CORS 拦截，转后台用 webRequest 注入 Referer/Cookie 兜底
        sendMessage({
          type: "logEvent",
          msg: "页面内获取图片被拦截（可能跨域 CORS）：" + (e && e.message ? e.message : e) + "，url=" + imageUrl + "，Referer=" + referer + "，转后台兜底",
        }).catch(() => {});
      }
      // 取完即注销注入规则
      if (imgRuleId) {
        try {
          await sendMessage({ type: "unregisterImageHeaders", ruleId: imgRuleId }).catch(() => {});
        } catch (e) {
          /* ignore */
        }
      }
    }

    try {
      const res = await sendMessage({
        type: "transferMagnet",
        url: item.url,
        magnetName: item.name,
        pageTitle: lastAnalysis.title,
        imageUrl: lastAnalysis.imageUrl,
        imageName: lastAnalysis.imageName,
        referer: lastAnalysis.referer,
        imageBytes: imageBytes, // ArrayBuffer 或 null
      });

      const parts = [];
      if (res && res.ok) {
        parts.push("转存成功 ✅，后台处理中（完成后重命名+上传图片）");
      } else {
        parts.push("转存失败：" + ((res && res.error_msg) || "未知错误"));
      }
      if (res && res.imageDownload) {
        if (res.imageDownload.ok) parts.push("图片已静默保存（" + (lastAnalysis.imageName || "") + "）");
        else if (res.imageDownload.error && res.imageDownload.error !== "页面未检测到图片")
          parts.push("图片保存失败：" + res.imageDownload.error);
        else parts.push("页面未检测到图片");
      }
      if (res && res.imageUpload) {
        if (res.imageUpload.ok) parts.push("图片已上传到115");
        else parts.push("图片上传失败：" + (res.imageUpload.error_msg || "未知错误"));
      }
      if (res && res.imageRename) {
        if (res.imageRename.ok) parts.push("图片已重命名为：" + res.imageRename.name);
        else parts.push("图片重命名失败：" + (res.imageRename.error_msg || ""));
      }
      showToast(parts.join(" · "), res && res.ok ? "success" : "error");
    } catch (e) {
      showToast("转存失败：" + (e && e.message ? e.message : e), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "转存";
    }
  }

  /** 在弹框头部显示 115 Cookie 获取状态 */
  function setCookieStatus(ok) {
    if (ok) {
      cookieEl.textContent = "✅ 115 Cookie 已获取";
      cookieEl.className = "m115-cookie ok";
    } else {
      cookieEl.textContent = "⚠️ 未获取到 115 Cookie（请先登录 115.com）";
      cookieEl.className = "m115-cookie bad";
    }
  }

  async function refreshCookieStatus() {
    try {
      const res = await sendMessage({ type: "get115Cookies" });
      setCookieStatus(!!(res && res.ok));
    } catch (e) {
      setCookieStatus(false);
    }
  }

  /* ================= 工作日志视图 ================= */

  async function renderLog() {
    body.textContent = "";
    let res = null;
    try {
      res = await sendMessage({ type: "getLog" });
    } catch (e) {
      /* ignore */
    }
    const entries = (res && res.log) || [];
    if (!entries.length) {
      body.appendChild(h("div", { class: "m115-empty", text: "暂无日志" }));
      return;
    }
    for (const e of entries) {
      const time = new Date(e.t).toLocaleTimeString("zh-CN", { hour12: false });
      const row = h(
        "div",
        { class: "m115-logrow " + (e.level || "info") },
        h("span", { class: "m115-logtime", text: time }),
        h("span", { class: "m115-logmsg", text: e.msg })
      );
      body.appendChild(row);
    }
  }

  function enterLogView() {
    logMode = true;
    headerTitleEl.textContent = "工作日志";
    logBtn.textContent = "返回";
    clearLogBtn.style.display = "";
    renderLog();
  }

  function exitLogView() {
    logMode = false;
    headerTitleEl.textContent = "磁力链接分析";
    logBtn.textContent = "日志";
    clearLogBtn.style.display = "none";
    render(lastRender.items, lastRender.title, lastRender.imageUrl, lastRender.imageName);
  }

  logBtn.addEventListener("click", () => {
    if (logMode) exitLogView();
    else enterLogView();
  });

  clearLogBtn.addEventListener("click", async () => {
    try {
      await sendMessage({ type: "clearLog" });
    } catch (e) {
      /* ignore */
    }
    renderLog();
  });

  // 点击「分析」：获取标题 + 最大图片，分析磁力链接并弹框展示
  fab.addEventListener("click", async () => {
    const title = getContentTitle();
    const image = await findLargestImage();
    const imageUrl = image ? image.url : "";
    const imageName = imageUrl ? getImageOriginalName(imageUrl) : ""; // 下载/上传使用原始文件名
    lastAnalysis = { title, imageUrl, imageName, referer: location.href };
    const items = analyzePage();
    lastRender = { items, title, imageUrl, imageName };
    render(items, title, imageUrl, imageName);
    openPanel();
    refreshCookieStatus();
    // 上报分析日志
    const siteCands = getSiteSpecificTitleCandidates();
    sendMessage({
      type: "logEvent",
      msg:
        "分析完成：标题=" + (title || "无") +
        "，站点标题候选=" + (siteCands.join(" | ") || "无") +
        "，图片=" + (imageUrl || "未检测到") +
        "，原始文件名=" + (imageName || "无") +
        "，磁力链接=" + items.length + "个",
    }).catch(() => {});
  });

  // 关闭弹框
  mask.addEventListener("click", closePanel);
  closeBtn.addEventListener("click", closePanel);
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") closePanel();
    },
    true
  );

  // 接收后台通知：115 下载完成、重命名进度等
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "jobUpdate") {
      showToast(msg.text || "", msg.ok ? "success" : "error");
      sendMessage({ type: "logEvent", msg: "[通知] " + (msg.text || "") }).catch(() => {});
    }
  });

  // 页面加载后自动预热一次 115 Cookie（失败静默，不影响使用）
  sendMessage({ type: "get115Cookies" }).catch(() => {});
})();
