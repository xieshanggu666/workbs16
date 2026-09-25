"""多人协作远征（2.9.0）路由：队伍大厅 / 开赛 / 推进 / 整程回放。

鉴权模型：本服务无独立账号体系，成员身份用「入会时拿到的成员 id」表达
（令牌只在加入/建队响应里下发一次，客户端自行保存）。写动作一律带
member_id，服务端在任何状态变更之前核验成员归属与角色权限边界：
- 越权（非队长做管理/角色不符做章节动作）-> 403 且零副作用；
- 状态过期/重复开赛/重复推进 -> 409；
- 入队码非法/人数不足等业务校验 -> 400。
"""
from fastapi import APIRouter, HTTPException

from .. import service
from ..schemas import (AdvanceRequest, AssignRoleRequest, CoopAdvanceRequest,
                       CoopMemberRequest, CoopSyncRequest, CreateCoopTeamRequest,
                       JoinCoopTeamRequest)

router = APIRouter(prefix="/api/coop", tags=["coop"])


def _http_error(e):
    """统一把 service 异常映射到 HTTP 状态（与 run/expedition 路由同构）。"""
    if isinstance(e, service.PermissionDenied):
        raise HTTPException(status_code=403, detail=str(e))
    if isinstance(e, (service.DuplicateReward, service.StaleState)):
        raise HTTPException(status_code=409, detail=str(e))
    raise HTTPException(status_code=400, detail=str(e))


@router.post("/teams")
def create_team(body: CreateCoopTeamRequest):
    try:
        return service.create_coop_team(
            name=body.name, captain_name=body.captain_name,
            seed=body.seed, chapters=body.chapters)
    except service.InvalidAction as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/teams/join")
def join_team(body: JoinCoopTeamRequest):
    try:
        return service.join_coop_team(body.code, body.member_name,
                                      request_id=body.request_id)
    except service.DuplicateReward as e:
        raise HTTPException(status_code=409, detail=str(e))
    except service.InvalidAction as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/teams/{team_id}")
def get_team(team_id: str, member_id: str | None = None):
    try:
        return service.get_coop_team(team_id, member_id=member_id)
    except service.InvalidAction as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/teams/{team_id}/roles")
def assign_role(team_id: str, body: AssignRoleRequest):
    try:
        return service.assign_role(team_id, body.member_id, body.target_id, body.role,
                                   request_id=body.request_id)
    except Exception as e:  # 权限/冲突/非法统一映射
        _http_error(e)


@router.post("/teams/{team_id}/leave")
def leave_team(team_id: str, body: CoopMemberRequest):
    try:
        return service.leave_team(team_id, body.member_id, request_id=body.request_id)
    except Exception as e:
        _http_error(e)


@router.post("/teams/{team_id}/disband")
def disband_team(team_id: str, body: CoopMemberRequest):
    try:
        return service.disband_team(team_id, body.member_id, request_id=body.request_id)
    except Exception as e:
        _http_error(e)


@router.post("/teams/{team_id}/start")
def start_team(team_id: str, body: CoopMemberRequest):
    try:
        return service.start_coop_expedition(team_id, body.member_id,
                                             request_id=body.request_id)
    except Exception as e:
        _http_error(e)


@router.post("/teams/{team_id}/advance")
def advance_team(team_id: str, body: CoopAdvanceRequest):
    try:
        return service.advance_coop_expedition(team_id, body.member_id,
                                               request_id=body.request_id)
    except Exception as e:
        _http_error(e)


@router.get("/teams/{team_id}/expedition")
def get_team_expedition(team_id: str, member_id: str | None = None):
    try:
        return service.get_coop_expedition(team_id, member_id=member_id)
    except service.InvalidAction as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/teams/{team_id}/sync")
def sync_team(team_id: str, body: CoopSyncRequest):
    """断线重连 / 事件增量同步：成员鉴权 + 服务端游标，回时间线增量、动作帧
    增量（与整局回放同构、逐位校验）与权威快照；游标失效时 reset 全量对齐。"""
    try:
        cursor = body.cursor.model_dump() if body.cursor is not None else None
        return service.coop_sync(team_id, body.member_id, cursor=cursor)
    except Exception as e:  # 权限 403 / 队伍不存在 400 统一映射
        _http_error(e)


@router.get("/teams/{team_id}/replay")
def team_replay(team_id: str):
    try:
        return service.coop_team_replay(team_id)
    except service.InvalidAction as e:
        raise HTTPException(status_code=400, detail=str(e))
