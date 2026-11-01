# 部署（GitHub Pages + 腾讯云 SCF 云函数代理）

> **为什么还要一个云函数？**
> 浏览器直连 `ark.cn-beijing.volces.com` 会被 CORS 拦截（实测 OPTIONS 预检返回
> `net::ERR_FAILED`，与 key 是否有效无关）。所以页面里的请求统一打到
> `/api/ark`，由云函数在服务端转发给豆包。
> **云函数不存任何密钥**——用户的 key 存在他自己浏览器里，随请求带过去。
> 费用仍由用户自己承担。

> **为什么不用 Cloudflare Workers？**
> 已实测 `workers.dev`、`vercel.app` 在国内解析到被污染的假 IP
> （如 `67.228.235.93`，IPv6 段含 `face:b00c`），curl 与浏览器均报连接超时，
> 对国内用户完全不可用。所以改用腾讯云。

## 第 0 步：部署代理（腾讯云 SCF 云函数）

1. 登录 [腾讯云云函数 SCF 控制台](https://console.cloud.tencent.com/scf/list?rid=4)
   （地域选**上海**，命名空间选 **default**；有免费额度，不用买服务器）
2. 新建函数：名称 `ark-proxy`，运行时 **Node.js 20.19**，空白模板
3. 创建后进「函数代码」，把 [scf/index.js](scf/index.js) 的全文
   粘贴覆盖 `index.js` → **部署**
4. 左侧「函数 URL」→ **新建函数 URL**：公网访问启用、授权类型**开放**、
   参数兼容启用、CORS 不勾 → 得到形如
   `https://1490422137-xxxxxx.ap-shanghai.tencentscf.com` 的地址
5. **回填到代码里**（这一步漏了，识别一定失败）：
   打开 `js/app.js`，把新地址填进 `ARK_PROXY_BASE`：
   ```js
   const ARK_PROXY_BASE = 'https://1490422137-xxxxxx.ap-shanghai.tencentscf.com';
   ```
   ⚠️ 顺序别搞反：代码里是 `ARK_PROXY_BASE + '/api/ark'`，所以这里
   **只填域名，不要带上 `/api/ark`**。

> ⚠️ **注意**：函数 URL 绑定的是该函数的版本（新建时选 $LATEST 即可，
> 以后改代码部署到 $LATEST 立即生效，无需发布正式版本）。
> 另外账号里可能存在 CloudBase（tcb.cloud.tencent.com）环境的同名函数，
> 那是历史遗留副本；**函数 URL 只在 SCF 控制台管理**，别改错对象。

### 第 0.5 步：配置防滥用环境变量（建议做）

函数 URL 是公网可访问的，代码里已经带了三道防线：**来源白名单 + IP/Key 限流 + 请求体上限**。
在 SCF 控制台「函数配置 → 编辑 → 环境变量」里添加：

| 变量名 | 建议值 | 作用 |
|---|---|---|
| `ALLOWED_ORIGINS` | `https://zpl-essie.github.io,http://localhost:3000` | 只允许你的站点调用，挡掉别的网站拿本函数当代理 |
| `RATE_MAX_PER_IP` | `30` | 每 IP 每分钟请求上限 |
| `RATE_MAX_PER_KEY` | `60` | 每把 key 每分钟请求上限 |
| `MAX_BODY_BYTES` | `1048576` | 请求体上限（1MB） |
| `DEBUG` | 不设置 | 只有设为 `1` 才开放 `?debug=1` 和 `?slowtest=` 调试路由 |

> 换部署域名后，`ALLOWED_ORIGINS` 和 `js/app.js` 里的 `ARK_PROXY_BASE`、`index.html` 里的
> CSP `connect-src` 三处必须同步修改，否则请求会被拦。
>
> 代码里的限流只在单个函数实例内生效、实例间不共享。要更硬的兜底，在「函数 URL / API 网关」
> 层再配一次限流和配额。

## 一次性配置

1. **创建 GitHub 仓库**
   - 仓库名建议 `words`
   - 设为 **public**（私有仓库的 Pages 收费）
   - 不要勾选 "Add README"（避免与本地冲突）

2. **上传项目**
   - 在 `c:\Users\zpl\Desktop\trae_projects\words\` 目录下：
   ```bash
   git init
   git add .
   git commit -m "v1.0 拍拍学首版"
   git branch -M main
   git remote add origin https://github.com/zpl-Essie/words.git
   git push -u origin main
   ```
   - 如果是网页拖拽上传：把 `words/` 内**所有文件**拖到 GitHub 仓库根目录（不是把整个 words 文件夹拖进去，否则路径会嵌套）

3. **开启 Pages**
   - 仓库 Settings → Pages
   - Source 选 **Deploy from a branch**
   - Branch 选 **main**，目录选 **/(root)**
   - 点 Save，等 1-2 分钟

4. **访问**
   - URL：`https://zpl-essie.github.io/words/`
   - 第一次打开会弹"设置 API key"页（因为还没填）

5. **填 key**
   - 去 [火山引擎](https://www.volcengine.com/product/ark) 注册 → 开通"视觉大模型" → 创建 API Key → 复制（形如 `ark-xxxxxxxx`）
   - 全部在**控制台 → API Key 管理**里操作；新用户有免费额度，先别充值就能测
   - 回到网页 → 设置页 → 粘贴 → 保存

6. **加桌面图标（PWA）**
   - iOS Safari 打开 URL → 分享按钮 → "添加到主屏幕"
   - Android Chrome 打开 URL → 右上角菜单 → "安装应用" / "添加到主屏幕"
   - 桌面出现"拍拍学"图标，点开就是全屏 app 体验

## 后续更新代码

```bash
# 改完代码后
git add .
git commit -m "v1.1 xxx 修改"
git push
# 等 1-2 分钟刷新页面
```

⚠️ **SW 缓存陷阱**：PWA 用 Service Worker 缓存，更新后**关掉浏览器后台再重开**才能看到新版本（手机和电脑都一样）。

如需强制清除：在设置页 → 开发者工具 → Application → Service Workers → Unregister。

## 本地调试

```bash
cd c:\Users\zpl\Desktop\trae_projects\words
npx serve .
# 浏览器打开 http://localhost:3000
```

⚠️ Service Worker 在 localhost 下功能有限，HTTPS（GitHub Pages）才能完整体验 PWA。

## 文件清单

```
words/
├── index.html              # 主页面（首页 + 识别结果 + 设置）
├── css/style.css           # 全部样式
├── js/app.js               # 主逻辑：拍照 / 调豆包 / 圈画 / 查词
├── data/dict.json          # 250+ 日常物品词典（中文 → 英文）
├── scf/index.js            # 腾讯云 SCF 云函数代理（不部署到 Pages，单独贴到 SCF 控制台）
├── manifest.webmanifest    # PWA 配置
├── sw.js                   # Service Worker（缓存）
├── icon.svg                # PWA 图标
├── .gitignore              # 忽略 node_modules / .env 等
├── PRD.md                  # 产品需求文档（部署时保留，对功能无影响）
├── smoke.js                # 烟测脚本（不部署也行）
└── deploy-github-pages.md  # 本文档
```

## 第一次使用的引导流程

1. 朋友扫码 / 浏览器打开你的 URL
2. 自动弹出"设置"页（因为没 key）
3. 他点链接去火山引擎注册
4. 拿到 key 回来粘贴 → 保存
5. 回到首页 → 拍照 / 选图 → 体验

整个过程 5-10 分钟。**你的 API 费用完全由用户自己承担**。
