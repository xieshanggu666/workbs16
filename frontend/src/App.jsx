import React, { useEffect, useState } from 'react'
import { api, handleActError, setCurrentMemberId } from './api'
import { useStore } from './store'
import { coopRecoverOpts } from './useCoopRecover'
import {
  useCoopSync, coopSyncLoop, rememberSession,
  forgetSession, resetCursor,
} from './coopSync'
import MapView from './components/MapView.jsx'
import BattleView from './components/BattleView.jsx'
import RewardView from './components/RewardView.jsx'
import ForgeView from './components/ForgeView.jsx'
import ShopView from './components/ShopView.jsx'
import DeckView from './components/DeckView.jsx'
import CommissionPanel from './components/CommissionPanel.jsx'
import PotionBelt from './components/PotionBelt.jsx'
import CompanionPanel from './components/CompanionPanel.jsx'
import EncounterView from './components/EncounterView.jsx'
import EncounterFlags from './components/EncounterFlags.jsx'
import ReplayPlayer from './components/ReplayPlayer.jsx'
import ExpeditionReplay from './components/ExpeditionReplay.jsx'
import CoopLobby from './components/CoopLobby.jsx'
import CoopPanel from './components/CoopPanel.jsx'
import CoopReplay from './components/CoopReplay.jsx'
import CoopConnBadge from './components/CoopConnBadge.jsx'

