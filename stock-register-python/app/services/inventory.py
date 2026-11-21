"""Item groups. Item.category holds the group's name; ItemGroup rows make the groups exist before they have items."""
from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..core.errors import StockError
from ..models import Item, ItemGroup
from .activity import log_activity
from .actor import Actor, assert_can


def _clean(name: str) -> str:
    n = " ".join((name or "").split())
    if not 1 <= len(n) <= 60:
        raise StockError("Group name is required (up to 60 characters)")
    return n


def _same_name(db: Session, account_id: str, name: str, except_id: str = ""):
    stmt = select(ItemGroup).where(ItemGroup.userId == account_id, func.lower(ItemGroup.name) == name.lower())
    if except_id:
        stmt = stmt.where(ItemGroup.id != except_id)
    return db.execute(stmt).scalars().first()


def ensure_group(db: Session, account_id: str, name: str) -> None:
    """Make sure a group exists for an item's category (no-op for blank names or ones already there)."""
    name = " ".join((name or "").split())[:60]
    if name and _same_name(db, account_id, name) is None:
        db.add(ItemGroup(userId=account_id, name=name))
        db.flush()


def list_groups(db: Session, actor: Actor) -> list[dict]:
    """Every group with its item count. Categories typed on items before groups existed become groups here."""
    if not (actor.can("items.manage") or actor.can("reports.view")):
        assert_can(actor, "items.manage")
    uid = actor.account_id
    cats = db.execute(select(Item.category, func.count()).where(Item.userId == uid, Item.category != "").group_by(Item.category)).all()
    for cat, _ in cats:
        ensure_group(db, uid, cat)
    counts: dict[str, int] = {}
    for cat, n in cats:
        counts[cat.strip().lower()] = counts.get(cat.strip().lower(), 0) + n
    groups = db.execute(select(ItemGroup).where(ItemGroup.userId == uid).order_by(func.lower(ItemGroup.name))).scalars().all()
    return [{"id": g.id, "name": g.name, "items": counts.get(g.name.lower(), 0)} for g in groups]


def group_names(db: Session, actor: Actor) -> list[str]:
    """For the category suggestions on the item form."""
    return [g["name"] for g in list_groups(db, actor)] if (actor.can("items.manage") or actor.can("reports.view")) else []


def create_group(db: Session, actor: Actor, name: str) -> None:
    assert_can(actor, "items.manage")
    name = _clean(name)
    if _same_name(db, actor.account_id, name):
        raise StockError(f'"{name}" already exists', 409)
    db.add(ItemGroup(userId=actor.account_id, name=name))
    db.flush()
    log_activity(db, actor, "itemgroup.create", name)


def _get(db: Session, account_id: str, group_id: str) -> ItemGroup:
    g = db.execute(select(ItemGroup).where(ItemGroup.id == group_id, ItemGroup.userId == account_id)).scalar_one_or_none()
    if g is None:
        raise StockError("Item group not found", 404)
    return g


def rename_group(db: Session, actor: Actor, group_id: str, name: str) -> None:
    assert_can(actor, "items.manage")
    g = _get(db, actor.account_id, group_id)
    name = _clean(name)
    if _same_name(db, actor.account_id, name, except_id=g.id):
        raise StockError(f'"{name}" already exists', 409)
    old, g.name = g.name, name
    db.execute(update(Item).where(Item.userId == actor.account_id, func.lower(Item.category) == old.lower()).values(category=name))
    db.flush()
    log_activity(db, actor, "itemgroup.update", f"{old} -> {name}")


def delete_group(db: Session, actor: Actor, group_id: str) -> None:
    assert_can(actor, "items.manage")
    g = _get(db, actor.account_id, group_id)
    n = db.execute(select(func.count()).select_from(Item).where(Item.userId == actor.account_id, func.lower(Item.category) == g.name.lower())).scalar_one()
    if n:
        raise StockError(f"{n} item(s) are in this group. Move them to another group first.", 409)
    name = g.name
    db.delete(g)
    db.flush()
    log_activity(db, actor, "itemgroup.delete", name)
