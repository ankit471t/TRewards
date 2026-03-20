"""
Admin API routes - append these to main.py
Or import them as a router
"""

from fastapi import APIRouter
from pydantic import BaseModel

admin_router = APIRouter(prefix="/api/admin")

def is_admin(admin_id: int) -> bool:
    return admin_id in ADMIN_IDS

class CreatePromoRequest(BaseModel):
    admin_id: int
    code: str
    reward_type: str
    reward_amount: float
    max_activations: int

class SetReferrerRequest(BaseModel):
    user_id: int
    referrer_id: int

@app.post("/api/set-referrer")
async def set_referrer(req: SetReferrerRequest):
    """Set referrer for a user (called from bot on /start with ref param)"""
    if req.user_id == req.referrer_id:
        return {"ok": False, "error": "Self-referral not allowed"}
    # Only set if not already set
    user = db_exec("SELECT referrer_id FROM users WHERE user_id=%s", (req.user_id,), fetchone=True)
    if user and not user.get("referrer_id"):
        referrer = db_exec("SELECT user_id FROM users WHERE user_id=%s", (req.referrer_id,), fetchone=True)
        if referrer:
            db_exec("UPDATE users SET referrer_id=%s WHERE user_id=%s", (req.referrer_id, req.user_id))
    return {"ok": True}

@app.post("/api/admin/create-promo")
async def admin_create_promo(req: CreatePromoRequest):
    if not is_admin(req.admin_id):
        raise HTTPException(403, "Unauthorized")
    existing = db_exec("SELECT id FROM promo_codes WHERE code=%s", (req.code,), fetchone=True)
    if existing:
        raise HTTPException(400, "Promo code already exists")
    db_exec(
        """INSERT INTO promo_codes (code, reward_type, reward_amount, max_activations, is_active, created_by, created_at)
           VALUES (%s,%s,%s,%s,true,%s,NOW())""",
        (req.code, req.reward_type, req.reward_amount, req.max_activations, req.admin_id)
    )
    return {"ok": True}

@app.get("/api/admin/promo-codes")
async def admin_list_promos(admin_id: int):
    if not is_admin(admin_id):
        raise HTTPException(403, "Unauthorized")
    codes = db_exec(
        """SELECT p.*, 
           (SELECT COUNT(*) FROM promo_activations WHERE promo_id=p.id) as used
           FROM promo_codes p ORDER BY created_at DESC""",
        fetch=True
    )
    return {"codes": [dict(c) for c in (codes or [])]}

@app.delete("/api/admin/promo-codes/{code}")
async def admin_delete_promo(code: str, admin_id: int):
    if not is_admin(admin_id):
        raise HTTPException(403, "Unauthorized")
    db_exec("UPDATE promo_codes SET is_active=false WHERE code=%s", (code,))
    return {"ok": True}

@app.get("/api/admin/promo-history")
async def admin_promo_history(admin_id: int):
    if not is_admin(admin_id):
        raise HTTPException(403, "Unauthorized")
    acts = db_exec(
        """SELECT pa.*, pc.code FROM promo_activations pa
           JOIN promo_codes pc ON pa.promo_id=pc.id
           ORDER BY pa.created_at DESC LIMIT 50""",
        fetch=True
    )
    return {"activations": [dict(a) for a in (acts or [])]}

@app.get("/api/admin/payments")
async def admin_payments(admin_id: int):
    if not is_admin(admin_id):
        raise HTTPException(403, "Unauthorized")
    pays = db_exec(
        "SELECT * FROM payments ORDER BY created_at DESC LIMIT 50",
        fetch=True
    )
    return {"payments": [dict(p) for p in (pays or [])]}

@app.get("/api/admin/stats")
async def admin_stats(admin_id: int):
    if not is_admin(admin_id):
        raise HTTPException(403, "Unauthorized")
    total_users = db_exec("SELECT COUNT(*) as c FROM users", fetchone=True)
    active_today = db_exec(
        "SELECT COUNT(*) as c FROM users WHERE updated_at::date=CURRENT_DATE",
        fetchone=True
    )
    total_withdrawals = db_exec(
        "SELECT COALESCE(SUM(ton_net),0) as t FROM withdrawals WHERE status='completed'",
        fetchone=True
    )
    total_completions = db_exec("SELECT COUNT(*) as c FROM task_completions", fetchone=True)
    return {
        "total_users": total_users["c"] if total_users else 0,
        "active_today": active_today["c"] if active_today else 0,
        "total_withdrawals": float(total_withdrawals["t"]) if total_withdrawals else 0,
        "total_completions": total_completions["c"] if total_completions else 0
    }