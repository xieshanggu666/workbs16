const BASE = '/api'

// 行动请求并发控制：
// - expectedRev：当前视口的存档版本号，服务端据此拒绝基于过期状态的提交（409 状态冲突）
// - 每个新意图生成 request_id 做请求级幂等；网络超时后的同一重试复用同一 id，
//   服务端返回首次结果，不会重复扣款/发奖（双击/重复请求同理）
let expectedRev = null

// 多人协作远征（2.9.0）：当前队伍成员身份（入会响应里的 me.id）。协作章节 run
// 的每个动作都带 member_id，服务端据此做角色权限边界（越权 403、零副作用）。
let currentMemberId = null

export function setExpectedRev(rev) {
  if (Number.isInteger(rev)) expectedRev = rev
}

// 协作增量同步在 409 冲突恢复后拿到权威 rev：由同步模块显式设置，避免同步
// 循环与用户动作的乐观版本互相覆盖。
export function syncExpectedRev(rev) {
  if (Number.isInteger(rev)) expectedRev = rev
}

// 409 冲突/换会话时清掉本地乐观版本（后续请求不再带旧值，直到权威快照重新建立）
export function resetExpectedRev() {
  expectedRev = null
}

export function getExpectedRev() {
  return expectedRev
}

export function setCurrentMemberId(id) {
  currentMemberId = id || null
}

export function getCurrentMemberId() {
  return currentMemberId
}

export class ConflictError extends Error {
  constructor(detail) {
    super(detail || '状态已变化，请刷新后重试')
    this.status = 409
  }
}

// 协作权限边界：角色无权提交该动作（战斗位做资源动作/反之）。不自动重试，
// 由调用方提示——这是明确的 403 而非并发冲突，刷新视口也不会改变授权结果。
export class ForbiddenError extends Error {
  constructor(detail) {
    super(detail || '你的角色无权执行该操作')
    this.status = 403
  }
}

let reqSeq = 0

// 协作同步模块注册的「本地动作已提交」钩子（见 coopSync.noteLocalStep）。
// 避免 api 层直接依赖 zustand 存储造成循环引用。
let localStepHook = null
export function setLocalStepHook(fn) {
  localStepHook = typeof fn === 'function' ? fn : null
}

// 协作 409 冲突恢复钩子（coopSync.recoverFromConflict），同样经注入避免循环依赖
let coopRecoverHook = null
export function setCoopRecoverHook(fn) {
  coopRecoverHook = typeof fn === 'function' ? fn : null
}

