from __future__ import annotations

import asyncio
import os
import secrets
import shutil
import socket
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import yt_dlp
from fastapi import FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

ROOT = Path(os.environ.get("VIDEO_RESOLVER_CACHE", Path.home() / ".momo-video-cache")).expanduser().resolve()
ROOT.mkdir(parents=True, exist_ok=True)
MAX_BYTES = max(50, int(os.environ.get("VIDEO_RESOLVER_MAX_MB", "2048"))) * 1024 * 1024
API_TOKEN = os.environ.get("VIDEO_RESOLVER_TOKEN", "").strip()
HOST = os.environ.get("VIDEO_RESOLVER_HOST", "127.0.0.1")
PORT = int(os.environ.get("VIDEO_RESOLVER_PORT", "8765"))
JOBS: dict[str, dict] = {}
LOCK = asyncio.Lock()
app = FastAPI(title="Momo local video resolver", version="1.0.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False, allow_methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "Authorization", "X-Resolver-Token"])

class ResolveRequest(BaseModel):
    url: str = Field(min_length=8, max_length=4096)
    quality: str = Field(default="best", pattern="^(best|1080|720|480|360)$")
    engine: str = Field(default="auto", pattern="^(auto|parse-video-py|yt-dlp)$")
    cookies: str | None = Field(default=None, max_length=200000)

def authorize(token: str | None):
    if API_TOKEN and not secrets.compare_digest(token or "", API_TOKEN):
        raise HTTPException(401, "本地视频解析服务令牌不正确")

def validate_url(value: str) -> str:
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(400, "只支持 http/https 视频链接")
    host = parsed.hostname.lower().rstrip(".")
    if host in ("localhost",) or host.endswith(".localhost") or host.endswith(".local"):
        raise HTTPException(400, "不允许访问本机或局域网地址")
    try:
        for result in socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM):
            ip = result[4][0]
            import ipaddress
            addr = ipaddress.ip_address(ip)
            if not addr.is_global:
                raise HTTPException(400, "不允许解析内网或保留地址")
    except HTTPException:
        raise
    except OSError:
        raise HTTPException(400, "无法解析链接域名")
    return value.strip()

