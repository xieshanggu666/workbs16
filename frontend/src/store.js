import { create } from 'zustand'

const initialState = {
  cards: [],            // 全部卡牌元数据
  runId: null,
  view: null,           // 服务端 _public_view
  meta: { cards: [], enemies: [] },
  log: [],
  playing: false,
  error: null,
  // 协作增量同步（2.10.0）：
  // acting——本地动作提交/动画播放中，同步器本轮暂停（避免与增量应用交错）；
  // syncing——同步器正在补播队友动作，本地操作暂时禁用；
  // coopFeed——队伍动态（增量事件流，最近若干条，侧栏展示）；
  // coopSyncNow——同步器注册的「立即同步」入口（409 冲突恢复时调用）
  acting: false,
  syncing: false,
  coopFeed: [],
  coopSyncNow: null,
  _feedSeq: 0,          // 队伍动态 key 自增器（pushCoopFeed 内部使用）
}

const FEED_LIMIT = 12

export const useStore = create((set, get) => ({
  ...initialState,

  setCards: (cards) => set({ cards }),

  applyRun: (run) => set({ view: run, runId: run.run_id }),

  setRunId: (id) => set({ runId: id }),

  setMeta: (meta) => set({ meta }),

  setLog: (log) => set({ log }),

  setError: (err) => set({ error: err }),

  setPlaying: (playing) => set({ playing }),

  setActing: (acting) => set({ acting }),

  setSyncing: (syncing) => set({ syncing }),

  setCoopSyncNow: (fn) => set({ coopSyncNow: fn }),

  // 追加队伍动态（最新在前），保留最近 FEED_LIMIT 条；key 在此统一自增分配，
  // 避免跨章节 run 的日志 seq 复用导致 React key 冲突
  pushCoopFeed: (items) => set((s) => {
    const base = s._feedSeq || 0
    const tagged = (items || []).map((it, i) => ({ ...it, key: `f${base + i}` }))
    return {
      coopFeed: [...tagged, ...s.coopFeed].slice(0, FEED_LIMIT),
      _feedSeq: base + tagged.length,
    }
  }),

  clearCoopFeed: () => set({ coopFeed: [], _feedSeq: 0 }),

  cardMeta: (id) => get().cards.find((c) => c.id === id) || null,
}))

// 手牌/牌组项兼容两种形态：旧档裸 id（字符串）或卡牌实例 {uid,id,cost,forges}
export function cardRef(item) {
  return typeof item === 'string' ? item : item?.uid
}

export function cardIdOf(item) {
  return typeof item === 'string' ? item : item?.id
}

// 服务端卡牌效果标签 -> 中文简介
export function cardBadge(card) {
  if (!card) return ''
  switch (card.type) {
    case 'attack': return '攻击'
    case 'skill': return '技能'
    case 'power': return '能力'
    default: return ''
  }
}