// lib/turn-coordinator.ts
//
// 单机自用场景下的“谁现在可以说话”总调度。
//
// 背景：普通回复、生活现场、追问、冷场、定时唤醒、查岗、经期关怀
// 都能写同一个角色的上下文。以前它们各自触发，没有统一互斥，导致：
//   · 用户刚发消息，旧主动 turn 还在生成/执行工具；
//   · 生活现场和线上冷场同时说话；
//   · 通话挂断的结尾回复被通话 abort 误杀。
//
// 这个模块只负责三件事：
//   1. 按 characterId + sessionId 保证同一时刻只有一个 active turn；
//   2. 高优先级抢占低优先级，并 abort 低优先级的 AbortSignal；
//   3. 给调用方一个 turnId / isCurrent()，写库前可以再确认一次。
//
// 它不直接改聊天库、不直接调 LLM，避免和 chat-engine 形成循环依赖。

export type TurnKind =
    | "user_reply"
    | "call"
    | "call_end"
    | "life_scene"
    | "followup"
    | "idle_reconnect"
    | "timed_wake"
    | "check_in"
    | "period_care";

/**
 * 通话/通话结尾是交互阻塞态，不参与主动队列：
 * 通话期间所有主动消息让路；用户回复也不抢占通话。
 * 主动队列严格按用户确定的顺序。
 */
export const TURN_PRIORITY: Record<TurnKind, number> = {
    call: 110,
    call_end: 110,
    user_reply: 100,
    life_scene: 90,
    followup: 80,
    idle_reconnect: 70,
    timed_wake: 60,
    check_in: 50,
    period_care: 40,
};

export type TurnHandle = {
    turnId: string;
    kind: TurnKind;
    priority: number;
    signal: AbortSignal;
    startedAt: number;
    /** 该 turn 是否仍是当前 active turn。写库/执行工具前再确认一次。 */
    isCurrent: () => boolean;
    /** 结束该 turn；如果不是当前 turn 则无副作用。 */
    end: () => void;
    /** 主动中断该 turn（abort signal），但不从 map 移除；通常随后调 end()。 */
    abort: () => void;
};

type ActiveTurn = {
    turnId: string;
    kind: TurnKind;
    priority: number;
    characterId: string;
    sessionId: string;
    startedAt: number;
    controller: AbortController;
    observeOnly: boolean;
};

const activeBySession = new Map<string, ActiveTurn>();
let turnSequence = 0;

function sessionKey(characterId: string, sessionId: string): string {
    return `${characterId}:${sessionId}`;
}

function makeTurnId(kind: TurnKind): string {
    turnSequence += 1;
    return `${kind}_${Date.now().toString(36)}_${turnSequence.toString(36)}`;
}

/**
 * 尝试开始一个 turn。
 *
 * 返回 null 表示当前有同级/更高优先级的 turn，调用方应直接放弃。
 * 返回 handle 时，调用方必须把 handle.signal 传给 LLM/工具，并在 finally 调 handle.end()。
 */
export function beginTurn(input: {
    kind: TurnKind;
    characterId: string;
    sessionId: string;
    /** true 时只记录/观察，不 abort 现有 turn（灰度/诊断用）。 */
    observeOnly?: boolean;
}): TurnHandle | null {
    const { kind, characterId, sessionId, observeOnly = false } = input;
    if (!characterId || !sessionId) return null;
    const key = sessionKey(characterId, sessionId);
    const priority = TURN_PRIORITY[kind];
    const current = activeBySession.get(key);

    if (current) {
        // 同优先级：新 user_reply 顶掉旧 user_reply；call_end 顶掉 call；新 call 顶掉旧 call_end。
        // 其余同优先级直接拒绝，避免重复主动消息。
        const samePriorityUserReply = current.priority === priority && current.kind === "user_reply" && kind === "user_reply";
        const callEndReplacesCall = current.priority === priority && current.kind === "call" && kind === "call_end";
        const callReplacesCallEnd = current.priority === priority && current.kind === "call_end" && kind === "call";
        if (current.priority > priority || (current.priority === priority && !samePriorityUserReply && !callEndReplacesCall && !callReplacesCallEnd)) return null;
        if (!observeOnly && !current.observeOnly) {
            current.controller.abort();
        }
    }

    const turnId = makeTurnId(kind);
    const controller = new AbortController();
    const turn: ActiveTurn = {
        turnId,
        kind,
        priority,
        characterId,
        sessionId,
        startedAt: Date.now(),
        controller,
        observeOnly,
    };
    activeBySession.set(key, turn);

    const isCurrent = () => activeBySession.get(key)?.turnId === turnId;
    const end = () => {
        if (activeBySession.get(key)?.turnId !== turnId) return;
        activeBySession.delete(key);
    };

    return {
        turnId,
        kind,
        priority,
        signal: controller.signal,
        startedAt: turn.startedAt,
        isCurrent,
        end,
        abort: () => controller.abort(),
    };
}

/** 取消该会话所有 active turn（用户发消息/开始通话/进入生活现场时用）。 */
export function abortTurnsForSession(sessionId: string, exceptTurnId?: string): number {
    let count = 0;
    for (const [key, turn] of activeBySession) {
        if (turn.sessionId !== sessionId) continue;
        if (exceptTurnId && turn.turnId === exceptTurnId) continue;
        turn.controller.abort();
        activeBySession.delete(key);
        count += 1;
    }
    return count;
}

/** 取消该角色所有 active turn（切换角色/删除会话时用）。 */
export function abortTurnsForCharacter(characterId: string, exceptTurnId?: string): number {
    let count = 0;
    for (const [key, turn] of activeBySession) {
        if (turn.characterId !== characterId) continue;
        if (exceptTurnId && turn.turnId === exceptTurnId) continue;
        turn.controller.abort();
        activeBySession.delete(key);
        count += 1;
    }
    return count;
}

export function getActiveTurn(characterId: string, sessionId: string): TurnHandle | null {
    const turn = activeBySession.get(sessionKey(characterId, sessionId));
    if (!turn) return null;
    return {
        turnId: turn.turnId,
        kind: turn.kind,
        priority: turn.priority,
        signal: turn.controller.signal,
        startedAt: turn.startedAt,
        isCurrent: () => activeBySession.get(sessionKey(characterId, sessionId))?.turnId === turn.turnId,
        end: () => {
            if (activeBySession.get(sessionKey(characterId, sessionId))?.turnId === turn.turnId) {
                activeBySession.delete(sessionKey(characterId, sessionId));
            }
        },
        abort: () => turn.controller.abort(),
    };
}

/** 测试/诊断用：当前所有 active turn 的快照。 */
export function listActiveTurns(): Array<{
    turnId: string;
    kind: TurnKind;
    priority: number;
    characterId: string;
    sessionId: string;
    startedAt: number;
}> {
    return [...activeBySession.values()].map(turn => ({
        turnId: turn.turnId,
        kind: turn.kind,
        priority: turn.priority,
        characterId: turn.characterId,
        sessionId: turn.sessionId,
        startedAt: turn.startedAt,
    }));
}
