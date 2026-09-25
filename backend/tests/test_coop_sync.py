"""多人协作远征（规则 2.10.0）：断线重连 / 事件增量同步 / 服务端游标 / 冲突恢复。

覆盖：
- 首次同步无游标 -> reset 全量权威快照（含 coop 权限摘要，视角为请求成员）
- 队友动作后增量同步：只回游标之后的动作帧，逐帧 check=ok、帧视口与在线
  /act 权威响应逐位一致；幂等轮询无变化时 changed=false、steps 为空
- 游标携带的每帧 actor 与操作者一致；战斗帧带结算事件可供前端局部重放
- 冲突恢复：伪造/未来 run_seq（gap）、rev 漂移、换章 run_id 变化 -> reset
  全量快照与 reset_reason，客户端据此整体对齐，绝不基于过期状态分叉
- 换章（队长 advance）后观战方下一次同步检出 run_changed 并拿到新章快照
- 权限：非成员/未带身份同步 403；不存在队伍 400
- 只读隔离：同步不写存档/日志/解锁（前后 rev 与日志行数不变）
- 全程断线模拟：观战方不同步期间多名成员交替行动，一次同步补齐所有增量帧，
  且这些帧与整局回放 /replay 的对应帧视口逐位一致
"""
import pytest

from app import db, service
from app.coop import LEADER, SUPPLY

from test_coop import _make_team, _join, _set_role, _start, _squad


def _sync(client, team_id, member_id, cursor=None):
    body = {"member_id": member_id}
    if cursor is not None:
        body["cursor"] = cursor
    return client.post(f"/api/coop/teams/{team_id}/sync", json=body)


def _choose(client, rid, node, member_id):
    return client.post(f"/api/runs/{rid}/act",
                       json={"action": "choose_node", "node": node,
                             "member_id": member_id})


def _resume(client, rid, member_id=None):
    url = f"/api/runs/{rid}/resume"
    if member_id:
        url += f"?member_id={member_id}"
    return client.get(url).json()


def _coop_win_chapter(client, rid, leader_id):
    """协作章节通关：直改存档把队长挪到首领前一格，选首领（资源域）后一击获胜。

    与 test_expedition._win_chapter 同款便捷路径，区别是每个动作都带 member_id
    （协作 run 未带身份会被 403）。
    """
    rec = service.load_run(rid)
    row3 = next(n for n, nd in rec["map"]["nodes"].items() if nd.get("row") == 3)
    rec["state"]["position"] = row3
    db.save_run(rid, rec["state"]["status"], rec["state"]["position"], rec["state"])
    r = client.post(f"/api/runs/{rid}/act",
                    json={"action": "choose_node", "node": "boss",
                          "member_id": leader_id})
    assert r.status_code == 200, r.text
    assert r.json()["run"]["in_battle"] is True
    rec = service.load_run(rid)
    rec["state"]["battle"]["entities"]["enemy"]["hp"] = 1
    db.save_run(rid, rec["state"]["status"], rec["state"]["position"], rec["state"])
    view = _resume(client, rid, leader_id)
    strike = next(h for h in view["battle"]["hand"]
                  if (h["id"] if isinstance(h, dict) else h) == "strike")
    uid = strike["uid"] if isinstance(strike, dict) else strike
    r = client.post(f"/api/runs/{rid}/act",
                    json={"action": "play", "card": uid, "member_id": leader_id})
    assert r.status_code == 200, r.text
    return r.json()


# ---------- 首次同步 / 增量 / 幂等 ----------
def test_first_sync_resets_with_authoritative_snapshot(client):
    s = _squad(client)
    r = _sync(client, s["team_id"], s["combat_id"])
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["reset"] is True
    assert data["reset_reason"] == "first_sync"
    snap = data["snapshot"]
    assert snap["run_id"] == s["run_id"]
    assert snap["rev"] == 1
    # 协作权限摘要以请求成员视角下发
    assert snap["coop"]["me"]["id"] == s["combat_id"]
    assert snap["coop"]["me"]["role"] == "combat"
    cur = data["cursor"]
    assert cur["run_id"] == s["run_id"]
    assert cur["run_seq"] >= 1 and cur["rev"] == 1


