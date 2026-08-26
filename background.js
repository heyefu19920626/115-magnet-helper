/**
 * 115 磁力分析助手 - 后台 Service Worker
 *
 * 职责：
 *  1. 自动获取并缓存 115.com 的 Cookie（cookie 变化时自动刷新缓存）
 *  2. 转存磁力链接：GET ct=offline&ac=space 取 sign/time/uid → POST add_task_url
 *  3. 转存同时处理页面图片：
 *     - 内容脚本在页面上下文获取字节（同源自动带 Referer/Cookie）
 *     - 后台用 data: URL + saveAs:false 以原始文件名保存到本地（下载时先不重命名；
 *       若浏览器开启“下载前询问保存位置”，保存框由该设置决定，扩展 API 无法绕过）
 *     - 通过 chrome.cookies 读取图片域名 Cookie，与页面 Referer 一起经
 *       declarativeNetRequest 修改请求头，兜底获取被防盗链拦截的图片
 *  4. 转存前记录「云下载」目录现有条目；转存后轮询该目录（最多 30 秒），
 *     检测到新增目录/文件即视为下载完成，通过其 cid 进入对应目录
 *  5. 进入目录后：把其中最大的文件重命名为网页内容标题，并把图片上传到该目录
 *     （sampleinitupload + OSS），上传成功后把图片重命名为标题
 */
"use strict";

const COOKIE_TTL = 60 * 1000;       // Cookie 缓存有效期：60 秒
let cookieHeader = null;            // 缓存的 Cookie 字符串
let cookieFetchedAt = 0;            // 缓存时间戳

const LOG_KEY = "m115Log";          // 工作日志持久化 key
const LOG_MAX = 500;                // 日志最大条数（超出丢弃最旧）

const COMPLETE_TIMEOUT = 30 * 1000; // 检测云下载目录新增条目的轮询超时：30 秒（超时视为下载失败）
const POLL_INTERVAL = 2000;         // 轮询间隔：2 秒

/* ================= 请求头注入（declarativeNetRequest） =================
 * javbus / javdb 等站点的图片 CDN 会校验 Referer 请求头，部分还要求本站 Cookie
 * （登录态 / 会话 / Cloudflare 等），无 Cookie 的请求直接返回 403。
 * 扩展 SW 的 fetch 无法通过 referrer 选项携带来源（会被忽略）、无法直接设置
 * Cookie 头，且 chrome.webRequest 拦截不到扩展自身发起的请求（会导致注入无效、
 * 请求仍 403），因此改用 declarativeNetRequest 的 modifyHeaders 规则——
 * 它在网络层对包括扩展请求在内的所有请求生效（需要 declarativeNetRequest 权限
 * 与 <all_urls> 主机权限）。图片请求前临时注册规则、请求后移除。
 * 同时按 wget 的行为移除 Origin 头（浏览器跨域 fetch 会带
 * Origin: chrome-extension://…，部分站点会因此拒绝）。
 */
let ruleIdCounter = 11500;
const activeRuleIds = new Set();

function hostOf(url) {
  try {
    return new URL(String(url || "")).hostname;
  } catch (e) {
    return "";
  }
}

/** 为指定图片请求注册 DNR 头修改：设置 Referer（与 Cookie），可选移除 Origin */
async function dnrInjectHeaders(imageUrl, referer, cookieHeader, removeOrigin) {
  const host = hostOf(imageUrl);
  if (!host) return null;
  const requestHeaders = [];
  if (referer) requestHeaders.push({ header: "referer", operation: "set", value: String(referer) });
  if (cookieHeader) requestHeaders.push({ header: "cookie", operation: "set", value: String(cookieHeader) });
  if (removeOrigin) requestHeaders.push({ header: "origin", operation: "remove" });
  if (!requestHeaders.length) return null;
  const id = ++ruleIdCounter;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 1,
          action: { type: "modifyHeaders", requestHeaders },
          condition: { requestDomains: [host] },
        },
      ],
    });
    activeRuleIds.add(id);
    return id;
  } catch (e) {
    console.error("[115磁力助手] DNR 注入失败：", e);
    return null;
  }
}

async function dnrRemoveHeaders(id) {
  if (!id || !activeRuleIds.has(id)) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [id] });
  } catch (e) {
    /* ignore */
  }
  activeRuleIds.delete(id);
}

