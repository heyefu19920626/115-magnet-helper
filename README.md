# 115 磁力分析助手（Chrome 扩展）

仅在 **javdb.com / javbus.com** 生效的 Chrome 扩展（Manifest V3），完整流程：

1. **自动获取 Cookie**：自动获取 `https://115.com` 的 Cookie（后台获取并缓存，Cookie 变化时自动刷新）；
2. **自动查重**：页面加载完成后立刻分析并查重（用标题最前面的字母-数字番号查询 115）：
   - 已存在 → 右上角按钮变为**红底「番号xxx已存在」**；
   - 未保存 → 按钮变为**蓝底「番号xxx未保存」**；
   - 点击按钮仍可正常分析；
3. **分析**：点击右上角「分析」按钮后：
   - 从**网页内容**中获取「以字母/数字开头的完整标题」（不使用浏览器标签页标题）。
     候选优先级：站点专属（javdb.com：`<h2 class="title is-4">` 内的 `savdiv.sav-id`（番号）+
     `strong.current-title`（标题），取 h2 完整文本如 "AKDLD-363 【...】若葉結希"；
     javbus.com：`<h3>` 内的 `savdiv.sav-id` + 标题文字，取 h3 完整文本如
     "START-607 おねだり...恋渕ももな"；两者都只保留以字母/数字开头的内容）→
     磁力链接文字 / `dn` 参数 / title 类元素 / 标题元素 / 链接文字 / 文本块，显示在弹框最上面；
   - **115 查重**：用标题最前面的字母-数字（番号，如 `MIAB-481`）GET 调用
     `https://webapi.115.com/files/search?offset=0&limit=30&search_value=<番号>&date=&aid=1&cid=0&pick_code=&type=&count_folders=1&source=&format=json`
     查询 115；遍历响应 `data`，若存在 `n` 以该番号开头（不区分大小写）的对象，
     则标题下方显示**红色「⚠️ 番号xxx已存在」**，否则显示**蓝色「番号xxx未保存」**；
   - 弹框按行展示页面所有磁力链接（名称 + 大小），**按大小从大到小排序**，每条带「转存」按钮；
   - 无磁力链接时弹框提示 **无资源**；
3. **转存**：点击「转存」后：
   - 使用 115 Cookie 以 POST 调用 `https://115.com/web/lixian/?ct=lixian&ac=add_task_url` 添加离线任务，
     根据响应中的 `state` / `error_msg` 判断并提示结果；
   - **同时**处理页面图片：站点专属优先（javdb.com 取 `div.video-meta-panel` 内的图片地址；
     javbus.com 取 `a.bigImage` 内的图片地址，相对路径拼接在 `https://www.javbus.com` 之后）——
     由**页面上下文**获取字节（显式 `Referer` = 当前页面地址，绕过防盗链 403），
     只用于上传 115，**不保存到本地**（无下载弹框）；
   - **上传后立即重命名**：按原始文件名在目录中找到刚上传的图片，重命名为网页内容标题
     （115 自动保留扩展名）；
4. **完成检测与处理**（后台异步，用户规范，效率优化版）：
   - **转存后立即**把图片上传到「云下载」目录并重命名为网页内容标题（**不等磁力下载完成**）；
   - **转存前**记录「云下载」目录现有条目；
   - **转存后**轮询「云下载」目录（`GET https://webapi.115.com/files?aid=1&cid=<云下载cid>`，
     每 2 秒一次，**最多 30 秒**），检测**新增目录**——data 列表中**有 `uid` 的是文件、
     没有 `uid` 的是目录**，只看新增目录（提前上传的图片是文件，不会误触发；
     文件/目录过多分页时也不会把文件当完成信号）；
   - 通过新增目录的 **cid 进入该目录**；
   - 进入目录后：把其中**最大的文件**重命名为网页内容标题
     （`POST webapi.115.com/files/batch_rename`，传 `files_new_name[<fid>]=标题`）；
   - 把之前上传的图片**从云下载目录移动到该目录**：
     `POST https://webapi.115.com/files/move`，参数 `pid=<目标目录cid>`、`fid[0]=<图片fid>`。

## 文件结构

```
115-magnet-helper/
├── manifest.json     # Manifest V3 配置（cookies / storage / alarms / declarativeNetRequest）
├── background.js     # 后台 Service Worker：Cookie、转存、图片上传、完成检测 + 重命名 + 移动
├── content.js        # 内容脚本：分析按钮、弹框、内容标题/图片/磁力分析、查重、转存交互
└── popup.html        # 点击工具栏图标时的说明弹窗
```

## 安装方法

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 并回车；
2. 打开右上角的 **开发者模式** 开关；
3. 点击 **加载已解压的扩展程序**，选择本 `115-magnet-helper` 文件夹；
4. 安装完成后，**先在浏览器中登录 115.com**（扩展会自动获取登录 Cookie）。

> 更新代码后，请在 `chrome://extensions/` 点击扩展卡片上的 **刷新** 按钮重新加载。

## 使用说明

1. 打开任意网页（http/https），右上角出现「分析」按钮；
2. 点击「分析」：弹框顶部显示网页内容标题，下方列出全部磁力链接（按大小从大到小）；
   无磁力链接时提示「无资源」；
3. 点击某条的「转存」：
   - 气泡提示转存结果（成功/失败 + `error_msg`）；
   - 页面图片自动下载到本地下载目录，文件名为「标题 + 扩展名」；
   - 转存成功后，后台开始监控（每分钟轮询一次「云下载」目录）：
     - 目录中出现与磁力名称相同的文件 → 判定下载完成；
     - 找到该目录中最大的文件 → 重命名为网页内容标题；
     - 把页面图片上传到该目录（`sampleinitupload` + OSS 上传）；
     - 进度通过气泡实时提示。