def test_delta_sync_returns_only_new_frames_matching_live_views(client):
    s = _squad(client)
    # 观战方（战斗位）先做首次同步拿到游标
    cur = _sync(client, s["team_id"], s["combat_id"]).json()["cursor"]

    # 资源位队长选一个可达节点（进战斗）
    snap0 = _resume(client, s["run_id"], s["leader_id"])
    node = snap0["reachable"][0]["id"]
    act = _choose(client, s["run_id"], node, s["leader_id"])
    assert act.status_code == 200
    act_data = act.json()
    live = act_data["run"]

    data = _sync(client, s["team_id"], s["combat_id"], cur).json()
    assert data["reset"] is False
    assert data["changed"] is True
    assert len(data["steps"]) == 1
    step = data["steps"][0]
    assert step["seq"] == cur["run_seq"] + 1
    assert step["action"] == "choose_node"
    assert step["check"] == "ok"               # 逐帧校验点通过（逐帧一致）
    assert step["payload"]["actor"] == s["leader_id"]
    assert step["view"]["coop"]["me"]["id"] == s["combat_id"]
    # 增量帧终态与在线 /act 权威响应逐位一致（位置/战斗状态）
    assert step["view"]["position"] == live["position"]
    assert step["view"]["in_battle"] == live["in_battle"]
    assert data["snapshot"]["position"] == live["position"]
    assert data["rev"] == act_data["rev"]
    # 增量帧逐帧 rev 与 seq 一一对应（驱动客户端继续提交动作的乐观版本）
    assert step["view"]["rev"] == step["seq"] == act_data["rev"]
    # 快照 rev 与游标 rev 一致，客户端落快照即可继续合法 act
    assert data["snapshot"]["rev"] == data["cursor"]["rev"] == data["rev"]

    # 幂等轮询：同一游标再同步 -> 无变化、无帧
    idle = _sync(client, s["team_id"], s["combat_id"], data["cursor"]).json()
    assert idle["changed"] is False
    assert idle["steps"] == [] and idle["snapshot"] is None
    assert idle["cursor"] == data["cursor"]


def test_sync_is_read_only(client):
    s = _squad(client)
    before = service.load_run(s["run_id"])
    events_before = len(db.load_events(s["run_id"]))
    for _ in range(3):
        _sync(client, s["team_id"], s["supply_id"],
              {"team_seq": 0, "run_id": s["run_id"], "run_seq": 1, "rev": 1})
    after = service.load_run(s["run_id"])
    assert after["rev"] == before["rev"]
    assert len(db.load_events(s["run_id"])) == events_before


# ---------- 断线期间多动作一次补齐 ----------
def test_offline_window_replayed_in_one_sync_and_matches_full_replay(client):
    s = _squad(client, seed=55)
    rid = s["run_id"]
    cur = _sync(client, s["team_id"], s["combat_id"]).json()["cursor"]

    # 「断线期间」：队长连走两个非战斗动作（选节点->打牌由战斗位）。
    # 选一个不直接开战的路线不可保证，这里交替：队长选节点（开战），战斗位打牌
    v = _resume(client, rid, s["leader_id"])
    node = v["reachable"][0]["id"]
    assert _choose(client, rid, node, s["leader_id"]).status_code == 200
    v = _resume(client, rid, s["combat_id"])
    hand = v["battle"]["hand"]
    pick = next((h for h in hand if (h.get("id") if isinstance(h, dict) else h) == "strike"),
                hand[0])
    uid = pick["uid"] if isinstance(pick, dict) else pick
    played = client.post(f"/api/runs/{rid}/act",
                         json={"action": "play", "card": uid,
                               "member_id": s["combat_id"]})
    assert played.status_code == 200

    # 观战方一次同步补齐 2 帧
    data = _sync(client, s["team_id"], s["supply_id"], cur).json()
    assert data["reset"] is False
    assert [st["action"] for st in data["steps"]] == ["choose_node", "play"]
    assert all(st["check"] == "ok" for st in data["steps"])
    actors = [st["payload"]["actor"] for st in data["steps"]]
    assert actors == [s["leader_id"], s["combat_id"]]
    # 战斗帧必须携带结算事件（前端局部重放按序播放动画）
    assert data["steps"][1]["events"]
    assert data["steps"][1]["view"]["in_battle"] is True

    # 增量帧与整局回放 /replay 的对应帧逐位一致（同一回放内核）
    full = client.get(f"/api/runs/{rid}/replay").json()
    full_by_seq = {st["seq"]: st for st in full["steps"]}
    for st in data["steps"]:
        f = full_by_seq[st["seq"]]
        assert f["check"] == "ok"
        assert st["view"]["position"] == f["view"]["position"]
        assert st["view"]["in_battle"] == f["view"]["in_battle"]
        assert st["check"] == f["check"]


def test_delta_frames_carry_requester_permission_scope(client):
    """重放帧的 coop 摘要是【请求者】视角：战斗位看到的是战斗权限，且越权
    动作仍被服务端 403 拦截（局部重放不改变服务端权威权限边界）。"""
    s = _squad(client, seed=66)
    rid = s["run_id"]
    # 资源位视角游标
    cur_sup = _sync(client, s["team_id"], s["supply_id"]).json()["cursor"]

    # 队长选节点（资源域）进入战斗（start 的可达节点即首场战斗/事件）
    v = _resume(client, rid, s["leader_id"])
    node = v["reachable"][0]["id"]
    assert _choose(client, rid, node, s["leader_id"]).status_code == 200
    assert _resume(client, rid, s["supply_id"])["in_battle"] is True

    data = _sync(client, s["team_id"], s["supply_id"], cur_sup).json()
    assert len(data["steps"]) == 1
    frame_coop = data["steps"][0]["view"]["coop"]
    assert frame_coop["me"]["id"] == s["supply_id"]
    assert frame_coop["me"]["role"] == "supply"
    # 权限表原样下发（前端禁用按钮的依据；权威仍在服务端）
    assert set(frame_coop["permissions"]) == {"battle_actions", "resource_actions"}
    # 资源位即便通过同步帧看到战斗开始，提交战斗动作仍 403 且零副作用
    forbidden = client.post(
        f"/api/runs/{rid}/act",
        json={"action": "end_turn", "member_id": s["supply_id"]})
    assert forbidden.status_code == 403
    after = service.load_run(rid)
    assert after["rev"] == data["cursor"]["rev"]  # 越权被拒，存档 rev 未推进



