/**
 * 感知系统：把手机自身状态变成角色能感知的「现实信号」。
 *
 * 定位（改代码前先读）：
 *   原生（android-shell/PerceptionBridge.kt）只负责「读值」；
 *   本目录负责「值的变化算不算一个事件、多久报一次、报给谁」。
 *   这样阈值与开关随网页部署即时生效，不必为调一个数字重编 APK。
 *
 * 信号出口只有一个：现实桥 processBridgeItem()。
 *   复用已有的规则引擎（匹配 → 加工 → 聊天/记忆/通知/…）与冷却、流水。
 *   刻意不新建平行系统——否则每加一个能力就要重写一遍投递逻辑。
 */

/**
 * 一条应用使用记录（屏幕使用时间）。
 *
 * 定义在这里而不是 bridge.ts：bridge 已经 import 本文件，反向再 import 会构成
 * 循环依赖（虽然 import type 编译后会被擦除，但依赖方向应当单向）。
 */
export type AppUsageEntry = {
  /** 包名，如 com.tencent.mm */
  package: string;
  /** 应用显示名（原生翻译好；取不到为空串，调用方退回包名） */
  label: string;
  /** 今天前台使用了多少分钟 */
  minutes: number;
};

/** 感知能力标识。与原生 capabilitiesJson() 的键一一对应。 */
export type PerceptionCapability =
  | "battery"
  | "network"
  | "foregroundApp"
  | "location"
  | "calendar"
  | "contacts"
  | "usageStats"
  | "steps"
  | "sleep"
  | "returnToPhone";

export const PERCEPTION_CAPABILITY_LABEL: Record<PerceptionCapability, string> = {
  battery: "电量与充电",
  network: "网络状态",
  foregroundApp: "前台应用",
  location: "位置",
  calendar: "系统日历",
  contacts: "联系人",
  usageStats: "使用统计",
  steps: "步数",
  sleep: "睡眠",
  returnToPhone: "回到手机提醒",
};

export const PERCEPTION_CAPABILITY_DESC: Record<PerceptionCapability, string> = {
  battery: "电量跌破阈值、开始或结束充电时告诉角色。",
  network: "在 WiFi 与移动网络之间切换时告诉角色（可作为「出门了」「到家了」的粗线索）。",
  foregroundApp: "某个应用连续使用超过设定时长时告诉角色。需要开启无障碍服务。",
  location: "到达或离开某个位置时告诉角色。需要位置权限。",
  calendar: "日程开始前提醒。需要读取系统日历。",
  contacts: "来电或消息可识别为具体的人。需要读取联系人。",
  usageStats: "汇总当天各应用使用时长。需要「使用情况访问」权限。",
  steps: "读取当天步数，作为「在走动 / 宅着」的粗线索。需要活动识别权限。",
  sleep: "读取最近一觉的时长与起止。只读睡眠，不含睡眠分期；数据来自 Health Connect。",
  returnToPhone: "离开一段时间后回到小手机时，给角色一个「TA 回来了」的信号。纯网页实现，无需额外权限。",
};

export type PerceptionConfig = {
  /** 总开关：关掉后引擎停止采样，且不再产生任何信号。 */
  enabled: boolean;
  /** 逐能力开关。缺失视为开启（用户没动过就按默认可用来），仅显式 false 视为关闭。 */
  capabilities: Partial<Record<PerceptionCapability, boolean>>;
  /** 采样间隔（秒）。原生读值很便宜，但没必要太频繁。 */
  sampleSeconds: number;
  /** 电量变化达到多少个百分点才产生信号（防止每 1% 都报）。 */
  batteryStepPercent: number;
  /** 前台应用连续使用多少分钟才产生信号。 */
  appDwellMinutes: number;
  /** 全局限流：每小时最多产生多少条信号（保护 token 预算）。 */
  hourlyLimit: number;
  /** 是否遵守推送安静时段（复用已有设置，夜里不打扰）。 */
  respectQuietHours: boolean;
  /** 电量跌到这个百分比以下才报「电量偏低」。取代原先硬编码的 20。 */
  batteryLowPercent: number;
  /** 离开后回到小手机时，是否产生一条「回到手机」信号（配了规则角色才会搭话）。 */
  returnSignalEnabled: boolean;
  /** 离开多久才算「离开过」（分钟）。低于此值不计，防止切一下微信回来就触发。 */
  returnAwayMinutes: number;
  /** 「回到手机」信号的最小间隔（分钟），防止反复切前后台刷屏。 */
  returnCooldownMinutes: number;
  /** 每轮对话前是否把当前设备状态悄悄注入角色上下文。默认关，会占 token。 */
  injectStatus: boolean;
  /** 同一角色两次「查看TA的手机」之间的最小间隔（分钟），间隔内直接返回缓存。 */
  queryCooldownMinutes: number;
  /** 是否把聚合后的设备快照同步到云端，供角色离线生成时参考。默认关。 */
  cloudSyncEnabled: boolean;
};

