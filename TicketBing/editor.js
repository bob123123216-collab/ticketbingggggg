
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

process.loadEnvFile();

const TOKEN = process.env.YAPPER_TOKEN;
if (!TOKEN) throw new Error("Missing YAPPER_TOKEN in .env");

const FILE = path.join(__dirname, "config.json");
const PORT = 3847;

const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Ticket Panel Builder</title>
<style>
* {box-sizing:border-box}
body {
  margin:0;background:#101116;color:white;
  font:15px Arial,sans-serif;
}
header {
  padding:20px 30px;border-bottom:1px solid #292b35;
  font-size:21px;font-weight:bold;
}
main {
  display:grid;grid-template-columns:1fr 1fr;
  gap:25px;max-width:1200px;margin:auto;padding:25px;
}
.panel {
  background:#1b1d25;border:1px solid #32343e;
  border-radius:14px;padding:22px;
}
h2 {margin:0 0 20px}
label {display:block;margin:15px 0 7px;color:#bbb}
input,textarea,select {
  width:100%;padding:12px;background:#282a35;
  color:white;border:1px solid #444653;
  border-radius:8px;font:inherit;
}
textarea {min-height:100px;resize:vertical}
button {
  border:0;border-radius:7px;padding:11px 15px;
  background:#5865f2;color:white;cursor:pointer;
  font-weight:bold;margin:5px 4px 5px 0;
}
button:hover {filter:brightness(1.13)}
.green {background:#248046}
.red {background:#da373c}
.grey {background:#4e5058}
#buttonEditor {
  background:#252731;padding:15px;
  border-radius:10px;margin-top:12px;
}
.preview {
  background:#272932;border-radius:12px;
  padding:18px;margin-top:20px;
}
.embed {
  background:#202127;border-left:4px solid #5865f2;
  border-radius:5px;padding:17px;white-space:pre-wrap;
}
.embed h3 {margin:0 0 12px}
#previewButtons {margin-top:12px}
#status {color:#b7efc1;margin-top:12px}
@media(max-width:800px){
  main {grid-template-columns:1fr;padding:12px}
}
</style>
</head>
<body>
<header>🎫 Ticket Panel Builder</header>
<main>
<section class="panel">
<h2>Customise Panel</h2>
<label>Title</label>
<input id="title">
<label>Description</label>
<textarea id="description"></textarea>
<label>Embed Colour</label>
<input id="color" type="color">
<h3>Ticket Buttons</h3>
<div id="buttonList"></div>
<button onclick="addButton()">+ Add Button</button>
<div id="buttonEditor"></div>
</section>
<section class="panel">
<h2>Live Preview</h2>
<div class="preview">
<strong>🤖 Support Bot</strong>
<div class="embed" id="embed">
<h3 id="previewTitle"></h3>
<div id="previewDescription"></div>
</div>
<div id="previewButtons"></div>
</div>
<h2 style="margin-top:35px">Publish</h2>
<label>Yapper Channel ID</label>
<input id="channelId" placeholder="Paste destination channel ID">
<button class="green" onclick="publish()">🚀 Publish to Yapper</button>
<button onclick="save()">💾 Save Draft</button>
<p id="status"></p>
</section>
</main>
<script>
let config;
let selected = 0;

const $ = id => document.getElementById(id);
const styles = {
  primary:"#5865f2",
  secondary:"#4e5058",
  success:"#248046",
  danger:"#da373c"
};

async function load(){
  const response = await fetch("/config");
  config = await response.json();
  config.buttons ||= [];
  $("title").value = config.panel.title;
  $("description").value = config.panel.description;
  $("color").value = config.panel.color;
  render();
}

function sync(){
  config.panel.title = $("title").value;
  config.panel.description = $("description").value;
  config.panel.color = $("color").value;
  render();
}

["title","description","color"].forEach(id =>
  $(id).addEventListener("input", sync)
);

function addButton(){
  if(config.buttons.length >= 25) return alert("Maximum 25 buttons");
  const id = "button" + Date.now();

  config.buttons.push({
    id,label:"New Ticket",
    emoji:"🎫",style:"primary"
  });

  selected = config.buttons.length - 1;
  render();
}

function removeButton(){
  if(config.buttons.length <= 1){
    return alert("Keep at least one button");
  }
  config.buttons.splice(selected,1);
  selected = Math.max(0,selected - 1);
  render();
}

function updateButton(field,value){
  config.buttons[selected][field] = value;
  render();
}

function render(){
  $("previewTitle").textContent = config.panel.title;
  $("previewDescription").textContent = config.panel.description;
  $("embed").style.borderColor = config.panel.color;

  $("buttonList").replaceChildren();
  $("previewButtons").replaceChildren();

  config.buttons.forEach((b,i)=>{
    const editorBtn = document.createElement("button");
    editorBtn.textContent = (b.emoji||"") + " " + b.label;
    editorBtn.style.background = i === selected
      ? "#5865f2" : "#444653";
    editorBtn.onclick = () => {selected=i;render()};
    $("buttonList").append(editorBtn);

    const previewBtn = document.createElement("button");
    previewBtn.textContent = (b.emoji||"") + " " + b.label;
    previewBtn.style.background = styles[b.style] || styles.primary;
    $("previewButtons").append(previewBtn);
  });

  const box = $("buttonEditor");
  box.replaceChildren();

  const b = config.buttons[selected];
  if(!b) return;

  function field(label,key){
    const title = document.createElement("label");
    title.textContent = label;
    const input = document.createElement("input");
    input.value = b[key] || "";
    input.oninput = () => updateButton(key,input.value);
    box.append(title,input);
  }

  field("Button Label","label");
  field("Emoji","emoji");

  const label = document.createElement("label");
  label.textContent = "Button Colour";
  const select = document.createElement("select");

  Object.keys(styles).forEach(style=>{
    const option = document.createElement("option");
    option.value = style;
    option.textContent = style;
    option.selected = b.style === style;
    select.append(option);
  });

  select.onchange = () => updateButton("style",select.value);

  const remove = document.createElement("button");
  remove.className = "red";
  remove.textContent = "Remove Button";
  remove.onclick = removeButton;

  box.append(label,select,remove);
}

async function request(route,payload){
  const res = await fetch(route,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  });
  const result = await res.json();
  if(!res.ok) throw new Error(result.error || "Request failed");
  return result;
}

function validate(){
  if(!config.panel.title.trim()) throw Error("Enter a panel title");
  if(config.buttons.length < 1) throw Error("Add a button");
  for(const b of config.buttons){
    if(!b.label.trim()) throw Error("Every button needs a label");
  }
  if(new Set(config.buttons.map(b=>b.id)).size !== config.buttons.length){
    throw Error("Duplicate button IDs");
  }
}

async function save(){
  try{
    validate();
    await request("/save",{config});
    $("status").textContent = "✅ Draft saved!";
  }catch(e){
    $("status").textContent = "❌ " + e.message;
  }
}

async function publish(){
  try{
    validate();
    const channelId = $("channelId").value.trim();
    if(!channelId) throw Error("Enter a Yapper channel ID");

    $("status").textContent = "Publishing...";
    const result = await request("/publish",{config,channelId});
    $("status").textContent =
      "✅ Published! Message ID: " + result.messageId;
  }catch(e){
    $("status").textContent = "❌ " + e.message;
  }
}
load();
</script>
</body>
</html>`;

function respond(res, status, data) {
  res.writeHead(status, {"Content-Type":"application/json"});
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve,reject)=>{
    let raw = "";
    req.on("data",chunk=>{
      raw += chunk;
      if(raw.length > 100000) req.destroy();
    });
    req.on("end",()=>{
      try {resolve(JSON.parse(raw))}
      catch(e){reject(e)}
    });
    req.on("error",reject);
  });
}

function validate(config) {
  if(!config?.panel?.title || !Array.isArray(config.buttons))
    throw Error("Invalid panel");
  if(!config.buttons.length || config.buttons.length > 25)
    throw Error("Invalid number of buttons");
  if(config.buttons.some(b =>
    !/^[a-zA-Z0-9_-]{1,60}$/.test(b.id) ||
    !b.label || b.label.length > 80 ||
    !["primary","secondary","success","danger"].includes(b.style)
  )) throw Error("Invalid button configuration");
}

function rows(buttons) {
  const result = [];
  for(let i=0;i<buttons.length;i+=5){
    result.push({
      type:"row",
      components:buttons.slice(i,i+5).map(b=>({
        type:"button",
        label:b.label,
        ...(b.emoji ? {emoji:b.emoji}:{}),
        style:b.style,
        custom_id:"ticket:open:"+b.id
      }))
    });
  }
  return result;
}

const server = http.createServer(async(req,res)=>{
  // Local-only editor; do not expose it to the internet.
  const origin = req.headers.origin;
  if(origin && origin !== "http://127.0.0.1:"+PORT){
    return respond(res,403,{error:"Invalid origin"});
  }

  try {
    if(req.method==="GET" && req.url==="/"){
      res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
      return res.end(page);
    }

    if(req.method==="GET" && req.url==="/config"){
      const config = JSON.parse(fs.readFileSync(FILE,"utf8"));
      return respond(res,200,config);
    }

    if(req.method!=="POST")
      return respond(res,404,{error:"Not found"});

    const body = await readBody(req);
    const config = body.config;
    validate(config);

    if(req.url==="/save" || req.url==="/publish"){
      const old = JSON.parse(fs.readFileSync(FILE,"utf8"));
      const merged = {
        ...old,
        panel:config.panel,
        buttons:config.buttons
      };

      if(req.url==="/publish"){
        const id = String(body.channelId || "");
        if(!/^[0-9a-f-]{36}$/i.test(id))
          throw Error("Invalid Yapper channel ID");

        const response = await fetch(
          "https://www.yapper.website/api/bot/v1/channels/" +
          encodeURIComponent(id) + "/messages",
          {
            method:"POST",
            headers:{
              Authorization:"Bot " + TOKEN,
              "Content-Type":"application/json"
            },
            body:JSON.stringify({
              content:"",
              embeds:[{
                title:config.panel.title,
                description:config.panel.description,
                color:config.panel.color
              }],
              components:rows(config.buttons)
            })
          }
        );

        const result = await response.json();
        if(!response.ok){
          throw Error(result.error || "Yapper rejected the panel");
        }

        fs.writeFileSync(FILE,JSON.stringify(merged,null,2));
        return respond(res,200,{
          ok:true,
          messageId:result.id
        });
      }

      fs.writeFileSync(FILE,JSON.stringify(merged,null,2));
      return respond(res,200,{ok:true});
    }

    respond(res,404,{error:"Not found"});
  }catch(e){
    respond(res,400,{error:e.message});
  }
});

server.listen(PORT,"127.0.0.1",()=>{
  console.log("Open http://127.0.0.1:"+PORT);
});
