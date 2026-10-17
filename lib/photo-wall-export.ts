import { loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { fallbackPlacement } from "@/components/photo-wall/photo-wall-canvas";
import type { PhotoWallFrameStyle, PhotoWallPhoto, PhotoWallPlacement } from "@/lib/photo-wall-storage";

/**
 * 把整面照片墙绘制成一张 PNG。
 * 走 canvas 重绘而不是对 DOM 截图：避免受滚动位置、屏幕尺寸、PWA 缩放的干扰，
 * 导出结果始终是同一张高分辨率图。
 */

const BASE_PHOTO_RATIO = 0.3;

const FRAME_PADDING: Record<PhotoWallFrameStyle, { x: number; y: number; bottom: number }> = {
  polaroid: { x: 0.055, y: 0.045, bottom: 0.16 },
  thin: { x: 0.018, y: 0.018, bottom: 0.03 },
  wood: { x: 0.05, y: 0.05, bottom: 0.09 },
  tape: { x: 0.03, y: 0.03, bottom: 0.06 },
  none: { x: 0, y: 0, bottom: 0 },
};

const FRAME_BG: Record<PhotoWallFrameStyle, string> = {
  polaroid: "#fffdf8",
  thin: "#f6f1e6",
  wood: "#a97c52",
  tape: "#fbf6ea",
  none: "transparent",
};

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = src;
  });
}

/** 按 object-fit: cover 的方式把图片画进目标框，保持比例不拉伸。 */
function drawCover(context: CanvasRenderingContext2D, image: HTMLImageElement, x: number, y: number, width: number, height: number) {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (!iw || !ih) return;
  const scale = Math.max(width / iw, height / ih);
  const drawWidth = iw * scale;
  const drawHeight = ih * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

export type ExportOptions = { width?: number; background?: string };

/** 返回 PNG 的 dataURL；没有任何照片时返回 null。 */
export async function renderPhotoWallPng(photos: PhotoWallPhoto[], options: ExportOptions = {}): Promise<string | null> {
  if (!photos.length) return null;
  const width = Math.min(3200, Math.max(720, Math.round(options.width ?? 1600)));
  const height = Math.round(width * 1.25);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return null;

  // 墙面底色 + 细微纹理
  context.fillStyle = options.background || "#f7f1e6";
  context.fillRect(0, 0, width, height);
  const glow = context.createRadialGradient(width * 0.5, height * 0.1, 0, width * 0.5, height * 0.1, width);
  glow.addColorStop(0, "rgba(255,255,255,.75)");
  glow.addColorStop(1, "rgba(232,222,205,.55)");
  context.fillStyle = glow;
  context.fillRect(0, 0, width, height);

  const ordered = photos.slice().sort((a, b) => (a.placement?.z ?? 0) - (b.placement?.z ?? 0));
  const placements: PhotoWallPlacement[] = ordered.map((photo, index) => photo.placement ?? fallbackPlacement(index));

  // 并行取图，失败的照片画一个占位框而不是整张导出失败
  const images = await Promise.all(ordered.map(async photo => {
    const url = await loadMediaObjectUrl(photo.mediaRef).catch(() => "");
    if (!url) return null;
    const image = await loadImage(url);
    URL.revokeObjectURL(url);
    return image;
  }));

  for (let index = 0; index < ordered.length; index += 1) {
    const photo = ordered[index];
    const placement = placements[index];
    const frame = placement.frame;
    const pad = FRAME_PADDING[frame];
    const frameWidth = BASE_PHOTO_RATIO * placement.scale * width;
    // 相框高度 = 图片区（正方形）+ 上下留白
    const innerSize = frameWidth * (1 - pad.x * 2);
    const frameHeight = innerSize + frameWidth * (pad.y + pad.bottom);

    context.save();
    context.translate(placement.x * width, placement.y * height);
    context.rotate((placement.rotation * Math.PI) / 180);

    // 阴影
    context.shadowColor = "rgba(70,55,38,0.22)";
    context.shadowBlur = frameWidth * 0.08;
    context.shadowOffsetY = frameWidth * 0.03;

    // 相框底
    const frameColor = placement.frameColor || FRAME_BG[frame];
    if (frame === "none") {
      roundedRect(context, -innerSize / 2, -innerSize / 2, innerSize, innerSize, innerSize * 0.04);
    } else {
      roundedRect(context, -frameWidth / 2, -frameHeight / 2, frameWidth, frameHeight, frameWidth * 0.02);
      context.fillStyle = frameColor || "#fffdf8";
      context.fill();
    }
    context.shadowColor = "transparent";
    context.shadowBlur = 0;
    context.shadowOffsetY = 0;

    // 图片
    const imageX = -innerSize / 2;
    const imageY = -frameHeight / 2 + frameWidth * pad.y;
    context.save();
    roundedRect(context, imageX, imageY, innerSize, innerSize, frame === "none" ? innerSize * 0.04 : 2);
    context.clip();
    context.fillStyle = "#e7dfd2";
    context.fillRect(imageX, imageY, innerSize, innerSize);
    const image = images[index];
    if (image) drawCover(context, image, imageX, imageY, innerSize, innerSize);
    else {
      context.fillStyle = "#b08d7a";
      context.font = `${Math.round(innerSize * 0.09)}px sans-serif`;
      context.textAlign = "center";
      context.fillText("图片无法显示", 0, imageY + innerSize / 2);
    }
    context.restore();

    // 宝丽来下缘标题
    if (frame === "polaroid" && photo.title) {
      context.fillStyle = "#8d7c66";
      context.font = `${Math.round(frameWidth * 0.055)}px serif`;
      context.textAlign = "center";
      context.fillText(photo.title.slice(0, 18), 0, frameHeight / 2 - frameWidth * pad.bottom * 0.45);
    }

    // 相框级涂鸦：坐标是相对整张相框的 0~1
    for (const doodle of photo.doodles ?? []) {
      if (doodle.kind === "stroke" && doodle.points.length > 1) {
        context.strokeStyle = doodle.color;
        context.lineWidth = doodle.width * (frameWidth / 260);
        context.lineCap = "round";
        context.lineJoin = "round";
        context.beginPath();
        doodle.points.forEach((point, pointIndex) => {
          const px = -frameWidth / 2 + point.x * frameWidth;
          const py = -frameHeight / 2 + point.y * frameHeight;
          if (pointIndex === 0) context.moveTo(px, py);
          else context.lineTo(px, py);
        });
        context.stroke();
      } else if (doodle.kind === "sticker" && doodle.content) {
        const point = doodle.points[0] ?? { x: 0.5, y: 0.5 };
        context.font = `${Math.round(frameWidth * 0.18)}px sans-serif`;
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(doodle.content, -frameWidth / 2 + point.x * frameWidth, -frameHeight / 2 + point.y * frameHeight);
        context.textBaseline = "alphabetic";
      }
    }

    context.restore();
  }

  return canvas.toDataURL("image/png");
}

/** 导出并触发下载，返回是否成功触发。 */
export async function downloadPhotoWallPng(photos: PhotoWallPhoto[], options: ExportOptions = {}): Promise<boolean> {
  const dataUrl = await renderPhotoWallPng(photos, options);
  if (!dataUrl) return false;
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = `照片墙-${new Date().toISOString().slice(0, 10)}.png`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return true;
}