export const PERCEPTION_DEFAULTS: PerceptionConfig = {
  enabled: true,
  capabilities: {},
  sampleSeconds: 60,
  batteryStepPercent: 5,
  appDwellMinutes: 20,
  hourlyLimit: 12,
  respectQuietHours: true,
  batteryLowPercent: 20,
  returnSignalEnabled: true,
  returnAwayMinutes: 5,
  returnCooldownMinutes: 15,
  injectStatus: false,
  queryCooldownMinutes: 5,
  cloudSyncEnabled: false,
};

export const PERCEPTION_LIMITS = {
  sampleSeconds: { min: 20, max: 600 },
  batteryStepPercent: { min: 1, max: 50 },
  appDwellMinutes: { min: 2, max: 180 },
  hourlyLimit: { min: 1, max: 60 },
  batteryLowPercent: { min: 1, max: 99 },
  returnAwayMinutes: { min: 1, max: 720 },
  returnCooldownMinutes: { min: 0, max: 720 },
  queryCooldownMinutes: { min: 0, max: 720 },
} as const;

/** 一条待投递的感知信号。type 直接写成人类可读的事件名，规则里 matchType 就能匹配。 */
export type PerceptionSignal = {
  /** 事件名，如「电量低」「充电开始」「离开 WiFi」「使用应用」。规则按它匹配。 */
  type: string;
  /** 事件正文，如「15%」「微信」。会进入规则加工与聊天。 */
  payload: string;
  /** 产生这条信号的能力，用于限流分类与流水展示。 */
  capability: PerceptionCapability;
};

/** 流水里的一条记录（本机留存，供「感知 → 记录」面板展示）。 */
export type PerceptionLogEntry = {
  id: string;
  at: string;
  capability: PerceptionCapability;
  type: string;
  payload: string;
  /** 投递结果摘要，如「写入聊天并生成回应」「仅存档（无匹配规则）」 */
  outcome: string;
  /** 被哪一层拦下（未投递时才有），如「低于阈值」「触发间隔内」「每小时上限」 */
  skipped?: string;
};

/** 设备状态缓存：引擎每次采样后写入，供「注入 / 主动查询 / 云端同步」三处读取。 */
export type PerceptionStatusSnapshot = {
  /** 采集时刻 */
  at: string;
  /** 电量百分比，-1 = 未知 */
  batteryPercent: number;
  charging: boolean;
  /** "wifi" | "cellular" | "none" 等 */
  networkType: string;
  metered: boolean;
  /** 当前前台应用显示名（无权限时为空） */
  foregroundApp: string;
  /** 该应用已连续使用分钟数，0 = 未知 */
  foregroundMinutes: number;
  /** 当天步数，-1 = 未知 */
  steps: number;
  /** 今天各应用使用时长（按时长降序，最多 12 条）；空数组 = 未授权或读不到 */
  appUsage: AppUsageEntry[];
  /**
   * 最近一觉。null = 未授权 / Health Connect 不可用 / 没数据。
   *
   * 只带时长与起止，不带睡眠分期（深睡/浅睡/REM）——分期是医学化读数，
   * 角色拿它说事只会像体检报告。
   */
  sleep: SleepSnapshot | null;
  /**
   * 当前位置。null = 未授权 / 定位开关关着 / 读不到。
   *
   * 坐标已由原生降精度到约 110 米，地名只到区/街道级——「到了哪一片」
   * 足够角色说句自然的话，指认门牌不是这个功能要的东西。
   */
  location: LocationSnapshot | null;
};

