const tg=window.Telegram.WebApp

tg.expand()

const user=tg.initDataUnsafe.user

function page(p){

const content=document.getElementById("content")

if(p==="home"){
content.innerHTML="<h2>Balance</h2>"
}

if(p==="tasks"){
content.innerHTML="<h2>Tasks</h2>"
}

if(p==="friends"){
content.innerHTML="<h2>Friends</h2>"
}

if(p==="wallet"){
content.innerHTML="<h2>Wallet</h2>"
}

}

page("home")