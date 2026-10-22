# Momo 本地视频解析服务（Windows / Termux）

目标：先把平台视频下载到本机缓存，再播放本地文件，避免依赖平台网页播放器。Windows 与 Android Termux 使用同一套 Python API。该服务内置两个独立解析引擎：`parse-video-py`（覆盖多个中文短视频分享链接）和 `yt-dlp`（平台提取器/下载器）。默认 `auto` 先试 parse-video-py，失败后自动回退 yt-dlp；也可在「一起看」设置中锁定某一个引擎。该服务是可选的本地工具，不会把视频或 Cookie 上传到 Netlify/Supabase。

## Windows

1. 安装 Python 3.11 或更新版本。
2. PowerShell 进入此目录，运行 `Set-ExecutionPolicy -Scope Process Bypass`（如脚本被策略拦截）和 `./install-windows.ps1`。
3. 启动：`.\.venv\Scripts\python.exe app.py`
4. 检查 `http://127.0.0.1:8765/health`。

## Android Termux

1. 安装 Termux，执行 `bash install-termux.sh`。
2. 启动 `python app.py`，检查 `http://127.0.0.1:8765/health`。
3. 为防系统休眠中断下载，必要时执行 `termux-wake-lock` 并将 Termux 加入电池优化白名单。

Termux 服务与 Android App 私有缓存不是同一个目录；本服务返回本地下载 API 地址。浏览器/WebView 播放需要设备允许访问本机回环地址，Android WebView 的混合内容与 cleartext 策略可能影响访问。集成时优先通过原生桥将文件复制到 App 私有缓存并返回 `content://` URI，不能把 Termux 路径误当成 App 路径。

## API

- `GET /health`
- `POST /api/resolve` JSON：`{"url":"https://...","quality":"best","engine":"auto"}`；质量可选 `best/1080/720/480/360`，引擎可选 `auto/parse-video-py/yt-dlp`。响应中的 `engine` 字段表示实际成功使用的引擎。
- `GET /api/videos/{id}` 播放/读取缓存视频
- `DELETE /api/videos/{id}` 删除缓存
- 可选请求头 `X-Resolver-Token` 对应环境变量 `VIDEO_RESOLVER_TOKEN`。

默认仅监听 `127.0.0.1`，不要无保护地绑定公网或局域网。需要远程访问时设置强随机 token、限制网络访问并只允许可信来源。服务会拒绝明显内网/本机 URL，避免成为 SSRF 代理。Cookie 只接受用户主动提供的 Netscape 格式文本，仅用于当前下载任务，结束后临时文件即删除；不要把 Cookie 发给不可信服务。

## 限制

yt-dlp 只能处理平台当前允许访问且工具支持的内容。会员/登录限制、地区限制、签名变更、DRM 或平台策略可能导致失败；本工具不会绕过 DRM、付费墙或访问控制。遵守平台条款和内容版权。大文件需要足够磁盘空间；播放后可调用 DELETE 清理。