/* ================= Cookie ================= */

function domainIs115(domain) {
  const d = String(domain || "").toLowerCase().replace(/^\./, "");
  return d === "115.com" || d.endsWith(".115.com");
}

function getAllCookies(details) {
  return new Promise((resolve, reject) => {
    chrome.cookies.getAll(details, (cookies) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(cookies || []);
    });
  });
}

async function fetch115Cookies() {
  const cookies = await getAllCookies({ domain: "115.com" });
  return cookies.map((c) => c.name + "=" + c.value).join("; ");
}

async function get115CookieHeader(force) {
  const now = Date.now();
  if (!force && cookieHeader && now - cookieFetchedAt < COOKIE_TTL) return cookieHeader;
  try {
    const header = await fetch115Cookies();
    if (header) {
      cookieHeader = header;
      cookieFetchedAt = now;
    }
  } catch (e) {
    console.error("[115磁力助手] 获取 Cookie 失败：", e);
  }
  return cookieHeader;
}

chrome.cookies.onChanged.addListener((changeInfo) => {
  const cookie = changeInfo && changeInfo.cookie;
  if (cookie && domainIs115(cookie.domain)) {
    cookieHeader = null;
    cookieFetchedAt = 0;
  }
});

/** 从 Cookie 字符串中提取 UID */
function uidFromCookie(header) {
  const m = String(header || "").match(/(?:^|;\s*)UID=([^;]+)/);
  return m ? m[1] : "";
}

/** 合并图片域名与页面域名的 Cookie（去重），拼成 "name=value; ..." 请求头格式（含 HttpOnly） */
async function getCookiesHeaderForFetch(imageUrl, pageUrl) {
  const seen = new Map();
  const add = async (url) => {
    if (!url) return;
    try {
      const cookies = await getAllCookies({ url: String(url) });
      for (const c of cookies || []) {
        if (!seen.has(c.name)) seen.set(c.name, c.value);
      }
    } catch (e) {
      /* ignore */
    }
  };
  await add(imageUrl);
  await add(pageUrl);
  return [...seen.entries()].map(([k, v]) => k + "=" + v).join("; ");
}

/* ================= 工作日志 ================= */

function getLog() {
  return new Promise((resolve) => {
    chrome.storage.local.get(LOG_KEY, (o) => {
      resolve(Array.isArray(o[LOG_KEY]) ? o[LOG_KEY] : []);
    });
  });
}

/** 追加一条日志：level 为 "info" / "ok" / "error" */
async function appendLog(level, msg) {
  try {
    const log = await getLog();
    log.push({ t: Date.now(), level, msg: String(msg) });
    if (log.length > LOG_MAX) log.splice(0, log.length - LOG_MAX);
    await new Promise((res) => chrome.storage.local.set({ [LOG_KEY]: log }, () => res()));
  } catch (e) {
    /* 日志失败不影响主流程 */
  }
}

async function clearLog() {
  await new Promise((res) => chrome.storage.local.remove(LOG_KEY, () => res()));
}

/* ================= 通用请求 ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Uint8Array → base64（用于缓存图片字节 / 构造 data: URL） */
function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * 带 115 Cookie 的 JSON 请求
 * 抛错即失败；成功返回解析后的 JSON
 */
async function requestJson(url, options = {}) {
  const cookie = await get115CookieHeader(false);
  const headers = {
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Referer": "https://115.com/",
    "X-Requested-With": "XMLHttpRequest",
    ...(options.headers || {}),
  };
  if (cookie) headers["Cookie"] = cookie;

  let resp;
  try {
    resp = await fetch(url, { ...options, headers, credentials: "include" });
  } catch (e) {
    throw new Error("网络请求失败：" + (e && e.message ? e.message : e));
  }
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    throw new Error("接口返回非 JSON（HTTP " + resp.status + "）：" + text.slice(0, 200));
  }
  return json;
}

/* ================= 转存 ================= */

/** 获取 115 离线下载签名（sign/time）与 uid */
async function getLixianAuth() {
  const json = await requestJson("https://115.com/?ct=offline&ac=space");
  if (!json || json.state === false) {
    throw new Error("获取115离线签名失败：" + ((json && json.error_msg) || "state=false"));
  }
  const uid = json.uid || uidFromCookie(await get115CookieHeader(false));
  return { uid: String(uid || ""), sign: json.sign || "", time: String(json.time || "") };
}

