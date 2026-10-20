# Cloudflare Workers AI transcription bridge

This optional cloud endpoint uses Cloudflare Workers AI Whisper Large v3 Turbo for direct audio files. Once deployed, your computer does not need to stay on for supported audio URLs.

## Important boundary

This Worker does **not** extract audio from arbitrary video pages (Bilibili, YouTube, TikTok, etc.) and does not bypass login, region restrictions, DRM, or platform protections. A page URL is not an audio URL. For platform video pages, use captions you can lawfully obtain/import or the existing optional yt-dlp + FFmpeg + faster-whisper local bridge. This Worker accepts HTTPS direct audio files only, with a configured hostname allowlist and an 8 MB request limit. It is a first cloud integration, not a universal video parser.

## Deploy

1. Create a Cloudflare account and enable Workers AI for the account.
2. Install Node.js locally once. From this directory run `npm install`, then `npx wrangler login`.
3. Edit `wrangler.jsonc`:
   - Set `ALLOWED_ORIGINS` to the exact origin of your deployed phone web app (scheme + host, no path).
   - Set `ALLOWED_MEDIA_HOSTS` to the exact hostname(s) that host audio files you control or trust, comma-separated. Do not use `*`.
4. Set a long secret token:
   ```bash
   npx wrangler secret put TRANSCRIBE_TOKEN
   ```
   Paste a random token when prompted. Use the same token in the app's transcription settings. Never commit it.
5. Test locally with `npx wrangler dev`, then deploy with `npx wrangler deploy`.
6. Check `https://YOUR-WORKER.workers.dev/health`. Configure the app service address as `https://YOUR-WORKER.workers.dev` (the app adds `/transcribe` automatically).

## App use

In Watch Together, enter a **direct audio URL** (for example an authorized MP3, WAV, M4A, OGG, or audio WebM file) in the link field. Configure the deployed Worker URL and the same token, then choose “Parse link and generate script”. The Worker returns timestamped JSON segments for the app's existing script parser. Direct audio links must end in a recognized audio extension and their hostname must match `ALLOWED_MEDIA_HOSTS`.

## Limits and cost

- Audio payload limit: 8 MB per request. Use shorter clips if the file is larger.
- The endpoint transcribes audio only; it does not understand video frames or images.
- Workers AI usage is billed according to Cloudflare's current pricing and plan limits. Check the official model page: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
- The first deployment requires a one-time local Node.js/Wrangler setup, but the deployed Worker runs in Cloudflare; your computer does not need to stay on.
