import React from 'react'
import { useCoopSync, coopSyncLoop } from '../coopSync'

// 协作远征连接状态：在线/已同步、断线重连中、正在补播队友动作。
// 仅在协作章节中由 App 挂载；同步完全自动，这里只做可见性与手动重连入口。
export default function CoopConnBadge() {
  const { online, connected, inflight, replaying, pendingFrames, note, error } =
    useCoopSync()

  let cls = 'ok'
  let icon = '🟢'
  let text = '已同步'
  if (!online) {
    cls = 'offline'; icon = '📵'; text = '网络已断开'
  } else if (replaying || pendingFrames > 0) {
    cls = 'catchup'; icon = '⏳'
    text = `补播队友操作中… ${pendingFrames}`
  } else if (!connected || inflight) {
    cls = 'syncing'; icon = '🔄'; text = inflight ? '同步中…' : '等待重连…'
  }

  return (
    <span className={`chip coop-conn ${cls}`} title={error || '协作状态经服务端游标增量同步；断线自动重连并局部重放队友动作'}>
      <button
        type="button"
        className="coop-conn-btn"
        onClick={() => coopSyncLoop.restart()}
        title="立即与服务端同步"
      >
        {icon} {text}
      </button>
      {note && <em className="coop-conn-note">{note}</em>}
      {error && !note && <em className="coop-conn-err">{error}</em>}
    </span>
  )
}