## 调试：图片地址与工作日志

- 点击「分析」后，弹框标题栏下方会显示 **🖼️ 图片地址**（以及保存文件名），
  图片下载失败时可直接复制该地址到浏览器打开验证（如 404 / 防盗链 / 需登录等）。
- 弹框右上角 **「日志」** 按钮打开工作日志视图（再点「返回」回到列表，可「清空」）：
  - 记录内容脚本事件：分析完成（标题/图片/文件名/磁力数量）、点击转存、后台通知；
  - **图片下载会记录实际使用的 URL 与 Referer**（如 "图片下载成功：url=…，Referer=https://www.javbus.com/xxx（HTTP 200，N 字节）"、
    "图片下载失败：…（HTTP 403）"），后台兜底也会记录注入的 Referer 与 Cookie 条数——
    便于核对防盗链（javbus 要求 Referer 等于页面完整地址）是否生效；
  - 记录后台事件：收到转存请求、转存结果、图片校验/下载结果、新增目录检测、重命名结果、
    图片上传结果、超时等；
  - 日志带时间戳与级别（信息蓝 / 成功绿 / 错误红），持久化在 `chrome.storage.local`（最多 500 条）。

## 实现要点

- **转存接口**：
  - 先 `GET https://115.com/?ct=offline&ac=space`（携带 Cookie）取得官方 `sign` / `time` / `uid`，
    无需自行计算签名；
  - 再 `POST https://115.com/web/lixian/?ct=lixian&ac=add_task_url`，表单参数
    `uid`、`sign`、`time`、`url`（`url` 为磁力链接）；
  - `state` 为 `true`/`1` 视为成功，失败展示 `error_msg`。
- **完成检测**（用户规范）：`GET https://webapi.115.com/files` 列根目录 → 找 `n == "云下载"` 的目录
  取其 `cid` → `GET .../files?aid=1&cid=<cid>` 列该目录 → `data` 中对象的 `n` 与转存磁力链接名称相同
  即下载完成（名称未知时按规范取首个对象判定）。
- **找最大文件**（用户规范）：比较目录中每个对象的 `s` 属性（字节大小），取最大；
  若目录内无文件（多文件种子场景），进入子目录一层查找。
- **重命名**（用户规范）：`POST https://webapi.115.com/files/batch_rename`，
  仅传 `files_new_name[<最大文件fid>]` = 网页内容标题（标题中的非法文件名
  字符 `\ / : * ? " < > |` 等会被清理）。
- **图片获取**：站点专属选择器优先（javdb `div.video-meta-panel`、javbus `a.bigImage` + 域名拼接）；
  内容脚本在页面上下文 `fetch` 获取字节时，**显式指定 `referrer` = 当前页面地址 +
  `referrerPolicy: "unsafe-url"`** 强制发送完整 Referer（用户规范：`Referer: cur_url`）——
  javbus 等站点可能设置了 `no-referrer` 引用策略，浏览器会把同源请求的 Referer 也剥掉导致 403，
  必须强制覆盖；同时携带本站 Cookie（`credentials: "include"`）；
  跨域 CDN 或页面内被 CORS/CSP 拦截时，转后台兜底——后台合并**图片域名与页面域名**的
  Cookie（含 HttpOnly），再通过 **`chrome.declarativeNetRequest` `modifyHeaders` 规则**
  把页面 Referer 与 Cookie 写入请求头、并**移除 Origin 头**（与 wget 行为一致）后 fetch；
  DNR 在网络层对包括扩展自身请求在内的所有请求生效（`chrome.webRequest` 拦截不到扩展
  自身发起的请求，会导致注入无效、仍 403），因此 manifest 需要 `declarativeNetRequest`
  权限与 `<all_urls>` 主机权限；
  图片字节**只用于上传 115，不保存到本地**（无下载弹框）。
- **图片上传**：获取字节后立即执行，`sampleinitupload.php`（filename/filesize/target=U_1_<云下载目录cid>）→
  用响应中的 OSS 字段（host/object/policy/OSSAccessKeyId/success_action_status/callback/signature）
  把图片字节 multipart 上传到 `host`；上传成功后把该图片重命名为网页内容标题。
- **后台保活**：等待可能持续数小时，Service Worker 会被浏览器回收；
  待办任务持久化在 `chrome.storage.local`，并用 `chrome.alarms`（每 1 分钟）定时唤醒轮询，
  SW 重启后自动恢复，最长等待 24 小时。
- **UI 隔离**：所有界面元素放入 Shadow DOM，避免页面样式干扰按钮/弹框。
- **名称与大小**：名称优先取磁力链接 `dn` 参数，其次取链接文字；大小优先取 `xl` 参数（字节），
  其次从链接附近文本中匹配（如 `2.1 GB`），均无则显示「未知大小」（排序时沉底）。

## 注意事项

- 需要保持扩展权限包含 `cookies`、`storage`、`alarms`、`declarativeNetRequest`
  与 `<all_urls>` 主机权限（manifest 已配置）。
- 图片**不再下载到本地**（用户选择），只上传到 115——因此不会有任何下载保存框弹出。
- 图片获取/上传失败时，日志会记录具体原因（HTTP 状态、Content-Type 等）；
  打开弹框右上角「日志」即可定位。防盗链图片需要先在该浏览器登录对应网站
  （扩展会读取该网站 Cookie 并随请求注入）。
- 若 115 接口行为变化导致重命名/上传失败，可对照 115 网页端 DevTools 中真实网络请求调整
  `background.js` 顶部的接口地址。
- 请仅用于个人学习与合法资源转存，遵守相关法律法规。