/**
 * 添加磁力离线任务
 * POST https://115.com/web/lixian/?ct=lixian&ac=add_task_url
 * 参数：uid / sign / time / url（sign、time 来自官方 space 接口，无需自己计算）
 * 返回：{ ok, state, error_msg, data? }，state 为 true/1 视为成功
 */
async function addTaskUrl(magnetUrl) {
  try {
    const auth = await getLixianAuth();
    if (!auth.uid) {
      return { ok: false, state: false, error_msg: "未获取到115用户UID（请确认已登录115.com）" };
    }
    const body = new URLSearchParams();
    body.append("uid", auth.uid);
    body.append("sign", auth.sign);
    body.append("time", auth.time);
    body.append("url", magnetUrl);

    const json = await requestJson("https://115.com/web/lixian/?ct=lixian&ac=add_task_url", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
    });

    const state = json && json.state;
    const success = state === true || state === 1 || state === "1" || state === "true";
    return {
      ok: success,
      state,
      error_msg: success ? "" : ((json && json.error_msg) || "未知错误"),
      data: json,
    };
  } catch (e) {
    return { ok: false, state: false, error_msg: e && e.message ? e.message : String(e) };
  }
}

/* ================= 图片：保存到本地 + 上传到 115 ================= */

/**
 * 下载到本地（data: URL，静默保存到默认下载目录）
 * 注意：chrome.downloads 的 headers 选项不允许 Referer 等不安全请求头；
 * saveAs: false 为尽力静默——若浏览器开启了“下载前询问每个文件的保存位置”，
 * 该设置会覆盖 saveAs（Chromium 已知问题），此时需在 chrome://settings/downloads 关闭。
 */
function downloadImage(url, filename) {
  return new Promise((resolve) => {
    const options = { url, conflictAction: "uniquify", saveAs: false };
    if (filename) options.filename = filename;
    try {
      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve({ ok: true, id });
      });
    } catch (e) {
      resolve({ ok: false, error: e && e.message ? e.message : String(e) });
    }
  });
}

/** 按文件名扩展名推断 MIME（用于构造 data: URL） */
function mimeFromName(name) {
  const m = String(name || "").match(/\.([^.\\/]+)$/);
  const ext = m ? m[1].toLowerCase() : "";
  const map = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml",
    heic: "image/heic", dng: "image/dng", avif: "image/avif",
  };
  return map[ext] || "image/jpeg";
}

/**
 * 把图片字节以 data: URL 形式静默保存到本地下载目录
 * 返回 { ok, bytes: base64, size }
 */
async function saveImageBytesLocally(filename, bytes) {
  try {
    const safeName = sanitizeFileName(filename || "image.jpg");
    const b64 = bytesToBase64(bytes);
    const dataUrl = "data:" + mimeFromName(safeName) + ";base64," + b64;
    const dl = await downloadImage(dataUrl, safeName);
    if (!dl.ok) return { ok: false, error: "本地保存失败：" + dl.error };
    return { ok: true, bytes: b64, size: bytes.length };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * 后台兜底获取图片（内容脚本取不到字节时使用）：
 * 1) 合并图片域名与页面域名的 Cookie，与页面 Referer 一起通过 declarativeNetRequest
 *    修改请求头（并移除 Origin），再 fetch
 *    （按 origin 匹配，图片重定向后依然生效）
 * 2) 校验 Content-Type 确实是图片（避免把 HTML 错误页当图片保存）
 * 3) 交给 saveImageBytesLocally 静默保存，并返回字节（base64）供上传使用
 */
