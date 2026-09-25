// 多人协作远征（2.10.0）：断线重连 / 事件增量同步 / 前端局部重放。
//
// 服务端是唯一权威：所有成员的动作经同一事务串行化进同一条确定性动作日志。
// 本模块只做三件事：
//   1. 持有「服务端游标」{team_seq, run_id, run_seq, rev}，周期性/断线恢复后
//      调 POST /coop/teams/{id}/sync 拉增量；
//   2. 把游标之后的动作帧（与整局回放同构、逐位校验）在本地【局部重放】：
//      战斗帧的结算事件经 battleBus 按序播放，帧视图逐帧落地，最后以服务端
//      权威快照校正——共享状态与回放逐帧一致；
//   3. 冲突恢复：服务端判定游标失效（换章/seq 缺口/rev 漂移）时回 reset，
//      直接整体落权威快照；409（expected_rev 过期）后立即拉一次同步。
//
// 本地绝不推演规则：帧视图与快照全部来自服务端纯推演结果，杜绝多端分叉。
import { create } from 'zustand'
import { api, syncExpectedRev, resetExpectedRev, setLocalStepHook,
         setCoopRecoverHook } from './api'
import { bus } from './phaser/battleBus'

const SESSION_KEY = 'coop.session.v1'
const POLL_MS = 2000          // 协作进行中常规轮询
const POLL_HIDDEN_MS = 5000   // 标签页后台时降频，省请求
const FRAME_SETTLE_MS = 90    // 等 React 提交 + Phaser 落快照（与回放播放器一致）
const QUEUE_TIMEOUT_MS = 12000

// ---------- 会话持久化：刷新/关掉标签页后一键回到原队伍 ----------
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

// ---------- 同步状态（UI：连接徽标/待重放帧数/提示） ----------
export const useCoopSync = create((set) => ({
  connected: false,          // 是否刚成功同步过
  online: typeof navigator === 'undefined' ? true : navigator.onLine,
  inflight: false,           // 一次 sync 请求进行中
  pendingFrames: 0,          // 已拉到、尚未局部重放完的帧数
  replaying: false,          // 正在播放增量帧动画
  error: '',
  note: '',                  // 最近一次非错误提示（如「已重连，补播 N 步」）
  teamEvents: [],            // 最近增量到的队伍时间线事件（供侧栏提示）
  cursor: null,
  session: loadSession(),

  setOnline: (online) => set({ online }),
  clearNote: () => set({ note: '' }),
}))

function saveSession(session) {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session))
    else localStorage.removeItem(SESSION_KEY)
  } catch { /* 隐私模式等：会话仅内存存活 */ }
}

// 记住「我在协作远征中」的身份（cursor 不持久化——重连一律先走全量快照对齐）
export function rememberSession({ teamId, teamName, memberId, memberName, role }) {
  const session = { teamId, teamName: teamName || null, memberId,
                    memberName: memberName || null, role: role || null,
                    at: Date.now() }
  saveSession(session)
  useCoopSync.setState({ session, cursor: null, connected: false })
  return session
}

// 自己成功提交动作后乐观推进本地游标（下个 tick 若与服务端不一致会被 reset 对齐）。
// 注意：run_seq 与 rev 都来自服务端响应，绝不本地臆造。
export function noteLocalStep({ runId, seq, rev }) {
  const cur = useCoopSync.getState().cursor
  if (!cur || cur.run_id !== runId) return
  useCoopSync.setState({
    cursor: { ...cur, run_seq: Math.max(cur.run_seq || 0, seq || 0), rev: rev ?? cur.rev },
  })
}

export function resetCursor() {
  useCoopSync.setState({ cursor: null, connected: false, pendingFrames: 0,
                         replaying: false, teamEvents: [] })
}

export function forgetSession() {
  saveSession(null)
  resetExpectedRev()
  useCoopSync.setState({ session: null, cursor: null, connected: false,
                         pendingFrames: 0, replaying: false, teamEvents: [],
                         note: '', error: '' })
}

// ---------- 战斗帧动画播放（复用 Phaser 的 queue/queue_done 协议） ----------
function wait(ms) {
  return new Promise((res) => setTimeout(res, ms))
}

function playFrameEvents(step) {
  const evs = (step?.events || []).filter(Boolean)
  // 与 ReplayPlayer 同款：非战斗帧不推战斗队列
  if (!evs.length || !step.view?.in_battle) return Promise.resolve()
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      off()
      clearTimeout(timer)
      resolve()
    }
    const off = bus.on('queue_done', finish)
    const t = setTimeout(finish, QUEUE_TIMEOUT_MS)
    bus.emit('queue', evs)
  })
}

// 逐帧局部重放：帧视图先逐帧落地（驱动 React/Phaser），战斗结算事件按序播放；
// 全部播完后以服务端权威快照做一次校正（快照与最后一帧同源，幂等无分叉）。
async function replayFramesLocally(steps, applyRun, { animate = true } = {}) {
  if (!steps.length) return
  useCoopSync.setState({ replaying: true, pendingFrames: steps.length })
  try {
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i]
      applyRun(step.view)
      syncExpectedRev(step.view.rev)
      if (animate) {
        await wait(FRAME_SETTLE_MS)
        await playFrameEvents(step)
      }
      useCoopSync.setState({ pendingFrames: steps.length - i - 1 })
    }
  } finally {
    useCoopSync.setState({ replaying: false, pendingFrames: 0 })
  }
}

function applySnapshot(snapshot, applyRun) {
  if (!snapshot) return
  applyRun(snapshot)
  syncExpectedRev(snapshot.rev)
}

