require("dotenv").config()

const express=require("express")
const cors=require("cors")

const userRoutes=require("./user")
const taskRoutes=require("./tasks")
const spinRoutes=require("./spin")
const referralRoutes=require("./referral")
const walletRoutes=require("./wallet")
const promoRoutes=require("./promo")
const advertiserRoutes=require("./advertiser")

const app=express()

app.use(cors())
app.use(express.json())
app.use(express.static(__dirname))

app.use("/api/user",userRoutes)
app.use("/api/tasks",taskRoutes)
app.use("/api/spin",spinRoutes)
app.use("/api/referral",referralRoutes)
app.use("/api/wallet",walletRoutes)
app.use("/api/promo",promoRoutes)
app.use("/api/advertiser",advertiserRoutes)

const PORT=process.env.PORT||3000

app.listen(PORT,()=>{
console.log("Server running "+PORT)
})

require("./bot")