async function prepareImageDownload(imageUrl, filename, referer) {
  const cookieHeader = await getCookiesHeaderForFetch(imageUrl, referer);
  // DNR 注入：设置 Referer（页面地址）+ Cookie，并移除 Origin（与 wget 行为一致）
  const ruleId = await dnrInjectHeaders(imageUrl, referer, cookieHeader, true);
  await appendLog(
    "info",
    "后台兜底获取图片：url=" + imageUrl +
      "，注入Referer=" + (referer || "无") +
      "，注入Cookie条数=" + (cookieHeader ? cookieHeader.split("; ").length : 0) +
      "，DNR规则=" + (ruleId ? "已注册" : "未注册")
  );
  try {
    // 有显式 Cookie 头时用 credentials: "omit"，避免浏览器重复附加一份
    const resp = await fetch(imageUrl, {
      credentials: cookieHeader ? "omit" : "include",
    });
    await appendLog(resp.ok ? "ok" : "error", "后台兜底图片响应：HTTP " + resp.status);
    if (!resp.ok) return { ok: false, error: "图片获取失败（HTTP " + resp.status + "）" };
    const ct = resp.headers.get("content-type") || "";
    if (ct && !/^image\//i.test(ct)) {
      return { ok: false, error: "目标地址返回的不是图片（" + ct + "）" };
    }
    const blob = await resp.blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!bytes.length) return { ok: false, error: "图片内容为空" };
    return await saveImageBytesLocally(filename, bytes);
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  } finally {
    await dnrRemoveHeaders(ruleId);
  }
}

/**
 * 将图片上传到 115 指定目录（用户规范）
 * 1) POST https://uplb.115.com/3.0/sampleinitupload.php
 *    参数：filename / filesize / target（U_1_<目录cid>），响应返回 OSS 上传字段
 * 2) 将文件字节连同 OSS 字段 multipart POST 到返回的 host，即完成上传
 */
async function uploadImageTo115(dirCid, filename, bytesBase64) {
  try {
    const name = filename || "image.jpg";
    let bytes;
    try {
      bytes = base64ToBytes(bytesBase64);
    } catch (e) {
      throw new Error("图片数据解码失败");
    }
    if (!bytes.length) throw new Error("图片数据为空");

    // 1) 初始化上传
    const initBody = new URLSearchParams();
    initBody.append("filename", name);
    initBody.append("filesize", String(bytes.length));
    initBody.append("target", "U_1_" + dirCid);
    const initJson = await requestJson("https://uplb.115.com/3.0/sampleinitupload.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: initBody.toString(),
    });
    if (!initJson || !initJson.host) {
      throw new Error("上传初始化失败：" + JSON.stringify(initJson || {}).slice(0, 200));
    }

    // 2) 上传文件字节到 OSS host
    const form = new FormData();
    form.append("name", name);
    form.append("key", initJson.object);
    form.append("policy", initJson.policy);
    form.append("OSSAccessKeyId", initJson.accessid);
    form.append("success_action_status", "200");
    form.append("callback", initJson.callback);
    form.append("signature", initJson.signature);
    form.append("file", new Blob([bytes]), name);
    const upResp = await fetch(initJson.host, { method: "POST", body: form });
    const upText = await upResp.text();
    if (!upResp.ok) {
      throw new Error("文件上传失败（HTTP " + upResp.status + "）：" + upText.slice(0, 200));
    }
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error_msg: e && e.message ? e.message : String(e) };
  }
}

/* ================= 文件列表 / 目录 / 重命名 ================= */

/**
 * 列出 115 目录下的文件与子目录
 * GET https://webapi.115.com/files?aid=1&cid=...&limit=1150
 * data 中：目录项 fid 为空/"0"（目录 ID 用 cid 字段）；文件项有 fid（文件 ID）与 s（大小，字节）
 */
async function listFiles(cid) {
  const q = new URLSearchParams({
    aid: "1",
    cid: String(cid || "0"),
    o: "user_ptime",
    asc: "0",
    offset: "0",
    show_dir: "1",
    limit: "1150",
    snap: "0",
    natsort: "0",
    record_open_time: "1",
    format: "json",
    fc_mix: "0",
  });
  const json = await requestJson("https://webapi.115.com/files?" + q.toString());
  if (!json || json.state === false) {
    throw new Error("文件列表获取失败：" + ((json && json.error_msg) || (json && json.error) || "state=false"));
  }
  const data = json.data || [];
  return data.map((f) => {
    const fid = String(f.fid || "");
    const cid2 = String(f.cid || "");
    // 用户规范：data 中对象有 uid 的是文件，没有 uid 的是目录
    const hasUid = f.uid !== undefined && f.uid !== null && f.uid !== "";
    const isDir = !hasUid;
    return { fid: isDir ? cid2 : fid, cid: cid2, n: f.n || "", s: Number(f.s) || 0, isDir };
  });
}