export default function App() {
  const { view, setCards, cards, runId, setRunId, applyRun } = useStore()
  const [seed, setSeed] = useState('')
  const [resumeId, setResumeId] = useState('')
  const [expChapters, setExpChapters] = useState('3')
  const [expId, setExpId] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')
  // 商店面板仅在本地收起：再次进入节点或点击“回到商店”重开（不发任何交易动作）
  const [shopDismissed, setShopDismissed] = useState(false)
  // 整局回放：replayId 非 null 时覆盖全屏播放器（严格只读，与当前对局隔离）
  const [replayId, setReplayId] = useState(null)
  // 远征整程回放：expReplayId 非 null 时覆盖全屏（逐章切换，同样只读隔离）
  const [expReplayId, setExpReplayId] = useState(null)
  // 多人协作：showCoop 显示大厅；coopReplayId 非 null 时覆盖协作整程回放
  const [showCoop, setShowCoop] = useState(false)
  const [coopReplayId, setCoopReplayId] = useState(null)
  const [coopTeamId, setCoopTeamId] = useState('')

  // 协作增量同步的连接状态（断线/重连/补播提示）
  const coopConn = useCoopSync()

  useEffect(() => {
    api.cards().then(setCards).catch(() => {})
  }, [])

  // 协作章节中：以当前 run 的 coop 身份启动服务端游标同步循环（断线自动重连、
  // 队友动作增量帧局部重放）；离开协作 run（新局/回大厅/换队）即停止。
  const coopTeamNow = view?.coop?.team_id
  const coopMeNow = view?.coop?.me?.id
  useEffect(() => {
    if (!coopTeamNow || !coopMeNow || !runId) return undefined
    rememberSession({
      teamId: coopTeamNow,
      teamName: view?.coop?.name,
      memberId: coopMeNow,
      memberName: view?.coop?.me?.name,
      role: view?.coop?.me?.role,
    })
    coopSyncLoop.start({
      teamId: coopTeamNow,
      memberId: coopMeNow,
      applyRun,
      resetView: (snap) => { setRunId(snap.run_id); setReplayId(null) },
    })
    return () => coopSyncLoop.stop()
    // 只随「进入/离开协作章节」与 run 切换重挂循环；view 高频变化不重启轮询
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coopTeamNow, coopMeNow, runId])

  // 提示语自动消失
  useEffect(() => {
    if (!coopConn.note) return undefined
    const t = setTimeout(() => useCoopSync.setState({ note: '' }), 4000)
    return () => clearTimeout(t)
  }, [coopConn.note])

  // 切换到不同节点（进商店/离开商店/续局）时重置商店面板的本地收起状态
  useEffect(() => {
    setShopDismissed(false)
  }, [view?.position, runId])

  async function create() {
    setLoading(true); setErr('')
    try {
      const run = await api.createRun(seed ? Number(seed) : undefined)
      applyRun(run)
      setRunId(run.run_id)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function resume() {
    if (!resumeId) return
    setLoading(true); setErr('')
    try {
      const run = await api.resume(resumeId)
      applyRun(run)
      setRunId(run.run_id)
      setReplayId(null)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  function openReplay(id) {
    const target = (id || runId || '').trim()
    if (target) setReplayId(target)
  }

  async function createExpedition() {
    setLoading(true); setErr('')
    try {
      const chapters = expChapters ? Number(expChapters) : undefined
      const data = await api.createExpedition(seed ? Number(seed) : undefined, chapters)
      applyRun(data.run)
      setRunId(data.run.run_id)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  async function resumeExpedition(id) {
    const target = (id || expId || '').trim()
    if (!target) return
    setLoading(true); setErr('')
    try {
      const data = await api.getExpedition(target)
      applyRun(data.run)
      setRunId(data.run.run_id)
      setReplayId(null)
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  function openExpeditionReplay(id) {
    const target = (id || view?.expedition?.id || expId || '').trim()
    if (target) setExpReplayId(target)
  }

  async function advanceChapter() {
    const expeditionId = view?.expedition?.id
    if (!expeditionId) return
    setLoading(true); setErr('')
    try {
      // 协作远征走队伍推进接口（服务端校验仅队长可操作）；单人远征走原接口
      const teamId = view?.coop?.team_id
      if (teamId) setCoopTeamId(teamId)
      const data = teamId
        ? await api.advanceCoopExpedition(teamId)
        : await api.advanceExpedition(expeditionId)
      if (teamId) {
        // 换章：旧游标指向上一章 run，主动作废让同步循环走全量快照对齐
        resetCursor()
      }
      applyRun(data.run)
      setRunId(data.run.run_id)
      if (teamId) coopSyncLoop.restart()
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  function enterCoopRun(team, runView = null) {
    setShowCoop(false)
    setCoopTeamId(team.id)
    // 进入协作章节：游标作废，由同步循环首次 sync 走全量快照对齐（断线重连同理）
    resetCursor()
    if (runView) {
      applyRun(runView)
      setRunId(runView.run_id)
      return
    }
    // 大厅“进入协作远征”：拉取队伍当前章节 run 视口
    setLoading(true); setErr('')
    api.getCoopExpedition(team.id)
      .then((data) => {
        if (data.run) {
          applyRun(data.run)
          setRunId(data.run.run_id)
        }
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false))
  }

  async function refreshRun() {
    if (!runId) return
    setErr('')
    try {
      const run = await api.resume(runId)
      applyRun(run)
    } catch (e) {
      setErr(e.message)
    }
  }

  // 断线重连：从本地持久化的协作会话一键回到队伍当前章节（游标置空 ->
  // 同步循环首次 sync 走全量权威快照，之后恢复增量）
  async function reconnectCoopSession() {
    const s = coopConn.session
    if (!s?.teamId || !s?.memberId) return
    setLoading(true); setErr('')
    try {
      setCurrentMemberId(s.memberId)
      const data = await api.getCoopExpedition(s.teamId, s.memberId)
      setCoopTeamId(s.teamId)
      if (data.run) {
        resetCursor()
        applyRun(data.run)
        setRunId(data.run.run_id)
        setShowCoop(false)
      } else {
        setShowCoop(true)
      }
    } catch (e) {
      setErr(e.message)
    } finally {
      setLoading(false)
    }
  }

  function leaveCoopSession() {
    forgetSession()
  }

  async function newRun() {
    setErr('')
    coopSyncLoop.stop()
    const run = await api.createRun()
    applyRun(run)
    setRunId(run.run_id)
  }

  // 章节通关结算遮罩内领取委托奖励（与侧栏面板同接口、request_id 幂等）
  async function claimCommission(cid) {
    if (!runId) return
    setLoading(true); setErr('')
    try {
      const res = await api.act(runId, { action: 'commission_claim', commission: cid })
      applyRun(res.run)
    } catch (e) {
      setErr(await handleActError(e, runId, applyRun, coopRecoverOpts(view)))
    } finally {
      setLoading(false)
    }
  }

  if (!view) {
    return (
      <div className="screen home">
        <div className="panel">
          <h1>卡牌闯关</h1>
          <p>选择路线 · 构筑牌组 · 挑战首领 · 失败解锁新卡</p>
          <div className="fieldrow">
            <span>种子（可选）</span>
            <input value={seed} onChange={(e) => setSeed(e.target.value)} placeholder="随机" />
          </div>
          <button className="primary" onClick={create} disabled={loading}>
            {loading ? '创建中…' : '新建一局（随机种子）'}
          </button>
          <div className="divider" />
          <div className="fieldrow">
            <span>远征章节</span>
            <input value={expChapters} onChange={(e) => setExpChapters(e.target.value)} placeholder="3" />
            <button className="primary" onClick={createExpedition} disabled={loading}>
              {loading ? '创建中…' : '🚩 新建远征（多章连征）'}
            </button>
          </div>
          <div className="coop-home-entry">
            <button className="primary" onClick={() => setShowCoop(true)} disabled={loading}>
              👥 多人协作远征（组队 · 角色分工 · 共享章节）
            </button>
          </div>
          {coopConn.session && (
            <div className="coop-reconnect-entry panel-inner">
              <span>
                🔌 检测到协作远征会话：{coopConn.session.memberName || '队员'}
                {coopConn.session.teamName ? ` · ${coopConn.session.teamName}` : ''}
              </span>
              <button className="primary" onClick={reconnectCoopSession} disabled={loading}>
                断线重连
              </button>
              <button onClick={leaveCoopSession} disabled={loading}
                      title="忘记本机保存的队员会话（不退队、不影响其他成员）">
                清除
              </button>
            </div>
          )}
          <div className="fieldrow">
            <span>远征 ID</span>
            <input value={expId} onChange={(e) => setExpId(e.target.value)} placeholder="粘贴 expedition_id" />
            <button onClick={() => resumeExpedition()} disabled={loading || !expId}>续远征</button>
            <button onClick={() => openExpeditionReplay()} disabled={loading || !expId}>🎬 整程回放</button>
          </div>
          <div className="divider" />
          <div className="fieldrow">
            <span>续局 ID</span>
            <input value={resumeId} onChange={(e) => setResumeId(e.target.value)} placeholder="粘贴 run_id" />
            <button onClick={resume} disabled={loading}>续局</button>
          </div>
          <div className="divider" />
          <div className="fieldrow">
            <span>回放 ID</span>
            <input
              value={resumeId}
              onChange={(e) => setResumeId(e.target.value)}
              placeholder="粘贴 run_id，逐步播放整局"
              onKeyDown={(e) => e.key === 'Enter' && openReplay(resumeId)}
            />
            <button onClick={() => openReplay(resumeId)} disabled={loading || !resumeId}>🎬 整局回放</button>
          </div>
          {err && <div className="error">{err}</div>}
        </div>
        {cards.length > 0 && <DeckView mode="extras" />}
      </div>
    )
  }

  if (showCoop) {
    return (
      <div className="screen home">
        <CoopLobby onEnterRun={enterCoopRun} />
        <div className="coop-back">
          <button onClick={() => setShowCoop(false)}>← 返回单人入口</button>
        </div>
        {coopReplayId && <CoopReplay teamId={coopReplayId} onClose={() => setCoopReplayId(null)} />}
      </div>
    )
  }

  const hasReward = !view.reward_claimed && view.reward_options && view.reward_options.length > 0
  const hasForge = view.forge_available === true
  const hasEncounter = !view.in_battle && !!view.encounter
  const atShop = view.shop_available === true && view.shop
  const showShop = atShop && !shopDismissed
  const ended = view.status === 'won' || view.status === 'lost'

  return (
    <div className="screen">
      <header className="topbar">
        <span className="brand">卡牌闯关</span>
        {view.expedition && (
          <span className={`chip exp-chip ${view.expedition.status}`}>
            🚩 远征 第{view.expedition.chapter}/{view.expedition.chapters_total}章
            {view.expedition.status === 'won' && ' · 已通关'}
            {view.expedition.status === 'lost' && ' · 已终结'}
          </span>
        )}
        {view.coop && (
          <span className="chip coop-chip" title={`入队码 ${view.coop.code} · 角色分工协作`}>
            👥 协作队 {view.coop.members.length} 人
            {view.coop.me && <> · {view.coop.me.icon} {view.coop.me.role_label}</>}
          </span>
        )}
        {view.coop && <CoopConnBadge />}
        <span>生命 {view.health}/{view.max_health}</span>
        <span>金币 {view.gold}</span>
        <span>牌组 {view.deck.length}</span>
        <span className="sub">种子 {view.status === 'in_progress' && '#'}{view.seed === undefined ? '' : view.seed}</span>
        <button className="mini" onClick={refreshRun}>刷新</button>
        <button className="mini" onClick={() => openReplay(runId)} title="逐步播放、暂停、跳转整局（只读）">
          🎬 回放本局
        </button>
        {view.expedition && (
          <button className="mini" onClick={() => openExpeditionReplay()} title="逐章播放整段远征（只读）">
            🎬 整程回放
          </button>
        )}
        {view.coop && (
          <button className="mini" onClick={() => setCoopReplayId(view.coop.team_id)}
                  title="队伍时间线 + 个人战利 + 逐章回放（只读）">
            👥 协作回放
          </button>
        )}
        <button className="mini" onClick={newRun}>新局</button>
      </header>

      {ended && (
        <div className="overlay">
          <div className="endcard">
            <h2>
              {view.status === 'won'
                ? (view.expedition
                  ? (view.expedition.status === 'won' ? '🏆 远征通关！' : '✅ 章节通关！')
                  : '🎉 通关！')
                : (view.expedition ? '💀 远征终结' : '💀 失败')}
            </h2>
            <p>
              {view.status === 'lost' && (view.expedition
                ? `远征在第 ${view.expedition.chapter} 章终结，已结算并更新解锁（新卡已解锁）；进行中的委托全部失败。`
                : '失败解锁了一张新卡。')}
              {view.status === 'won' && view.expedition && view.expedition.status === 'in_progress' &&
                `牌组、锻造成长与遗物将带入第 ${view.expedition.chapter + 1} 章。`}
              {view.status === 'won' && view.expedition && view.expedition.status === 'won' &&
                `已征服全部 ${view.expedition.chapters_total} 章，远征结算完成。`}
            </p>
            {view.status === 'won' && view.expedition?.status === 'in_progress' &&
              (view.commissions || []).some((q) => q.can_claim) && (
              <p className="comm-hint">📜 有委托已完成，可在进入下一章前先领取奖励（左侧委托面板）。</p>
            )}
            {view.status === 'won' && view.expedition?.status === 'in_progress' &&
              (view.commissions || []).filter((q) => q.can_claim).length > 0 && (
              <div className="endcomm">
                <p className="comm-hint">
                  📜 有委托已完成，可在进入下一章前先领取奖励
                  {view.coop && view.coop.me && view.coop.me.role !== 'leader' && view.coop.me.role !== 'supply'
                    ? '（请资源位/队长领取）' : '：'}
                </p>
                {view.commissions.filter((q) => q.can_claim).map((q) => {
                  const canClaim = !view.coop
                    || view.coop.me?.role === 'leader' || view.coop.me?.role === 'supply'
                  return (
                    <button key={q.id} className="primary comm-claim-end"
                            onClick={() => claimCommission(q.id)}
                            disabled={loading || !canClaim}
                            title={canClaim ? undefined : '只有资源位/队长能领取委托'}>
                      {canClaim ? '🎁' : '🔒'} {q.kind === 'battle' ? '讨伐' : '贸易'}委托 · {q.reward.text}
                    </button>
                  )
                })}
              </div>
            )}
            <DeckView />
            {view.coop && view.status === 'won' && view.expedition?.status === 'in_progress' && (
              <p className="comm-hint">
                {view.coop.me?.role === 'leader'
                  ? '你是队长：请确认队员都已领取完奖励，然后带队进入下一章。'
                  : '本章已通关，等待队长 👑 带队进入下一章（协作金已入共享池）。'}
              </p>
            )}
            <div className="fieldrow">
              {view.status === 'won' && view.expedition && view.expedition.status === 'in_progress' && (
                (!view.coop || view.coop.me?.role === 'leader') ? (
                  <button className="primary" onClick={advanceChapter} disabled={loading}>
                    {loading ? '开章中…' : `🚪 进入第 ${view.expedition.chapter + 1} 章`}
                  </button>
                ) : (
                  <button className="primary" disabled title="只有队长可以推进章节">
                    ⏳ 等待队长开章
                  </button>
                )
              )}
              {view.expedition && !view.coop && (
                <button onClick={() => openExpeditionReplay()}>🎬 整程回放</button>
              )}
              {view.coop && (
                <button onClick={() => setCoopReplayId(view.coop.team_id)}>👥 协作回放</button>
              )}
              <button className="primary" onClick={newRun}>再来一局</button>
            </div>
          </div>
        </div>
      )}

      <div className="content">
        <div className="leftcol">
          <DeckView />
          {!view.in_battle && <PotionBelt />}
          <CompanionPanel />
          <CoopPanel />
          <CommissionPanel />
          <EncounterFlags />
          {view.unlocked_cards && <Unlocks unlocked={view.unlocked_cards} />}
        </div>
        <div className="maincol">
          {view.in_battle ? (
            <BattleView view={view} />
          ) : (
            <MapView view={view} />
          )}
          {atShop && shopDismissed && !ended && (
            <div className="shopreopen">
              <button className="primary" onClick={() => setShopDismissed(false)}>🛒 回到商店</button>
            </div>
          )}
          {hasReward && !ended && <RewardView view={view} />}
          {hasForge && !ended && <ForgeView view={view} />}
          {hasEncounter && !ended && <EncounterView view={view} />}
          {showShop && !ended && <ShopView view={view} onClose={() => setShopDismissed(true)} />}
        </div>
      </div>

      {replayId && (
        <ReplayPlayer runId={replayId} onClose={() => setReplayId(null)} />
      )}

      {expReplayId && (
        <ExpeditionReplay expeditionId={expReplayId} onClose={() => setExpReplayId(null)} />
      )}

      {coopReplayId && (
        <CoopReplay teamId={coopReplayId} onClose={() => setCoopReplayId(null)} />
      )}

      {err && <div className="error toast">{err}</div>}
    </div>
  )
}

function Unlocks({ unlocked }) {
  const { cardMeta } = useStore()
  return (
    <div className="panellist">
      <h3>已解锁卡</h3>
      <div className="unlockgrid">
        {unlocked.unlocked.map((id) => {
          const c = cardMeta(id)
          return <span key={id} className="chip">{c ? c.name : id}</span>
        })}
      </div>
    </div>
  )
}