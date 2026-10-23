import unittest
from unittest.mock import patch

import app


class ResolverStrategyTests(unittest.TestCase):
    def test_bilibili_uses_ytdlp_first_to_preserve_audio(self):
        self.assertEqual(app._engine_order("https://www.bilibili.com/video/BV1xx411c7mD", "auto"), ["yt-dlp", "parse-video-py"])

    def test_short_video_share_uses_parse_video_first(self):
        self.assertEqual(app._engine_order("https://v.douyin.com/example/", "auto"), ["parse-video-py", "yt-dlp"])

    def test_explicit_engine_is_not_silently_changed(self):
        self.assertEqual(app._engine_order("https://www.bilibili.com/video/BV1xx411c7mD", "parse-video-py"), ["parse-video-py"])

    def test_ffmpeg_enables_separate_audio_video_selection(self):
        with patch.object(app.shutil, "which", return_value="/usr/bin/ffmpeg"):
            options = app.ydl_options("/tmp/video.%(ext)s", "720")
        self.assertIn("bestvideo[height<=720]+bestaudio", options["format"])

    def test_no_ffmpeg_uses_single_file_fallback(self):
        with patch.object(app.shutil, "which", return_value=None):
            options = app.ydl_options("/tmp/video.%(ext)s", "720")
        self.assertEqual(options["format"], "best[height<=720]/best")


if __name__ == "__main__":
    unittest.main()