// “云下载”目录 cid 缓存（5 分钟）
let yunCid = null;
let yunCidAt = 0;
const YUN_CID_TTL = 5 * 60 * 1000;

async function getYunDownloadCid(force) {
  const now = Date.now();
  if (!force && yunCid && now - yunCidAt < YUN_CID_TTL) return yunCid;
  const items = await listFiles("0"); // 根目录
  const dir =
    items.find((it) => it.isDir && it.n === "云下载") ||
    items.find((it) => it.isDir && /云下载|离线下载|下载完成/.test(it.n));
  const cid = dir ? dir.fid : "0";
  yunCid = cid;
  yunCidAt = now;
  if (dir) await appendLog("info", "找到云下载目录：n=" + dir.n + "，cid=" + cid);
  else await appendLog("info", "未找到云下载目录，回退使用根目录（cid=0）");
  return cid;
}

/** 在目录中找到最大的文件（比较 data 中每个对象的 s 属性）；目录内无文件时进入子目录一层查找 */
async function findLargestFileInDir(dirId) {
  let items = [];
  try {
    items = await listFiles(dirId);
  } catch (e) {
    return null;
  }
  const files = items.filter((it) => !it.isDir && it.s > 0);
  if (files.length) return files.sort((a, b) => b.s - a.s)[0];

  for (const d of items.filter((it) => it.isDir)) {
    try {
      const sub = await listFiles(d.fid);
      const subFiles = sub.filter((it) => !it.isDir && it.s > 0);
      if (subFiles.length) return subFiles.sort((a, b) => b.s - a.s)[0];
    } catch (e) {
      /* 继续尝试下一个子目录 */
    }
  }
  return null;
}

/** 重命名文件：POST batch_rename，参数 files_new_name[<文件ID>] = 新名称 */
async function renameFile(fid, name) {
  const body = new URLSearchParams();
  body.append("files_new_name[" + fid + "]", name);
  const json = await requestJson("https://webapi.115.com/files/batch_rename", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: body.toString(),
  });
  const state = json && json.state;
  const success = state === true || state === 1 || state === "1" || state === "true";
  return {
    ok: success,
    error_msg: success ? "" : ((json && json.error_msg) || (json && json.error) || "未知错误"),
    data: json,
  };
}

/**
 * 移动文件到指定目录（用户规范）
 * POST https://webapi.115.com/files/move
 * 参数：pid=<目标目录cid>，fid[0]=<文件id> ...
 */
async function moveFiles(pid, fileIds) {
  try {
    const body = new URLSearchParams();
    body.append("pid", String(pid));
    (fileIds || []).forEach((fid, i) => body.append("fid[" + i + "]", String(fid)));
    const json = await requestJson("https://webapi.115.com/files/move", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
      body: body.toString(),
    });
    const state = json && json.state;
    const success = state === true || state === 1 || state === "1" || state === "true";
    return {
      ok: success,
      error_msg: success ? "" : ((json && json.error_msg) || (json && json.error) || "未知错误"),
      data: json,
    };
  } catch (e) {
    return { ok: false, error_msg: e && e.message ? e.message : String(e) };
  }
}

/** 清理文件名中的非法字符 */
function sanitizeFileName(name) {
  return (
    String(name || "")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[. ]+|[. ]+$/g, "")
      .slice(0, 200) || "未命名"
  );
}

/**
 * 图片上传成功后，把刚上传的图片重命名为页面标题（115 会保留原扩展名）。
 * 先在目录中按原始文件名找到刚上传的图片，再调用 batch_rename。
 * 返回 { ok, name?, error_msg? }
 */
