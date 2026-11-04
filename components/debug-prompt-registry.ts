export type ExtraPromptAppId =
    | "checkphone"
    | "reading"
    | "dwelling"
    | "diary"
    | "notewall"
    | "xiaohongshu"
    | "cocreate"
    | "shopping"
    | "interview"
    | "adventure"
    | "life"
    | "photo_wall"
    | "checkin"
    | "watch_together"
    | "phone_widget"
    | "reality_bridge";

export type ExtraPromptAppDefinition = {
    id: ExtraPromptAppId;
    label: string;
    emptyText: string;
    snapshotOnly?: boolean;
    snapshotAppIds?: string[];
    snapshotTags?: string[];
};

export const EXTRA_PROMPT_APPS: ExtraPromptAppDefinition[] = [
    { id: "checkphone", label: "查手机", emptyText: "选择角色与查手机 APP 后点击「预览」" },
    { id: "reading", label: "阅读", emptyText: "选择角色、书籍、章节和任务后点击「预览」" },
    { id: "dwelling", label: "栖所", emptyText: "选择角色与栖所任务后点击「预览」" },
    { id: "diary", label: "日记", emptyText: "选择角色后点击「预览」查看日记 Prompt" },
    { id: "notewall", label: "便签墙", emptyText: "选择角色与便签墙任务后点击「预览」" },
    { id: "xiaohongshu", label: "小红书", emptyText: "选择角色与小红书任务后点击「预览」" },
    { id: "cocreate", label: "共创", emptyText: "选择共创模式后点击「预览」" },
    { id: "shopping", label: "购物", emptyText: "选择购物任务后点击「预览」" },
    { id: "interview", label: "在场", emptyText: "选择角色与在场任务后点击「预览」" },
    { id: "adventure", label: "冒险", emptyText: "选择角色与冒险存档后点击「预览」" },
    { id: "life", label: "生活系统", snapshotOnly: true, snapshotAppIds: ["life"], emptyText: "这里展示生活系统最近一次真实 AI 请求。先进入生活现场、日程或邀约并触发一次 AI 生成，再返回此处查看完整请求消息。" },
    { id: "photo_wall", label: "照片墙", snapshotOnly: true, snapshotAppIds: ["photo_wall"], emptyText: "这里展示照片墙最近一次真实批注/涂鸦请求。先在照片墙触发一次 AI 批注或涂鸦，再返回此处查看实际请求。" },
    { id: "checkin", label: "签到", snapshotOnly: true, snapshotAppIds: ["checkin"], emptyText: "这里展示查岗事件触发后最近一次真实角色回应请求。请先完成一次查岗（同意、拒绝、超时或失败均可），再返回查看实际 messages、指导语和动态上下文。" },
    { id: "watch_together", label: "一起看", snapshotOnly: true, snapshotAppIds: ["watch_together"], emptyText: "这里展示一起看最近一次真实陪看/观后感请求。先在一起看触发一次角色发言或观后感生成，再返回查看。" },
    { id: "phone_widget", label: "桌面小组件", snapshotOnly: true, snapshotAppIds: ["phone_widget"], emptyText: "这里展示桌面小组件最近一次真实状态生成请求。先在小组件中触发一次 AI 状态更新，再返回查看。" },
    { id: "reality_bridge", label: "现实桥梁", snapshotOnly: true, snapshotAppIds: ["reality_bridge"], emptyText: "这里展示现实桥梁最近一次真实请求。先在现实桥梁触发一次离线回复库生成，再返回查看。" },
];

export const EXTRA_PROMPT_APP_LABELS = Object.fromEntries(
    EXTRA_PROMPT_APPS.map((item) => [item.id, item.label]),
) as Record<ExtraPromptAppId, string>;
