// 协作远征增量同步器（规则 2.10.0）：
// - 轮询服务端游标接口，把队友的动作以「录制帧」逐条补播（战斗中经 Phaser
//   逐帧播放，与本地操作同一套动画），播完应用权威视口一次性对齐；
// - 章节推进/长期断线/旧日志等场景服务端回 reset，整体应用全量视口；
// - 本地操作进行中（acting）暂停本轮同步，避免动画与状态交错；
// - 409 冲突恢复经 coopSyncNow 立即触发一轮（handleActError 调用）。
import { useCallback, useEffect, useRef } from 'react'
import { api, getCoopCursor, setCoopCursor, setExpectedRev } from './api'
import { useStore } from './store'
import { playBattleLog } from './phaser/battleBus'

const POLL_MS = 2500

// 动作 -> 队伍动态文案（侧栏「最近动态」）
const ACTION_TEXT = {
  create: '创建章节',
  choose_node: '选择了路线',
  play: '打出卡牌',
  end_turn: '结束回合',
  use_potion: '使用药水',
  claim_reward: '领取奖励',
  forge: '锻造卡牌',
  shop_buy: '完成购买',
  shop_remove: '移除卡牌',
  discard_potion: '丢弃药水',
  companion_set_mode: '调整伙伴',
  commission_accept: '接取委托',
  commission_claim: '领取委托奖励',
  encounter_choice: '奇遇抉择',
}

const TEAM_EVENT_TEXT = {
  form: '队伍组建',
  join: '新成员加入',
  role: '角色调整',
  leave: '成员离队',
  disband: '队伍解散',
  start: '远征开赛',
  chapter_clear: '章节通关',
  advance: '进入下一章',
  settle: '远征结算',
}

function memberName(view, id) {
  const m = (view?.coop?.members || []).find((x) => x.id === id)
  return m ? `${m.icon || ''}${m.name}` : null
}

export function useCoopSync() {
  const teamId = useStore((s) => s.view?.coop?.team_id || null)
  const runId = useStore((s) => s.runId)
  const applyRun = useStore((s) => s.applyRun)
  const busyRef = useRef(false)

  const syncOnce = useCallback(async (force = false) => {
    if (!teamId || busyRef.current) return
    const st = useStore.getState()
    // 本地动作提交/动画进行中：本轮让位，下轮再追（force 为 409 冲突恢复）
    if (!force && st.acting) return
    busyRef.current = true
    try {
      const data = await api.syncCoop(teamId, getCoopCursor())
      if (data.cursor) setCoopCursor(data.cursor)
      // 权威版本锚点随响应对齐（视口 rev 优先，心跳时取游标 rev——旧档迁移
      // 不产生动作事件但会推进 rev），避免后续动作带过期 expected_rev 必遭 409
      const authRev = data.run?.rev ?? data.cursor?.rev
      if (Number.isInteger(authRev)) setExpectedRev(authRev)
      const view = useStore.getState().view
      // 队伍动态：动作增量（标注操作者）+ 队伍时间线增量（key 由 store 统一分配）
      const feed = []
      for (const a of data.actions || []) {
        if (a.action === 'create') continue
        const who = memberName(view, a.actor)
        feed.push({ text: `${who || '队友'} ${ACTION_TEXT[a.action] || a.action}` })
      }
      for (const e of data.team_events || []) {
        feed.push({ text: `👥 ${TEAM_EVENT_TEXT[e.kind] || e.kind}` })
      }
      for (const e of data.expedition_events || []) {
        if (e.kind === 'create') continue
        feed.push({ text: `🚩 ${TEAM_EVENT_TEXT[e.kind] || e.kind}` })
      }
      if (feed.length) useStore.getState().pushCoopFeed(feed.reverse())

      if (data.reset) {
        // 章节推进/断线重连/落后过多：整体应用权威视口
        if (data.run) applyRun(data.run)
        return
      }
      const actions = (data.actions || []).filter((a) => !a.replay_only)
      if (!actions.length) return
      // 局部重放：战斗中逐帧补播结算动画（与本地操作同一套 Phaser 播放）；
      // 非战斗动作无动画帧，直接由权威视口对齐
      const inBattle = !!useStore.getState().view?.battle
      useStore.getState().setSyncing(true)
      try {
        if (inBattle) {
          for (const a of actions) {
            if (a.log && a.log.length) await playBattleLog(a.log)
          }
        }
      } finally {
        // 播完一次性应用权威视口（与单人 /act「动画 -> 快照」同节奏）
        if (data.run) applyRun(data.run)
        useStore.getState().setSyncing(false)
      }
    } finally {
      busyRef.current = false
    }
  }, [teamId, applyRun])

  // 注册「立即同步」入口（409 冲突恢复用）+ 轮询驱动
  useEffect(() => {
    const setCoopSyncNow = useStore.getState().setCoopSyncNow
    if (!teamId) {
      setCoopSyncNow(null)
      return () => {}
    }
    setCoopSyncNow(() => () => syncOnce(true))
    let alive = true
    const timer = setInterval(() => {
      if (alive) syncOnce(false).catch(() => { /* 网络抖动下轮重试 */ })
    }, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
      setCoopSyncNow(null)
    }
  }, [teamId, runId, syncOnce])
}