# ---------- 冲突恢复 ----------
def test_gap_and_future_seq_force_reset(client):
    s = _squad(client)
    cur = _sync(client, s["team_id"], s["combat_id"]).json()["cursor"]
    # 伪造一个「未来」的 run_seq
    bad = {"team_seq": cur["team_seq"], "run_id": s["run_id"],
           "run_seq": cur["run_seq"] + 50, "rev": cur["rev"]}
    data = _sync(client, s["team_id"], s["combat_id"], bad).json()
    assert data["reset"] is True and data["reset_reason"] == "gap"
    assert data["snapshot"]["run_id"] == s["run_id"]


def test_rev_drift_without_new_frames_force_reset(client):
    s = _squad(client)
    cur = _sync(client, s["team_id"], s["combat_id"]).json()["cursor"]
    bad = dict(cur)
    bad["rev"] = cur["rev"] - 3
    data = _sync(client, s["team_id"], s["combat_id"], bad).json()
    assert data["reset"] is True and data["reset_reason"] == "rev_drift"
    assert data["snapshot"]["rev"] == cur["rev"]


def test_unknown_run_id_force_run_changed_reset(client):
    s = _squad(client)
    cur = _sync(client, s["team_id"], s["combat_id"]).json()["cursor"]
    bad = {"team_seq": cur["team_seq"], "run_id": "r_other",
           "run_seq": 1, "rev": 1}
    data = _sync(client, s["team_id"], s["combat_id"], bad).json()
    assert data["reset"] is True and data["reset_reason"] == "run_changed"
    assert data["run_changed"] is True
    assert data["cursor"]["run_id"] == s["run_id"]


def test_chapter_advance_detected_as_run_changed(client):
    """队长打完本章并推进：观战方游标仍指向上一章 -> 检出换章并拿新章快照。"""
    s = _squad(client, seed=3, chapters=2)
    rid = s["run_id"]
    cur = _sync(client, s["team_id"], s["combat_id"]).json()["cursor"]

    # 队长（两域皆可）合法打完本章首领（协作 run 的动作必须带 member_id）
    win = _coop_win_chapter(client, rid, s["leader_id"])
    assert win["run"]["status"] == "won"
    # 推进到第 2 章
    adv = client.post(f"/api/coop/teams/{s['team_id']}/advance",
                      json={"member_id": s["leader_id"]})
    assert adv.status_code == 200, adv.text
    new_rid = adv.json()["run"]["run_id"]
    assert new_rid != rid

    # 观战方仍持第 1 章游标同步：run_changed -> reset 到第 2 章全量快照
    data = _sync(client, s["team_id"], s["combat_id"], cur).json()
    assert data["reset"] is True and data["reset_reason"] == "run_changed"
    assert data["run_changed"] is True
    assert data["snapshot"]["run_id"] == new_rid
    assert data["snapshot"]["coop"]["chapter"] == 2
    # 队伍时间线增量包含本章通关事件
    kinds = [e["kind"] for e in data["team_events"]]
    assert "chapter_clear" in kinds

    # 对齐后再次同步：第 2 章全新 run，游标已是新 run，无增量
    follow = _sync(client, s["team_id"], s["combat_id"], data["cursor"]).json()
    assert follow["reset"] is False and follow["steps"] == []


# ---------- 权限 ----------
def test_sync_requires_team_membership(client):
    s = _squad(client)
    # 未带身份
    r = client.post(f"/api/coop/teams/{s['team_id']}/sync", json={})
    assert r.status_code == 422  # pydantic：member_id 必填
    # 伪造成员
    r = _sync(client, s["team_id"], "m_nobody")
    assert r.status_code == 403
    # 不存在队伍
    r = _sync(client, "t_nope", s["leader_id"])
    assert r.status_code == 400


def test_sync_before_start_returns_lobby_only(client):
    team, leader_id, _ = _make_team(client)
    _, other_id = _join(client, team["code"], "队员")
    r = _sync(client, team["id"], other_id)
    assert r.status_code == 200
    data = r.json()
    assert data["run"] is None and data["snapshot"] is None
    assert data["reset"] is False
    # 队员能看到 form/join 两条时间线增量
    assert [e["kind"] for e in data["team_events"]] == ["form", "join"]
    # 再同步无变化
    idle = _sync(client, team["id"], other_id, data["cursor"]).json()
    assert idle["changed"] is False and idle["team_events"] == []