function newRequestId() {
  reqSeq += 1
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${reqSeq}`
}

async function j(url, opts) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 409) throw new ConflictError(data.detail)
    if (res.status === 403) throw new ForbiddenError(data.detail)
    throw new Error(data.detail || `HTTP ${res.status}`)
  }
  return data
}

export const api = {
  cards: () => j(`${BASE}/cards`),
  async createRun(seed) {
    const data = await j(`${BASE}/runs`, { method: 'POST', body: JSON.stringify({ seed }) })
    setExpectedRev(data.rev)
    return data
  },
  async resume(id) {
    const data = await j(`${BASE}/runs/${id}/resume${currentMemberId ? `?member_id=${encodeURIComponent(currentMemberId)}` : ''}`)
    setExpectedRev(data.rev)
    return data
  },
  replay: (id) => j(`${BASE}/runs/${id}/replay`),

  // ---------- 多章远征 ----------
  async createExpedition(seed, chapters) {
    const data = await j(`${BASE}/expeditions`, {
      method: 'POST',
      body: JSON.stringify({ seed, chapters }),
    })
    if (Number.isInteger(data.run?.rev)) setExpectedRev(data.run.rev)
    return data
  },
  async getExpedition(id) {
    const data = await j(`${BASE}/expeditions/${id}`)
    if (Number.isInteger(data.run?.rev)) setExpectedRev(data.run.rev)
    return data
  },
  expeditionReplay: (id) => j(`${BASE}/expeditions/${id}/replay`),
  async advanceExpedition(id, { retryKey } = {}) {
    // 与 run 行动同理：request_id 幂等，重复/并发提交返回首次结果，不会重复开章
    const requestId = retryKey || newRequestId()
    const data = await j(`${BASE}/expeditions/${id}/advance`, {
      method: 'POST',
      body: JSON.stringify({ request_id: requestId }),
    })
    if (Number.isInteger(data.run?.rev)) setExpectedRev(data.run.rev)
    return data
  },

  act: async (id, action, { retryKey } = {}) => {
    // retryKey：调用方在“重试同一个意图”时显式传入；缺省每个调用一个新令牌
    const requestId = retryKey || newRequestId()
    const body = { ...action, request_id: requestId }
    // 协作远征：动作带成员身份（普通局/单人远征服务端忽略该字段）
    if (currentMemberId) body.member_id = currentMemberId
    if (expectedRev !== null) body.expected_rev = expectedRev
    try {
      const data = await j(`${BASE}/runs/${id}/act`, { method: 'POST', body: JSON.stringify(body) })
      if (Number.isInteger(data.rev)) expectedRev = data.rev
      // 协作增量同步：自己成功提交后乐观推进本地游标（seq/rev 均取自服务端响应，
      // 不本地臆造）；下个同步周期若与服务端不一致会被 reset 全量对齐
      if (data.seq && currentMemberId && localStepHook) {
        localStepHook({ runId: id, seq: data.seq, rev: data.rev })
      }
      return data
    } catch (e) {
      // 状态冲突：版本号已失效，清掉避免后续请求继续带旧值；调用方应刷新续局
      if (e instanceof ConflictError) expectedRev = null
      throw e
    }
  },

  // ---------- 多人协作远征（2.9.0） ----------
  createCoopTeam: ({ name, captainName, seed, chapters }) =>
    j(`${BASE}/coop/teams`, {
      method: 'POST',
      body: JSON.stringify({
        name: name || null,
        captain_name: captainName || null,
        seed: seed ?? null,
        chapters: chapters ?? null,
      }),
    }),
  joinCoopTeam: (code, memberName, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/join`, {
      method: 'POST',
      body: JSON.stringify({
        code,
        member_name: memberName || null,
        request_id: retryKey || newRequestId(),
      }),
    }),
  getCoopTeam: (teamId, memberId = currentMemberId) =>
    j(`${BASE}/coop/teams/${teamId}${memberId ? `?member_id=${encodeURIComponent(memberId)}` : ''}`),
  assignRole: (teamId, targetId, role, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/roles`, {
      method: 'POST',
      body: JSON.stringify({
        member_id: currentMemberId, target_id: targetId, role,
        request_id: retryKey || newRequestId(),
      }),
    }),
  leaveCoopTeam: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/leave`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }),
  disbandCoopTeam: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/disband`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }),
  startCoopExpedition: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/start`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }),
  advanceCoopExpedition: (teamId, { retryKey } = {}) =>
    j(`${BASE}/coop/teams/${teamId}/advance`, {
      method: 'POST',
      body: JSON.stringify({ member_id: currentMemberId, request_id: retryKey || newRequestId() }),
    }),
  getCoopExpedition: (teamId, memberId = currentMemberId) =>
    j(`${BASE}/coop/teams/${teamId}/expedition${memberId ? `?member_id=${encodeURIComponent(memberId)}` : ''}`),
  // 断线重连 / 事件增量同步：成员鉴权 + 服务端游标，回时间线增量、动作帧增量
  // （与整局回放同构、逐位校验）与权威快照；游标失效时服务端回 reset 全量对齐。
  coopSync: (teamId, cursor, memberId = currentMemberId) =>
    j(`${BASE}/coop/teams/${teamId}/sync`, {
      method: 'POST',
      body: JSON.stringify({ member_id: memberId, cursor: cursor || null }),
    }),
  coopTeamReplay: (teamId) => j(`${BASE}/coop/teams/${teamId}/replay`),
}

// 统一的行动错误处理：遇到 409（重复请求/状态冲突）自动拉取最新视口对齐，
// 返回可展示给用户的提示语。refresh 为最新视口应用函数（通常是 applyRun）。
// 403（协作权限边界）不刷新——刷新不会改变角色授权，直接把原因返回给调用方。
//
// 协作章节（options.coop = {teamId, memberId}）：409 后优先走服务端游标增量
// 同步——断线期间队友的动作以回放帧局部重放补齐（逐帧一致），游标失效则整体
// 落权威快照；非协作场景保持旧的整视口 resume 行为。
export async function handleActError(e, runId, refresh, options = {}) {
  if (e instanceof ConflictError) {
    if (options.coop?.teamId && options.coop.memberId) {
      // 走服务端游标增量同步：队友动作以回放帧局部重放补齐（逐帧一致），游标
      // 失效则整体落权威快照。经 setRecoverHook 注入，避免 api↔coopSync 循环依赖。
      if (coopRecoverHook) {
        return coopRecoverHook({
          teamId: options.coop.teamId,
          memberId: options.coop.memberId,
          applyRun: refresh,
        })
      }
    }
    try {
      const fresh = await api.resume(runId)
      if (refresh) refresh(fresh)
    } catch (_) { /* 刷新失败仅保留提示 */ }
    return '操作与最新状态冲突，已自动刷新，请重试'
  }
  return e.message
}