// ---------- 一次同步（同步锁防轮询重入） ----------
let _busy = false

async function syncOnce({ teamId, memberId, applyRun, resetView, animate = true }) {
  if (_busy) return null
  const { cursor } = useCoopSync.getState()
  _busy = true
  useCoopSync.setState({ inflight: true, error: '' })
  try {
    const data = await api.coopSync(teamId, cursor, memberId)
    return await ingest(data, { applyRun, resetView, animate })
  } finally {
    _busy = false
    useCoopSync.setState({ inflight: false })
  }
}

// 处理服务端同步响应：reset 全量对齐 / 增量帧局部重放 / 游标推进。
async function ingest(data, { applyRun, resetView, animate = true }) {
  const wasConnected = useCoopSync.getState().connected
  useCoopSync.setState({
    connected: true,
    cursor: data.cursor,
    error: '',
    teamEvents: data.team_events || [],
  })

  // 未开赛/已解散：没有章节视口（大厅场景由大厅自身轮询，不在这里落 run 视口）
  if (data.run && (data.reset || data.steps.length)) {
    if (data.reset) {
      // 冲突恢复：换章/缺口/rev 漂移——丢弃任何本地待放帧，整体落权威快照
      bus.emit('reset')
      applySnapshot(data.snapshot, applyRun)
      const reasonZh = {
        first_sync: '已连接协作队伍',
        run_changed: '章节已推进，已切换到最新章节',
        gap: '同步游标失效，已按服务端状态整体恢复',
        rev_drift: '本地状态过期，已按权威快照对齐',
      }[data.reset_reason] || '已按服务端状态恢复'
      useCoopSync.setState({
        note: wasConnected ? `⚠ ${reasonZh}` : reasonZh,
        pendingFrames: 0, replaying: false,
      })
      if (data.run_changed && resetView) resetView(data.snapshot)
    } else if (data.steps.length) {
      const n = data.steps.length
      await replayFramesLocally(data.steps, applyRun, { animate })
      // 权威快照终态校正（最后一帧同源；无动画场景也由此对齐 rev）
      applySnapshot(data.snapshot, applyRun)
      if (!wasConnected) useCoopSync.setState({ note: `🔗 已重连，补播队友的 ${n} 步操作` })
    }
  } else if (data.reset && data.snapshot) {
    applySnapshot(data.snapshot, applyRun)
  }
  return data
}

// ---------- 409 冲突恢复钩子：任意动作收到 409 后立即按游标增量追平 ----------
export async function recoverFromConflict({ teamId, memberId, applyRun }) {
  try {
    // 409 时本地乐观 rev 已失效；先清掉，避免后续请求继续带旧值
    resetExpectedRev()
    // 游标可能落在过期位置：让服务端决定增量追赶或 reset 全量对齐
    await syncOnce({ teamId, memberId, applyRun, animate: false })
    return '操作与队友的最新动作冲突，已自动同步，请重试'
  } catch (e) {
    useCoopSync.setState({ error: e.message })
    return `状态冲突且自动同步失败：${e.message}`
  }
}

// ---------- 同步循环控制器 ----------
class SyncLoop {
  constructor() {
    this.timer = null
    this.ctx = null
    this._online = this._online.bind(this)
    this._offline = this._offline.bind(this)
    this._tick = this._tick.bind(this)
  }

  // ctx: {teamId, memberId, applyRun, resetView, animate?}
  start(ctx) {
    this.stop()
    this.ctx = ctx
    // 立即追一次（进入协作章节 / 手动重连）
    this._tick(true)
    window.addEventListener('online', this._online)
    window.addEventListener('offline', this._offline)
    document.addEventListener('visibilitychange', this._tick)
    this._schedule()
  }

  stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    window.removeEventListener('online', this._online)
    window.removeEventListener('offline', this._offline)
    document.removeEventListener('visibilitychange', this._tick)
    this.ctx = null
  }

  restart() {
    if (this.ctx) this.start(this.ctx)
  }

  // 自适应轮询：前台 2s、后台标签页 5s；每次 tick 后重新调度
  _schedule() {
    if (!this.ctx) return
    const delay = (typeof document !== 'undefined' && document.hidden)
      ? POLL_HIDDEN_MS : POLL_MS
    this.timer = setTimeout(() => { this._tick(false) }, delay)
  }

  _online() {
    useCoopSync.setState({ online: true })
    this._tick(true) // 网络恢复立刻补同步
  }

  _offline() {
    useCoopSync.setState({ online: false, connected: false,
                           note: '📡 网络已断开，正在等待重连…' })
  }

  async _tick(immediate = false) {
    const ctx = this.ctx
    if (!ctx) return
    // visibilitychange 以 Event 调起；online 也立即调起——都按「立即同步」处理
    const now = immediate !== false
    if (!now && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // 动画播放期间不并发拉新帧，避免两批帧交错播放（本批播完下个周期自然补齐）
    const st = useCoopSync.getState()
    if (!st.replaying) {
      try {
        await syncOnce({ ...ctx, animate: ctx.animate !== false })
      } catch (e) {
        useCoopSync.setState({
          connected: false,
          error: immediate ? e.message : '', // 轮询失败静默等下个周期；手动触发才提示
        })
      }
    }
    this._schedule()
  }
}

export const coopSyncLoop = new SyncLoop()

// 把自己成功提交动作的游标推进挂到 api.act（模块加载即生效；动作 seq/rev 均
// 来自服务端响应，本地不臆造任何状态）
setLocalStepHook((p) => noteLocalStep(p))
// 409 冲突恢复同样由 api 层委托回本模块
setCoopRecoverHook((p) => recoverFromConflict(p))