/** 最近一觉（只回时长与起止，不含分期）。 */
export type SleepSnapshot = {
  /** 睡了多久（分钟） */
  minutes: number;
  /** 入睡时刻（毫秒时间戳） */
  startAt: number;
  /** 醒来时刻（毫秒时间戳） */
  endAt: number;
};

/** 一次位置读取的结果（已降精度）。 */
export type LocationSnapshot = {
  /** 纬度（约 110 米精度） */
  lat: number;
  /** 经度（约 110 米精度） */
  lon: number;
  /** 定位精度（米），0 = 未知 */
  accuracy: number;
  /** 粗粒度地名（区/街道级）；空串 = 反查没成功，坐标仍可用 */
  place: string;
};

/** 诊断面板用的一次性状态快照。 */
export type PerceptionDiagnostics = {
  /** 是否在安卓壳内（普通浏览器为 false）。 */
  inShell: boolean;
  /** 壳是否提供了感知桥（老 APK 没有）。 */
  bridgeAvailable: boolean;
  /** 引擎是否在运行。 */
  running: boolean;
  /** 壳上报的可用能力（原生如实回答，不撒谎）。 */
  nativeCapabilities: Partial<Record<PerceptionCapability, boolean>>;
  /** 无障碍服务是否已开启（前台应用感知的前提）。 */
  accessibility: boolean;
  /** 最近一次采样时间。 */
  lastSampleAt: string;
  /** 最近一次取值快照（电量/网络原文），故障排查用。 */
  lastSnapshot: string;
  /** 最近一次采样的可读设备状态（面板展示「角色会看到什么」）。 */
  status: PerceptionStatusSnapshot;
  /** 本小时已用信号数 / 上限。 */
  hourlyUsed: number;
  hourlyLimit: number;
  /** 无匹配规则时产生的信号数（提示用户「信号有，但你没配规则」）。 */
  unmatchedSignals: number;
  /** 实时读一次今天各应用使用时长（诊断面板展示「角色能读到什么」）。 */
  appUsage: AppUsageEntry[];
  /** 实时读一次当前位置（null = 读不到）。 */
  location: LocationSnapshot | null;
  /** 实时读一次最近一觉（null = 读不到）。 */
  sleep: SleepSnapshot | null;
  /** 健康桥的内部状态（取数次数、最近失败原因）。 */
  healthDiagnostics: HealthDiagnostics | null;
  /** 位置桥的内部状态（取点次数、最近失败原因）。 */
  locationDiagnostics: LocationDiagnostics | null;
};

/** 健康桥上报的内部状态（诊断用，不含睡眠内容）。 */
export type HealthDiagnostics = {
  /** Health Connect 能不能用 */
  available?: boolean;
  /** 睡眠读取权限给没给 */
  granted?: boolean;
  /** 是否正有一次取数在进行 */
  refreshing?: boolean;
  /** 累计成功取数次数 */
  refreshCount?: number;
  /** 原生手里有没有新鲜缓存 */
  hasCache?: boolean;
  /** 缓存年龄（毫秒），-1 = 没有缓存 */
  cacheAgeMs?: number;
  /** 最近一次失败原因（空串 = 没记到失败） */
  lastError?: string;
};

/** 位置桥上报的内部状态（诊断用，不含具体坐标）。 */
export type LocationDiagnostics = {
  /** 是否正有一次取点在进行 */
  fixing?: boolean;
  /** 累计成功取点次数 */
  fixCount?: number;
  /** 原生手里有没有缓存值 */
  hasCache?: boolean;
  /** 缓存年龄（毫秒），-1 = 没有缓存 */
  cacheAgeMs?: number;
  /** 最近一次失败原因（空串 = 没记到失败） */
  lastError?: string;
};
