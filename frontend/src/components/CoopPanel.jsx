import React, { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { useCoopSync } from '../coopSync'

// 协作远征侧栏：队伍成员、各自角色、个人贡献/战利，以及“我”的权限提示。
// 2.10.0：数据来自断线重连/增量同步循环（与章节帧同一条服务端游标通道）：
// 首次挂载拉一次完整队伍视口（含 ledger），之后把 sync 推来的时间线增量合并，
// 不再独立轮询——成员列表/角色在开赛后不变，贡献数随同步结果轻量刷新。
const ROLE_ICON = { leader: '👑', combat: '⚔️', supply: '🎒' }
const ROLE_NAME = { leader: '队长', combat: '战斗位', supply: '资源位' }

export default function CoopPanel() {
  const view = useStore((s) => s.view)
  const runId = useStore((s) => s.runId)
  const [team, setTeam] = useState(null)
  const [err, setErr] = useState('')
  const teamEvents = useCoopSync((s) => s.teamEvents)
  const connected = useCoopSync((s) => s.connected)
  const inflight = useCoopSync((s) => s.inflight)

  const coop = view?.coop
  const teamId = coop?.team_id
  const meId = coop?.me?.id
  const pollGuard = useRef(0)

  // 进入协作章节/换章：拉一次完整队伍视口（成员 + 个人战利 ledger）
  useEffect(() => {
    if (!teamId) {
      setTeam(null)
      return () => {}
    }
    let alive = true
    api.getCoopTeam(teamId, meId)
      .then((data) => { if (alive) setTeam(data) })
      .catch((e) => { if (alive) setErr(e.message) })
    return () => { alive = false }
  }, [teamId, meId, runId])

  // 同步循环推来结算类时间线（chapter_clear/settle）时刷新一次贡献/战利汇总
  const hasSettlement = (teamEvents || []).some(
    (e) => ['chapter_clear', 'settle', 'advance'].includes(e.kind))
  useEffect(() => {
    if (!teamId || !connected || !hasSettlement) return
    const guard = ++pollGuard.current
    api.getCoopTeam(teamId, meId)
      .then((data) => { if (guard === pollGuard.current) setTeam(data) })
      .catch(() => {})
  }, [teamId, meId, connected, hasSettlement, inflight])

  if (!coop) return null
  const members = team?.members || coop.members
  const me = members.find((m) => m.id === meId) || coop.me
  const canBattle = me && (me.role === 'leader' || me.role === 'combat')
  const canSupply = me && (me.role === 'leader' || me.role === 'supply')

  return (
    <div className="panellist coop-panel">
      <h3>
        👥 协作远征
        <span className={`chip coop-status ${coop.expedition_status}`}>
          {coop.expedition_status === 'in_progress'
            ? `第 ${coop.chapter}/${coop.chapters_total} 章`
            : coop.expedition_status === 'won' ? '已通关' : '已终结'}
        </span>
      </h3>
      <div className="coop-me-perm">
        我的角色：<b>{ROLE_ICON[me?.role] || '•'} {ROLE_NAME[me?.role] || me?.role}</b>
        <span className="coop-perm-tags">
          {canBattle && <em className="perm battle">可战斗操作</em>}
          {canSupply && <em className="perm supply">可资源操作</em>}
        </span>
      </div>
      <ul className="coop-roster">
        {members.map((m) => (
          <li key={m.id} className={`coop-roster-row ${m.role} ${m.id === meId ? 'me' : ''}`}>
            <span className="coop-member-icon">{m.icon || ROLE_ICON[m.role]}</span>
            <span className="coop-member-name">
              {m.name}{m.id === meId && <em className="coop-me-tag">（我）</em>}
            </span>
            <span className="coop-member-role">{m.role_label || ROLE_NAME[m.role]}</span>
            {m.ledger && (
              <span className="coop-member-stat" title="战斗胜利 / 后勤操作 / 个人战利金">
                ⚔️{m.ledger.battle_wins ?? 0} · 🎒{m.ledger.resource_ops ?? 0}
                {(m.ledger.gold ?? 0) > 0 && ` · 🏅${m.ledger.gold}`}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="coop-hint">
        入队码 <b className="coop-code-inline">{coop.code}</b> ·
        通关协作金 {coop.rewards.chapter_clear_bonus} 金入共享池随章节继承
      </p>
      {err && <div className="error">{err}</div>}
    </div>
  )
}
