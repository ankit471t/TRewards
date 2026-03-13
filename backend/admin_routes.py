"""
Admin routes — append these to main.py
or import from this file.

Add to main.py:
  from admin_routes import router as admin_router
  app.include_router(admin_router)
"""
import os
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel
from supabase import create_client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_KEY"]
ADMIN_KEY    = os.environ.get("ADMIN_KEY", "change-me-secret")

db = create_client(SUPABASE_URL, SUPABASE_KEY)
router = APIRouter(prefix="/admin")

def check_admin(key: str):
    if key != ADMIN_KEY:
        raise HTTPException(403, "Forbidden")

class PromoCreateIn(BaseModel):
    code: str
    reward_type: str   # coins | ton
    reward_amount: float
    max_activations: int

class PromoDeleteIn(BaseModel):
    code: str

@router.post("/create-promo")
async def create_promo(body: PromoCreateIn, x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    existing = db.table("promo_codes").select("id").eq("code", body.code.upper()).execute()
    if existing.data:
        raise HTTPException(400, "Code already exists")
    db.table("promo_codes").insert({
        "code": body.code.upper(),
        "reward_type": body.reward_type,
        "reward_amount": body.reward_amount,
        "max_activations": body.max_activations,
        "activations": 0,
    }).execute()
    return {"status": "created"}

@router.post("/delete-promo")
async def delete_promo(body: PromoDeleteIn, x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    db.table("promo_codes").delete().eq("code", body.code.upper()).execute()
    return {"status": "deleted"}

@router.get("/promos")
async def list_promos(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    res = db.table("promo_codes").select("*").execute()
    return res.data or []

@router.get("/activations")
async def list_activations(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    res = db.table("promo_activations").select("*, promo_codes(code)").order("created_at", desc=True).limit(50).execute()
    return res.data or []

@router.get("/payments")
async def list_payments(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    res = db.table("payments").select("*").order("created_at", desc=True).limit(50).execute()
    return res.data or []

@router.get("/stats")
async def admin_stats(x_admin_key: str = Header(default="")):
    check_admin(x_admin_key)
    res = db.table("users").select("telegram_id", count="exact").execute()
    return {"total_users": res.count or 0}