async function renameImageInDir(dirCid, originalName, pageTitle) {
  try {
    if (!originalName) return { ok: false, error_msg: "图片原始文件名为空" };
    const items = await listFiles(dirCid);
    const uploaded = items.find((it) => !it.isDir && it.n === originalName);
    if (!uploaded) {
      return { ok: false, error_msg: "未在目录中找到刚上传的图片「" + originalName + "」" };
    }
    let base = sanitizeFileName(pageTitle || "未命名");
    const m = String(uploaded.n || "").match(/(\.[^.\\/]+)$/);
    if (m && base.toLowerCase().endsWith(m[1].toLowerCase())) {
      base = base.slice(0, -m[1].length); // 标题已带相同扩展名时去掉，避免双扩展名
    }
    base = sanitizeFileName(base);
    const r = await renameFile(uploaded.fid, base);
    return r.ok ? { ok: true, name: base, fid: uploaded.fid } : { ok: false, error_msg: r.error_msg };
  } catch (e) {
    return { ok: false, error_msg: e && e.message ? e.message : String(e) };
  }
}

/** 重命名目录中最大的文件为标题 */
async function renameLargestFileInDir(dirId, pageTitle, magnetName, tabId, tagStr) {
  const largest = await findLargestFileInDir(dirId);
  if (!largest) {
    const msg = "未在目录中找到文件（目录ID：" + dirId + "）";
    await appendLog("error", tagStr + msg);
    notifyTab(tabId, { type: "jobUpdate", ok: false, text: msg });
    return { ok: false, error_msg: msg };
  }
  await appendLog(
    "info",
    tagStr + "目录中最大文件：" + largest.n + "（" + largest.s + " 字节，fid=" + largest.fid + "）"
  );
  const newName = sanitizeFileName(pageTitle || magnetName || "未命名");
  let res;
  try {
    res = await renameFile(largest.fid, newName);
  } catch (e) {
    res = { ok: false, error_msg: e && e.message ? e.message : String(e) };
  }
  if (res.ok) {
    await appendLog("ok", tagStr + "重命名成功：" + largest.n + " → " + newName);
    notifyTab(tabId, { type: "jobUpdate", ok: true, text: "已将目录中最大文件重命名为：" + newName });
  } else {
    await appendLog("error", tagStr + "重命名失败：" + res.error_msg);
    notifyTab(tabId, { type: "jobUpdate", ok: false, text: "重命名失败：" + res.error_msg });
  }
  return res;
}

/* ================= 转存后的后台处理 ================= */

/** 通知内容脚本（tab 已关闭时静默失败） */
function notifyTab(tabId, payload) {
  if (!tabId) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, payload, () => resolve()); // lastError 忽略
    } catch (e) {
      resolve();
    }
  });
}

/**
 * 转存成功后异步处理（用户规范，效率优化版）：
 * 图片已在转存时立即上传到「云下载」目录并重命名；这里只负责：
 * 1) 转存前已记录「云下载」目录现有条目（beforeItems）
 * 2) 轮询「云下载」目录（最多 30 秒），检测新增【目录】（data 中有 uid 的是文件、
 *    无 uid 的是目录；只看新增目录，避免提前上传的图片等文件误触发）
 * 3) 进入目录后：重命名最大文件为标题 → 把图片从云下载目录移动到该目录（files/move）
 */
