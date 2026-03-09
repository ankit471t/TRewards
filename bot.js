const TelegramBot=require("node-telegram-bot-api")
const pool=require("./db")

const bot=new TelegramBot(process.env.BOT_TOKEN,{polling:true})

bot.onText(/\/start (.+)/,async(msg,match)=>{

const ref=match[1]
const id=msg.from.id

await pool.query(
"INSERT INTO users (telegram_id,username,referrer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
[id,msg.from.username,ref]
)

bot.sendMessage(id,"Welcome to TRewards",{
reply_markup:{
inline_keyboard:[
[{text:"Open TRewards",web_app:{url:process.env.APP_URL}}]
]
}
})
})

bot.onText(/\/start/,async(msg)=>{

const id=msg.from.id

await pool.query(
"INSERT INTO users (telegram_id,username) VALUES ($1,$2) ON CONFLICT DO NOTHING",
[id,msg.from.username]
)

bot.sendMessage(id,"Welcome to TRewards",{
reply_markup:{
inline_keyboard:[
[{text:"Open TRewards",web_app:{url:process.env.APP_URL}}]
]
}
})
})