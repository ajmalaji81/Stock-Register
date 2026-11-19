"""Staff accounts, stock adjustments and the activity timeline."""
from __future__ import annotations

import json
from datetime import datetime

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..core.errors import StockError
from ..core.jsmath import round3
from ..core.permissions import role_label
from ..core.plans import effective_plan
from ..models import ActivityLog, Godown, LedgerEntry, StaffMember, Stock, User
from ..schemas import ActivityQuery, AdjustmentInput, StaffCreateInput, StaffUpdateInput
from .activity import iso, log_activity
from .actor import Actor, assert_godown_access
from .auth import hash_password
from .stock import StockEntryInput, apply_stock_entry, fmt_num, get_godown, get_item


def _parse_ids(raw: str) -> list[str]:
    try:
        v = json.loads(raw)
    except (TypeError, ValueError):
        return []
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def to_dto(s: StaffMember) -> dict:
    return {
        "id": s.id, "name": s.name, "email": s.email, "role": s.role, "godownIds": _parse_ids(s.godownIds),
        "active": s.active, "createdAt": iso(s.createdAt), "avatar": s.avatar,
    }


def assert_staff_plan(actor: Actor) -> None:
    """Staff logins are a Pro feature (Lifetime Pro or the 90-day trial)."""
    if effective_plan(actor.owner.plan, actor.owner.trialEndsAt) == "FREE":
        raise StockError("Staff logins are a Pro feature. Get Lifetime Pro to add staff.", 402, "LIMIT")


def _clean_godown_ids(db: Session, account_id: str, ids: list[str]) -> list[str]:
    """Only real godowns of this account; [] means all godowns."""
    if not ids:
        return []
    found = db.execute(select(Godown.id).where(Godown.userId == account_id, Godown.id.in_(ids))).scalars().all()
    if len(found) != len(set(ids)):
        raise StockError("One of the selected godowns doesn't exist", 400)
    return list(found)


def list_staff(db: Session, actor: Actor) -> list[dict]:
    rows = db.execute(select(StaffMember).where(StaffMember.userId == actor.account_id).order_by(StaffMember.createdAt, StaffMember.id)).scalars().all()
    return [to_dto(r) for r in rows]


def create_staff(db: Session, actor: Actor, inp: StaffCreateInput) -> dict:
    assert_staff_plan(actor)
    user = db.execute(select(User.id).where(User.email == inp.email)).first()
    staff = db.execute(select(StaffMember.id).where(StaffMember.email == inp.email)).first()
    if user or staff:
        raise StockError("This email already has a GodownBook login. Use a different email.", 409)
    godown_ids = _clean_godown_ids(db, actor.account_id, inp.godownIds)
    row = StaffMember(
        userId=actor.account_id, name=inp.name, email=inp.email, passwordHash=hash_password(inp.password), role=inp.role,
        godownIds=json.dumps(godown_ids, separators=(",", ":")),
    )
    db.add(row)
    db.flush()
    log_activity(db, actor, "staff.create", f"{row.name} ({role_label(inp.role)})")
    return to_dto(row)


def update_staff(db: Session, actor: Actor, staff_id: str, inp: StaffUpdateInput) -> dict:
    existing = db.execute(select(StaffMember).where(StaffMember.id == staff_id, StaffMember.userId == actor.account_id)).scalar_one_or_none()
    if existing is None:
        raise StockError("Staff member not found", 404)
    old_role, old_active, old_name = existing.role, existing.active, existing.name
    # Re-activating someone counts as adding a login.
    if inp.active is True and not existing.active:
        assert_staff_plan(actor)
    if inp.name is not None:
        existing.name = inp.name
    if inp.role is not None:
        existing.role = inp.role
    if inp.active is not None:
        existing.active = inp.active
    if inp.godownIds is not None:
        existing.godownIds = json.dumps(_clean_godown_ids(db, actor.account_id, inp.godownIds), separators=(",", ":"))
    if inp.password is not None:
        existing.passwordHash = hash_password(inp.password)
    db.flush()
    changes = [
        c
        for c in (
            f"role → {role_label(inp.role)}" if inp.role is not None and inp.role != old_role else "",
            ("activated" if inp.active else "deactivated") if inp.active is not None and inp.active != old_active else "",
            "godown access changed" if inp.godownIds is not None else "",
            "password reset" if inp.password is not None else "",
            f"renamed to {inp.name}" if inp.name is not None and inp.name != old_name else "",
        )
        if c
    ]
    log_activity(db, actor, "staff.update", f"{existing.name}" + (f": {', '.join(changes)}" if changes else ""))
    return to_dto(existing)