async function watchNewDirAndProcess({ tabId, yunDirCid, beforeItems, pageTitle, magnetName, imageFid, imageRenameName }) {
  const beforeKeys = new Set(beforeItems.map((it) => (it.isDir ? "D" : "F") + it.fid));
  const deadline = Date.now() + COMPLETE_TIMEOUT;
  let newItem = null;
  let targetDir = "";

  while (Date.now() < deadline) {
    try {
      const cid = yunDirCid || (await getYunDownloadCid());
      const items = await listFiles(cid);
      // 用户规范：只看新增【目录】（文件可能因提前上传/分页被误判，目录最可靠）。
      // 转存时上传的图片是文件，不会触发；真正的磁力下载完成会创建新目录。
      const addedDirs = items.filter((it) => it.isDir && !beforeKeys.has("D" + it.fid));
      if (addedDirs.length) {
        newItem = addedDirs[0];
        targetDir = newItem.fid; // 进入该目录
        break;
      }
    } catch (e) {
      /* 下一轮再试 */
    }
    await sleep(POLL_INTERVAL);
  }

  if (!newItem) {
    await appendLog("error", "30秒内未在云下载目录发现新增目录，视为下载失败");
    notifyTab(tabId, { type: "jobUpdate", ok: false, text: "115下载失败：30秒内未检测到新增目录" });
    return;
  }

  await appendLog("ok", "检测到新增目录：「" + newItem.n + "」（cid=" + targetDir + "），进入该目录处理");
  notifyTab(tabId, { type: "jobUpdate", ok: true, text: "115下载完成，进入目录：「" + newItem.n + "」" });

  // 1) 重命名目录中最大的文件为标题
  await renameLargestFileInDir(targetDir, pageTitle, magnetName, tabId, "");

  // 2) 把转存时上传到云下载目录的图片移动到对应目录（files/move）
  if (imageFid || imageRenameName) {
    let fid = imageFid;
    // fid 缺失时按重命名后的文件名在云下载目录中找回
    if (!fid && imageRenameName && yunDirCid) {
      try {
        const items = await listFiles(yunDirCid);
        const f = items.find((it) => !it.isDir && it.n === imageRenameName);
        if (f) fid = f.fid;
      } catch (e) {
        /* ignore */
      }
    }
    if (!fid) {
      await appendLog("error", "未找到图片的 fid，跳过移动到对应目录");
      notifyTab(tabId, { type: "jobUpdate", ok: false, text: "未找到图片，跳过移动到对应目录" });
      return;
    }
    const mv = await moveFiles(targetDir, [fid]);
    await appendLog(
      mv.ok ? "ok" : "error",
      "移动图片到目录 cid=" + targetDir + "：" + (mv.ok ? "成功" : "失败：" + mv.error_msg)
    );
    notifyTab(tabId, { type: "jobUpdate", ok: mv.ok, text: mv.ok ? "图片已移动到对应目录" : "图片移动失败：" + mv.error_msg });
  }
}

/** 提取标题最前面的字母-数字（番号，如 "MIAB-481"） */
function leadingCode(title) {
  const m = String(title || "").trim().match(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*/);
  return m ? m[0] : "";
}

/**
 * 查询 115 中是否已存在同番号影片（用户规范）
 * GET https://webapi.115.com/files/search?offset=0&limit=30&search_value=<番号>&...&format=json
 * 遍历响应 data，判断对象的 n 是否以番号开头（不区分大小写）
 * 返回 { ok, exists, searchValue, matches? }
 */
