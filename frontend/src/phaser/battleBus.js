// React <-> Phaser 事件总线。React 在播放服务端结算日志时调用 emit，Phaser 场景订阅并播放动画。
const _listeners = new Map()

export const bus = {
  on(event, fn) {
    if (!_listeners.has(event)) _listeners.set(event, [])
    _listeners.get(event).push(fn)
    return () => {
      const arr = _listeners.get(event) || []
      _listeners.set(
        event,
        arr.filter((f) => f !== fn),
      )
    }
  },
  emit(event, payload) {
    ;(_listeners.get(event) || []).forEach((fn) => fn(payload))
  },
  clear() {
    _listeners.clear()
  },
}

// 把一串结算事件交给 Phaser 按顺序播放；resolve 时整条连锁已播完。
// 本地动作（BattleView）与协作增量同步（coopSync）共用同一套播放，
// 保证「自己操作」与「队友操作补播」的逐帧表现一致。超时兜底防止动画
// 异常让操作永久锁死。
export function playBattleLog(entries, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const list = (entries || []).filter(Boolean)
    if (!list.length) return resolve()
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      off()
      clearTimeout(timer)
      resolve()
    }
    const off = bus.on('queue_done', finish)
    const timer = setTimeout(finish, timeoutMs)
    bus.emit('queue', list)
  })
}