def ydl_options(outtmpl: str, quality: str, cookiefile: str | None = None):
    height = {"1080": 1080, "720": 720, "480": 480, "360": 360}.get(quality)
    # DASH platforms (notably Bilibili) often separate video and audio. Merge them
    # when FFmpeg exists; keep a single-file fallback for minimal Windows installs.
    if shutil.which("ffmpeg"):
        fmt = (
            f"bestvideo[height<={height}]+bestaudio/best[height<={height}]/best"
            if height else "bestvideo*+bestaudio/best"
        )
    else:
        fmt = f"best[height<={height}]/best" if height else "best"
    return {
        "format": fmt,
        "outtmpl": outtmpl,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "retries": 3,
        "fragment_retries": 3,
        "socket_timeout": 25,
        "max_filesize": MAX_BYTES,
        "merge_output_format": "mp4",
        "cookiefile": cookiefile,
        "http_headers": {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"},
    }

def cleanup_old():
    cutoff = time.time() - 24 * 3600
    total = 0
    for path in sorted(ROOT.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0):
        if not path.is_file():
            continue
        try:
            if path.stat().st_mtime < cutoff or total > MAX_BYTES:
                path.unlink(missing_ok=True)
            else:
                total += path.stat().st_size
        except OSError:
            pass

@app.get("/health")
def health():
    return {"ok": True, "service": "momo-video-resolver", "version": "1.1.0", "engines": ["parse-video-py", "yt-dlp"], "cache_mb": round(sum(p.stat().st_size for p in ROOT.iterdir() if p.is_file()) / 1048576, 1)}

@app.post("/api/resolve")
async def resolve(body: ResolveRequest, x_resolver_token: str | None = Header(default=None)):
    authorize(x_resolver_token)
    url = validate_url(body.url)
    job_id = secrets.token_urlsafe(12)
    async with LOCK:
        JOBS[job_id] = {"state": "downloading", "message": "正在获取视频并保存到本地", "created": time.time()}
    tempdir = Path(tempfile.mkdtemp(prefix="momo-", dir=ROOT))
    cookie_path = None
    try:
        if body.cookies and body.cookies.strip():
            # User-supplied Netscape cookie file only; never persist it after this job.
            cookie_path = tempdir / "cookies.txt"
            cookie_path.write_text(body.cookies, encoding="utf-8")
        output = str(tempdir / "video.%(ext)s")
        opts = ydl_options(output, body.quality, str(cookie_path) if cookie_path else None)
        failures: list[str] = []
        if body.engine == "auto":
            host = (urlparse(url).hostname or "").lower().removeprefix("www.")
            # parse-video-py is strongest on Chinese short-video share links. For
            # Bilibili/YouTube/long-form sites, yt-dlp must get the original page
            # so it can select matching audio/video tracks instead of downloading
            # a silent video-only URL returned by a generic share parser.
            parse_first_hosts = (
                "douyin.com", "iesdouyin.com", "kuaishou.com", "gifshow.com",
                "xiaohongshu.com", "xhslink.com", "pipix.com", "huoshan.com",
                "ixigua.com", "weishi.qq.com", "zuiyou.com",
            )
            parse_first = any(host == domain or host.endswith("." + domain) for domain in parse_first_hosts)
            engines = ["parse-video-py", "yt-dlp"] if parse_first else ["yt-dlp", "parse-video-py"]
        else:
            engines = [body.engine]

        engine_used = ""
        for engine in engines:
            try:
                if engine == "parse-video-py":
                    direct_url = await asyncio.to_thread(_parse_with_parse_video_py, url)
                    if not direct_url:
                        raise RuntimeError("parse-video-py 未返回 video_url")
                    # Do not let a third-party parser turn this local service into
                    # a downloader for private/internal addresses.
                    direct_url = validate_url(direct_url)
                    direct_opts = dict(opts)
                    direct_opts["http_headers"] = {
                        **direct_opts.get("http_headers", {}),
                        "Referer": url,
                    }
                    await asyncio.to_thread(_download, direct_url, direct_opts)
                else:
                    await asyncio.to_thread(_download, url, opts)
                engine_used = engine
                break
            except Exception as exc:
                failures.append(engine + ": " + str(exc)[:180])
                for partial in tempdir.glob("video.*"):
                    partial.unlink(missing_ok=True)
        if not engine_used:
            raise RuntimeError("所有解析引擎均失败。 " + "；".join(failures))
        media = next((p for p in tempdir.iterdir() if p.is_file() and p.name != "cookies.txt" and p.stat().st_size > 1024), None)
        if media is None:
            raise RuntimeError("解析引擎没有返回可播放的视频文件。 " + "；".join(failures))
        if media.stat().st_size > MAX_BYTES:
            raise RuntimeError("视频超过本地缓存大小限制")
        suffix = media.suffix.lower()
        if suffix not in (".mp4", ".webm", ".mkv", ".mov", ".m4v"):
            raise RuntimeError(f"暂不支持该平台输出格式：{suffix or '未知'}")
        final = ROOT / f"{job_id}{suffix}"
        media.replace(final)
        async with LOCK:
            JOBS[job_id] = {"state": "ready", "file": final.name, "title": final.stem, "size": final.stat().st_size, "engine": engine_used, "created": time.time()}
        cleanup_old()
        return {"ok": True, "id": job_id, "title": final.stem, "size": final.stat().st_size, "mime": "video/mp4" if suffix in (".mp4", ".m4v") else "video/" + suffix[1:], "engine": engine_used, "downloadUrl": f"/api/videos/{job_id}"}
    except HTTPException:
        raise
    except Exception as exc:
        async with LOCK:
            JOBS[job_id] = {"state": "failed", "message": str(exc)[:500], "created": time.time()}
        raise HTTPException(422, f"解析或下载失败：{str(exc)[:300]}") from exc
    finally:
        shutil.rmtree(tempdir, ignore_errors=True)

def _parse_with_parse_video_py(url: str) -> str:
    """Use parse-video-py as an independent resolver, returning its direct media URL."""
    import asyncio as _asyncio
    from parse_video_py import parse_video_share_url

    result = _asyncio.run(parse_video_share_url(url))
    if result is None:
        raise RuntimeError("没有解析结果")
    if isinstance(result, dict):
        media_url = result.get("video_url") or result.get("url")
    else:
        media_url = getattr(result, "video_url", None) or getattr(result, "url", None)
    if not isinstance(media_url, str) or not media_url.startswith(("http://", "https://")):
        raise RuntimeError("解析结果中没有有效 video_url")
    return media_url

def _download(url: str, options: dict):
    with yt_dlp.YoutubeDL(options) as ydl:
        ydl.download([url])

@app.get("/api/videos/{job_id}")
def get_video(job_id: str):
    # The high-entropy job id is a short-lived capability URL; HTML video elements cannot attach custom auth headers.
    record = JOBS.get(job_id)
    if not record or record.get("state") != "ready":
        raise HTTPException(404, "本地缓存不存在或已清理")
    path = (ROOT / record["file"]).resolve()
    if path.parent != ROOT or not path.is_file():
        raise HTTPException(404, "本地视频已删除")
    return FileResponse(path, media_type="video/mp4" if path.suffix.lower() in (".mp4", ".m4v") else "application/octet-stream", filename=path.name, content_disposition_type="inline")

@app.delete("/api/videos/{job_id}")
def delete_video(job_id: str, x_resolver_token: str | None = Header(default=None)):
    authorize(x_resolver_token)
    record = JOBS.pop(job_id, None)
    if record and record.get("file"):
        (ROOT / record["file"]).unlink(missing_ok=True)
    return {"ok": True, "deleted": bool(record)}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)
