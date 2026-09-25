// 协作章节行动的统一冲突恢复参数：视图带 coop 身份时，让 api.handleActError
// 走服务端游标增量同步（队友动作局部重放 / 游标失效全量对齐），而不是整视口
// resume。非协作视图返回空对象，行为与旧版完全一致。
export function coopRecoverOpts(view) {
  const teamId = view?.coop?.team_id
  const memberId = view?.coop?.me?.id
  return teamId && memberId ? { coop: { teamId, memberId } } : {}
}