async function searchExistingMovies(title) {
  const code = leadingCode(title);
  if (!code) return { ok: true, exists: false, searchValue: "" };
  const q = new URLSearchParams({
    offset: "0",
    limit: "30",
    search_value: code,
    date: "",
    aid: "1",
    cid: "0",
    pick_code: "",
    type: "",
    count_folders: "1",
    source: "",
    format: "json",
  });
  try {
    const json = await requestJson("https://webapi.115.com/files/search?" + q.toString());
    const data = Array.isArray(json && json.data) ? json.data : [];
    const codeLower = code.toLowerCase();
    const matches = data.filter((it) => String(it.n || "").toLowerCase().startsWith(codeLower));
    await appendLog(
      "info",
      "115查重：番号=" + code + "，搜索结果 " + data.length + " 条，匹配 " + matches.length + " 条"
    );
    return {
      ok: true,
      exists: matches.length > 0,
      searchValue: code,
      matches: matches.slice(0, 10).map((m) => ({ n: m.n, fid: m.fid })),
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/* ================= 消息处理 ================= */

async function handleTransferMagnet(msg, sender) {
  const tabId = sender.tab && sender.tab.id;
  const magnetUrl = String(msg.url || "");
  const magnetName = String(msg.magnetName || "");
  const pageTitle = String(msg.pageTitle || "");
  const haveBytes = !!(msg.imageBytes && msg.imageBytes.byteLength);

  await appendLog(
    "info",
    "收到转存请求：url=" + magnetUrl.slice(0, 120) +
      "，磁力名称=" + magnetName +
      "，标题=" + pageTitle +
      "，图片=" + (msg.imageUrl || "无") +
      "，原始文件名=" + (msg.imageName || "无") +
      "，页面来源=" + (msg.referer || "无") +
      "，内容脚本已取字节=" + (haveBytes ? "是" : "否")
  );

  // 0) 转存前：记录「云下载」目录现有条目（用于之后检测新增目录/文件）
  let yunDirCid = "";
  let beforeItems = [];
  try {
    yunDirCid = await getYunDownloadCid();
    beforeItems = await listFiles(yunDirCid);
    await appendLog("info", "转存前云下载目录（cid=" + yunDirCid + "）现有条目 " + beforeItems.length + " 项");
  } catch (e) {
    await appendLog("info", "转存前获取云下载目录失败，稍后重试：" + (e && e.message ? e.message : e));
  }

  // 1) 添加任务 + 图片处理（静默保存到本地）同时进行
  const [res, imageRes] = await Promise.all([
    addTaskUrl(magnetUrl),
    (async () => {
      if (haveBytes) return await saveImageBytesLocally(msg.imageName, new Uint8Array(msg.imageBytes));
      if (msg.imageUrl) return await prepareImageDownload(msg.imageUrl, msg.imageName || "", msg.referer || "");
      return { ok: false, error: "页面未检测到图片" };
    })(),
  ]);

  await appendLog(res.ok ? "ok" : "error", "转存结果：" + (res.ok ? "成功" : "失败：" + (res.error_msg || "")));
  await appendLog(
    imageRes.ok ? "ok" : "error",
    "图片处理结果：" + (imageRes.ok ? "已保存到本地（" + imageRes.size + " 字节）" : "失败：" + (imageRes.error || ""))
  );

  // 2) 立即上传图片到「云下载」目录并重命名为标题（效率优化：不等磁力下载完成）
  if (!yunDirCid) {
    try {
      yunDirCid = await getYunDownloadCid();
    } catch (e) {
      /* ignore */
    }
  }
  let imageUpload = null;
  let imageRename = null;
  if (imageRes.ok && yunDirCid) {
    imageUpload = await uploadImageTo115(yunDirCid, msg.imageName || "image.jpg", imageRes.bytes);
    await appendLog(
      imageUpload.ok ? "ok" : "error",
      "图片上传到云下载目录：" + (imageUpload.ok ? "成功（" + imageUpload.name + "，cid=" + yunDirCid + "）" : "失败：" + imageUpload.error_msg)
    );
    if (imageUpload.ok) {
      imageRename = await renameImageInDir(yunDirCid, msg.imageName, pageTitle);
      await appendLog(
        imageRename.ok ? "ok" : "error",
        "图片重命名为标题：" + (imageRename.ok ? "成功 → " + imageRename.name : "失败：" + imageRename.error_msg)
      );
    }
  }

  // 3) 转存成功后：后台轮询磁力下载完成 → 重命名目录最大文件 → 把图片移动到对应目录
  if (res.ok) {
    notifyTab(tabId, { type: "jobUpdate", ok: true, text: "转存成功，正在等待115下载完成（30秒内）…" });
    watchNewDirAndProcess({
      tabId,
      yunDirCid,
      beforeItems,
      pageTitle,
      magnetName,
      imageFid: imageRename && imageRename.ok ? imageRename.fid : "",
      imageRenameName: imageRename && imageRename.ok ? imageRename.name : "",
    }); // 异步，不阻塞响应
  }

  return { ...res, imageDownload: imageRes, imageUpload, imageRename };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return;

  if (msg.type === "get115Cookies") {
    get115CookieHeader(msg.force === true)
      .then((header) => sendResponse({ ok: !!header, cookie: header || "" }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === "transferMagnet") {
    handleTransferMagnet(msg, sender)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, state: false, error_msg: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === "searchExisting") {
    searchExistingMovies(String(msg.title || ""))
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message ? e.message : e) }));
    return true;
  }

  if (msg.type === "getLog") {
    getLog().then((log) => sendResponse({ ok: true, log: log.slice().reverse() })); // 最新的在最上面
    return true;
  }

  // 内容脚本在 fetch 图片前调用：注册 DNR 注入（Referer = 当前页面地址），
  // 确保图片请求携带正确的来源（javbus 等要求 Referer 等于页面完整地址）
  if (msg.type === "registerImageHeaders") {
    dnrInjectHeaders(msg.url, msg.referer || "", "", false)
      .then((ruleId) => sendResponse({ ok: !!ruleId, ruleId: ruleId || null }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (msg.type === "unregisterImageHeaders") {
    dnrRemoveHeaders(msg.ruleId);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "clearLog") {
    clearLog().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === "logEvent") {
    appendLog("info", "[页面] " + (msg.msg || ""));
    sendResponse({ ok: true });
    return true;
  }
});