def delete_staff(db: Session, actor: Actor, staff_id: str) -> None:
    existing = db.execute(select(StaffMember).where(StaffMember.id == staff_id, StaffMember.userId == actor.account_id)).scalar_one_or_none()
    if existing is None:
        raise StockError("Staff member not found", 404)
    name = existing.name
    db.execute(delete(StaffMember).where(StaffMember.id == staff_id))
    db.expire_all()
    log_activity(db, actor, "staff.delete", name)


# ---------------- Adjustments ----------------


def record_adjustment(db: Session, actor: Actor, inp: AdjustmentInput) -> dict:
    assert_godown_access(actor, inp.godownId)
    item = get_item(db, actor.account_id, inp.itemId)
    godown = get_godown(db, actor.account_id, inp.godownId)
    qty = db.execute(select(Stock.quantity).where(Stock.itemId == item.id, Stock.godownId == godown.id)).scalar_one_or_none()
    current = round3(qty or 0)
    delta = round3(inp.newQty - current if inp.newQty is not None else (inp.delta or 0))
    if delta == 0:
        raise StockError("No change: the count matches the current stock.")
    balance, _ = apply_stock_entry(
        db, actor,
        StockEntryInput(
            itemId=item.id, godownId=godown.id, type="ADJUSTMENT", qty=delta, rate=item.purchasePrice,
            party="Stock adjustment", remarks=inp.reason, date=inp.date,
        ),
    )
    log_activity(
        db, actor, "stock.adjust",
        f"{item.name} @ {godown.name}: {'+' if delta > 0 else ''}{fmt_num(delta)} {item.unit} ({inp.reason})",
    )
    return {"delta": delta, "balance": balance}


def list_adjustments(db: Session, actor: Actor, limit: int = 100) -> list[dict]:
    stmt = select(LedgerEntry).where(LedgerEntry.userId == actor.account_id, LedgerEntry.type == "ADJUSTMENT")
    if actor.godown_ids is not None:
        stmt = stmt.where(LedgerEntry.godownId.in_(actor.godown_ids))
    rows = db.execute(stmt.order_by(LedgerEntry.createdAt.desc(), LedgerEntry.id.desc()).limit(limit)).scalars().all()
    return [
        {
            "id": r.id, "date": r.date, "itemName": r.item.name, "unit": r.item.unit, "godownName": r.godown.name,
            "delta": r.qtyIn if r.qtyIn > 0 else -r.qtyOut, "balance": r.balance, "reason": r.remarks,
            "actorName": r.actorName, "createdAt": iso(r.createdAt),
        }
        for r in rows
    ]


# ---------------- Activity ----------------


def list_activity(db: Session, actor: Actor, q: ActivityQuery) -> dict:
    conds = [ActivityLog.userId == actor.account_id]
    if q.actorId:
        conds.append(ActivityLog.actorId == q.actorId)
    if q.action:
        conds.append(ActivityLog.action.startswith(q.action, autoescape=True))
    # Dates are entered as local calendar days (the TS app used local time too).
    if q.from_:
        conds.append(ActivityLog.createdAt >= datetime.fromisoformat(f"{q.from_}T00:00:00").astimezone())
    if q.to:
        conds.append(ActivityLog.createdAt <= datetime.fromisoformat(f"{q.to}T23:59:59.999").astimezone())
    total = db.execute(select(func.count()).select_from(ActivityLog).where(*conds)).scalar_one()
    rows = db.execute(
        select(ActivityLog).where(*conds).order_by(ActivityLog.createdAt.desc(), ActivityLog.id.desc()).offset((q.page - 1) * q.size).limit(q.size)
    ).scalars().all()
    actors = db.execute(
        select(ActivityLog.actorId, ActivityLog.actorName).where(ActivityLog.userId == actor.account_id).distinct()
    ).all()
    return {
        "total": total, "page": q.page, "size": q.size,
        "items": [
            {"id": r.id, "actorId": r.actorId, "actorName": r.actorName, "action": r.action, "detail": r.detail, "createdAt": iso(r.createdAt)}
            for r in rows
        ],
        "actors": [{"id": a.actorId, "name": a.actorName} for a in actors],
    }
