const router=require("express").Router()
const pool=require("./db")

router.post("/",async(req,res)=>{

const user=req.body.user

const rewards=[10,50,80,100,300,500]
const reward=rewards[Math.floor(Math.random()*rewards.length)]

await pool.query(
"UPDATE users SET coins=coins+$1 WHERE telegram_id=$2",
[reward,user]
)

res.json({reward})
})

module.exports=router