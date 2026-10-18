import {
  DEFAULT_PHOTO_WALL_WORLD,
  type PhotoWallDoodle,
  type PhotoWallPlacement,
  type PhotoWallState,
  type PhotoWallWorld,
} from "@/lib/photo-wall-storage";

/**
 * 无界画布的扩容算法。
 *
 * 设计前提：照片和涂鸦的坐标一直是「占当前的世界的比例」（0~1），
 * 所以扩大世界时只要把比例按像素位置重算一遍，画面上什么都不会动——
 * 不需要迁移任何老数据，也不影响摆放模板和整墙导出。
 *
 * 只在「照片落点 / 一笔画完」时调用，拖动过程中不扩容：
 * 一来避免每帧重映射全部照片，二来扩容后落点会自动回到安全区，不会连环触发。
 */

/** 落点进入世界外圈这个比例时，就朝那一侧扩。 */
const EDGE_TRIGGER = 0.07;
/** 单次至少扩这么多像素，避免贴着边一点点挤。 */
const MIN_GROW_PX = 900;
/** 单次至少扩当前尺寸的这个比例。 */
const GROW_RATIO = 0.4;

export type WorldGrow = {
  world: PhotoWallWorld;
  /** 新增到左/上侧的像素。滚动位置要补偿这么多，画面才不会跳。 */
  left: number;
  top: number;
  prevWidth: number;
  prevHeight: number;
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function wallWorldOf(state: PhotoWallState): PhotoWallWorld {
  return state.world ?? DEFAULT_PHOTO_WALL_WORLD;
}

/** 检查一组 0~1 的点是否贴边；需要扩容时返回新世界与偏移，否则返回 null。 */
export function planWorldGrow(world: PhotoWallWorld, points: readonly { x: number; y: number }[]): WorldGrow | null {
  if (!points.length) return null;
  let minX = 1;
  let minY = 1;
  let maxX = 0;
  let maxY = 0;
  let seen = false;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    seen = true;
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  if (!seen) return null;

  const stepX = Math.max(MIN_GROW_PX, Math.round(world.width * GROW_RATIO));
  const stepY = Math.max(MIN_GROW_PX, Math.round(world.height * GROW_RATIO));
  const left = minX < EDGE_TRIGGER ? stepX : 0;
  const right = maxX > 1 - EDGE_TRIGGER ? stepX : 0;
  const top = minY < EDGE_TRIGGER ? stepY : 0;
  const bottom = maxY > 1 - EDGE_TRIGGER ? stepY : 0;
  if (!left && !right && !top && !bottom) return null;

  return {
    world: { width: world.width + left + right, height: world.height + top + bottom },
    left,
    top,
    prevWidth: world.width,
    prevHeight: world.height,
  };
}

function remapX(x: number, grow: WorldGrow): number {
  return clamp01((x * grow.prevWidth + grow.left) / grow.world.width);
}

function remapY(y: number, grow: WorldGrow): number {
  return clamp01((y * grow.prevHeight + grow.top) / grow.world.height);
}

/** 照片摆放跟着世界重映射；尺寸/旋转/层级不变。 */
export function remapPlacement(placement: PhotoWallPlacement, grow: WorldGrow): PhotoWallPlacement {
  return { ...placement, x: remapX(placement.x, grow), y: remapY(placement.y, grow) };
}

/** 整墙涂鸦重映射。照片自己的涂鸦是相对相框的，不受世界扩容影响。 */
export function remapDoodles(doodles: readonly PhotoWallDoodle[], grow: WorldGrow): PhotoWallDoodle[] {
  return doodles.map(doodle => ({
    ...doodle,
    points: doodle.points.map(point => ({ x: remapX(point.x, grow), y: remapY(point.y, grow) })),
  }));
}

/** 一次性把整个世界（尺寸 + 所有照片 + 整墙涂鸦）搬到扩容后的坐标系。 */
export function applyWorldGrow(state: PhotoWallState, grow: WorldGrow): PhotoWallState {
  return {
    ...state,
    world: grow.world,
    photos: state.photos.map(photo => photo.placement ? { ...photo, placement: remapPlacement(photo.placement, grow) } : photo),
    wallDoodles: state.wallDoodles ? remapDoodles(state.wallDoodles, grow) : state.wallDoodles,
  };
}
