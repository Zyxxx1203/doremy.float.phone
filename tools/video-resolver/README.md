# Momo 本地视频解析服务（Windows / Termux）

定位：这是可选的本地解析服务（Windows / Termux）。当前网页端已另有内置解析 API，优先尝试内置解析；当平台不受内置解析支持、需要本机工具链或希望在本地处理时，再配置本服务。该服务先把平台视频下载到本机缓存，再播放本地文件，避免依赖平台网页播放器。Windows 与 Android Termux 使用同一套 Python API。该服务内置两个独立解析引擎：`parse-video-py`（覆盖多个中文短视频分享链接）和 `yt-dlp`（平台提取器/下载器）。`auto` 会按平台选择顺序：抖音/快手/小红书等短视频分享链接优先 `parse-video-py`，B站/YouTube 等长视频平台优先 `yt-dlp`，失败后再尝试另一个引擎；这样可避免把 B 站分离的无声视频轨误当成完整视频。也可在「一起看」设置中锁定某一个引擎。该服务是可选的本地工具，不会把视频或 Cookie 上传到 Netlify/Supabase。

## Windows

1. 安装 Python 3.11 或更新版本。
2. PowerShell 进入此目录，运行 `Set-ExecutionPolicy -Scope Process Bypass`（如脚本被策略拦截）和 `./install-windows.ps1`。
3. 若要播放 B 站等分离视频/音频轨的平台，请另外安装 FFmpeg 并确保 `ffmpeg.exe` 在 PATH 中；安装脚本会检测并提示。缺少 FFmpeg 时会退回单文件格式，最高画质/音轨合并可能不可用。
4. 启动：`.\.venv\Scripts\python.exe app.py`
5. 检查 `http://127.0.0.1:8765/health`。

## Android Termux

先安装 Termux（建议使用官方 GitHub/F-Droid 发行版），打开后只需粘贴这一条命令，即可自动下载服务文件、安装 Python/FFmpeg/解析依赖、启动服务并检查健康状态：

```bash
curl -fsSL https://raw.githubusercontent.com/Zyxxx1203/doremy.float.phone/main/tools/video-resolver/install-termux.sh | bash
```

安装完成后可用 `momo-video-status` 检查，`momo-video-start` 启动，`momo-video-stop` 停止。程序安装在 `~/.momo-video-resolver`，日志在 `~/.momo-video-resolver/service.log`。这一步只负责当前 Termux 环境；若系统强制杀掉 Termux，重新打开后运行 `momo-video-start` 即可。需要长时间后台运行时，可执行 `termux-wake-lock` 并把 Termux 加入电池优化白名单。

Termux 服务与 Android App 私有缓存不是同一个目录；本服务返回本地下载 API 地址。APK 已配置仅允许 `localhost` / `127.0.0.1` 的 HTTP 回环访问，不会全局放开明文 HTTP；在 APK 中请将服务地址设为 `http://127.0.0.1:8765`。普通浏览器仍受浏览器自身的混合内容和 CORS 策略影响。Termux 下载缓存与 App 私有缓存相互独立，不能把 Termux 文件路径误当成 App 文件路径。

## API

- `GET /health`
- `POST /api/resolve` JSON：`{"url":"https://...","quality":"best","engine":"auto"}`；质量可选 `best/1080/720/480/360`，引擎可选 `auto/parse-video-py/yt-dlp`。响应中的 `engine` 字段表示实际成功使用的引擎。
- `GET /api/videos/{id}` 播放/读取缓存视频（视频标签无法附加自定义请求头，因此此路由使用高熵随机 job ID 作为短期访问凭据；不要公开分享播放地址）
- `DELETE /api/videos/{id}` 删除缓存
- 可选请求头 `X-Resolver-Token` 对应环境变量 `VIDEO_RESOLVER_TOKEN`。

默认仅监听 `127.0.0.1`，不要无保护地绑定公网或局域网。需要远程访问时设置强随机 token、限制网络访问并只允许可信来源。服务会拒绝明显内网/本机 URL，避免成为 SSRF 代理。Cookie 只接受用户主动提供的 Netscape 格式文本，仅用于当前下载任务，结束后临时文件即删除；不要把 Cookie 发给不可信服务。

## 限制

yt-dlp 只能处理平台当前允许访问且工具支持的内容。会员/登录限制、地区限制、签名变更、DRM 或平台策略可能导致失败；本工具不会绕过 DRM、付费墙或访问控制。遵守平台条款和内容版权。大文件需要足够磁盘空间；播放后可调用 DELETE 清理。
