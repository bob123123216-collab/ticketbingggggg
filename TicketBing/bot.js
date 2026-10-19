const fs = require("node:fs");
const path = require("node:path");

// Node 22+; keep credentials in .env beside this file or the environment.
try { process.loadEnvFile(path.join(__dirname, ".env")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const TOKEN = process.env.YAPPER_TOKEN;
const BASE = "https://www.yapper.website/api/bot/v1";
const FILE = path.join(__dirname, "tickets.json");

if (!TOKEN) throw Error("Missing YAPPER_TOKEN in .env");

const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const defaults = () => ({
  next: 1,
  allowed: [],
  responderRole: null,
  botRole: null,
  editorChannel: null,
  editorMessage: null,
  panel: {
    title: "🎫 Support Center",
    description: "Click a button below to open a ticket.",
    color: "#5865F2",
    buttons: [
      { id: "general", label: "General", emoji: "", style: "primary" },
      { id: "purchase", label: "Purchase", emoji: "", style: "success" }
    ]
  }
});

const db = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, "utf8"))
  : {};

db.servers ??= {};
db.modmailTickets ??= {};
db.selections ??= {};
db.cursor ??= "0";
db.dmChannels ??= {};
db.dmReads ??= {};
// Start recovery now on upgrade; do not replay old private conversations.
db.dmRecoverySince ??= new Date().toISOString();
let botId = null;

function save() {
  const temp = FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(db, null, 2));
  fs.renameSync(temp, FILE);
}

function settings(sid) {
  db.servers[sid] ??= defaults();
  return db.servers[sid];
}

async function api(method, route, body) {
  const response = await fetch(BASE + route, {
    method,
    signal: AbortSignal.timeout(35000),
    headers: {
      Authorization: `Bot ${TOKEN}`,
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : {
      body: JSON.stringify(body)
    })
  });

  const raw = await response.text();
  let result;

  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = { error: raw };
  }

  if (!response.ok) {
    throw Error(
      `${response.status} ${method} ${route.replace(/(\/interactions\/)[^/]+\/[^/]+/, "$1[redacted]")}`
    );
  }

  return result;
}

function send(channel, content, extra = {}) {
  return api("POST", `/channels/${enc(channel)}/messages`, {
    content,
    ...extra
  });
}

async function dm(uid, content, extra = {}) {
  return send(await dmChannel(uid), content, extra);
}

async function dmChannel(uid) {
  if (db.dmChannels[uid]) return db.dmChannels[uid];
  const result = await api("POST", `/users/${enc(uid)}/dm`);
  if (typeof result.channel_id !== "string" || !result.channel_id) {
    throw Error("Cannot identify DM channel");
  }
  db.dmChannels[uid] = result.channel_id;
  save();
  return result.channel_id;
}

async function privateReply(m, text) {
  try {
    await dm(m.author_id, text);
  } catch (e) {
    console.error("Private reply error:", e.message);
  }
}

async function deleteCommand(m) {
  if (!m.server_id || !m.id) return;

  await api(
    "DELETE",
    `/channels/${enc(m.channel_id)}/messages/${enc(m.id)}`
  ).catch(() => {});
}

function embed(title, description, color = "#5865F2") {
  return { title, description, color };
}

function button(label, customId, style = "primary", emoji = "") {
  return {
    type: "button",
    custom_id: customId,
    label,
    style,
    ...(emoji ? { emoji } : {})
  };
}

function rows(buttons) {
  const output = [];

  for (let i = 0; i < buttons.length; i += 5) {
    output.push({
      type: "row",
      components: buttons.slice(i, i + 5)
    });
  }

  return output;
}

const styles = ["primary", "secondary", "success", "danger"];

// =========================================
// SERVER PERMISSIONS
// =========================================

function ownerIds(obj) {
  const values = [];
  const sources = [obj, obj?.server, obj?.data].filter(Boolean);

  for (const s of sources) {
    for (const key of [
      "owner_id", "ownerId",
      "owner_user_id", "ownerUserId"
    ]) {
      if (typeof s[key] === "string") {
        values.push(s[key]);
      }
    }

    if (typeof s.owner === "string") {
      values.push(s.owner);
    } else if (s.owner?.id) {
      values.push(s.owner.id);
    }
  }

  return values;
}

async function isOwner(sid, uid) {
  const server = await api("GET", `/servers/${enc(sid)}`);
  return ownerIds(server).includes(String(uid));
}

async function getRoles(sid) {
  const result = await api("GET", `/servers/${enc(sid)}/roles`);

  return Array.isArray(result)
    ? result
    : result.roles || result.data || [];
}

async function canManage(sid, uid) {
  if (await isOwner(sid, uid)) return true;

  const s = settings(sid);

  if (s.allowed.includes(uid)) return true;

  if (!s.responderRole) return false;

  const result = await api(
    "GET",
    `/servers/${enc(sid)}/members/${enc(uid)}`
  );

  const roles = result.roles || result.role_ids ||
    result.member?.roles || [];

  return roles.some(r =>
    (typeof r === "string" ? r : r.id) === s.responderRole
  );
}

// =========================================
// SMALL, COMPACT PANEL BUTTONS
// =========================================

// Removes display emojis and shortens the common labels.
// IDs are preserved, so each button still opens the
// correct ticket category.
function compactLabel(b) {
  const label = String(b.label || "Ticket");

  const map = {
    "General Support": "General",
    "Purchase Support": "Purchase",
    "Billing Support": "Billing",
    "Technical Support": "Technical",
    "Report User": "Report"
  };

  const clean = label.replace(
    /[\p{Extended_Pictographic}\uFE0F]/gu,
    ""
  ).trim();

  return (map[clean] || clean).slice(0, 18) || "Ticket";
}

function panelEmbed(sid) {
  const p = settings(sid).panel;
  return embed(p.title, p.description, p.color);
}

function panelButtons(sid) {
  const buttons = settings(sid).panel.buttons.map(b =>
    button(
      compactLabel(b),
      `tk:open:${sid}:${b.id}`,
      b.style,
      ""
    )
  );

  // Same normal action-row layout as colour buttons.
  return rows(buttons);
}

// =========================================
// PANEL EDITOR
// =========================================

function editorEmbed(sid) {
  const p = settings(sid).panel;

  const list = p.buttons.map((b, i) =>
    `${i + 1}. ${b.emoji || ""} ${b.label} (${b.style})`
  ).join("\n");

  return embed(
    "⚙️ Ticket Panel Builder",
    `**Title:** ${p.title}\n` +
    `**Description:** ${p.description}\n` +
    `**Colour:** ${p.color}\n\n` +
    `**Buttons:**\n${list}\n\n` +
    "**Commands:**\n" +
    "`!title TEXT`\n" +
    "`!description TEXT`\n" +
    "`!color #FF0000`\n" +
    "`!addbutton Label | Emoji | Style`\n" +
    "`!editbutton 1 | Label | Emoji | Style`\n" +
    "`!removebutton 1`\n\n" +
    "Preview or publish using the buttons below.",
    p.color
  );
}

function editorButtons() {
  return rows([
    button("Blue", "tk:color:5865F2", "primary"),
    button("Green", "tk:color:248046", "success"),
    button("Red", "tk:color:DA373C", "danger"),
    button("Pink", "tk:color:EB459E", "secondary"),
    button("Yellow", "tk:color:FEE75C", "secondary"),
    button("Preview", "tk:preview", "primary", "👁️"),
    button("Publish", "tk:publish", "success", "🚀")
  ]);
}

async function refreshEditor(sid) {
  const s = settings(sid);

  if (!s.editorChannel || !s.editorMessage) return;

  try {
    await api(
      "PATCH",
      `/channels/${enc(s.editorChannel)}/messages/${enc(s.editorMessage)}`,
      {
        embeds: [editorEmbed(sid)],
        components: editorButtons()
      }
    );
  } catch (e) {
    console.error("Editor error:", e.message);
    s.editorMessage = null;
    save();
  }
}

async function openEditor(m) {
  const s = settings(m.server_id);

  if (s.editorChannel === m.channel_id && s.editorMessage) {
    await refreshEditor(m.server_id);
    if (s.editorMessage) {
      return privateReply(m, "✅ Panel editor refreshed.");
    }
  }

  const msg = await send(m.channel_id, "", {
    embeds: [editorEmbed(m.server_id)],
    components: editorButtons()
  });

  s.editorChannel = m.channel_id;
  s.editorMessage = msg.id;
  save();

  return privateReply(m, "✅ Editor opened.");
}

async function publishPanel(sid, channel) {
  const s = settings(sid);

  if (!s.responderRole || !s.botRole) {
    throw Error("Configure !responderrole and !botrole first.");
  }

  if (!s.panel.buttons.length) {
    throw Error("The ticket panel needs at least one button.");
  }

  return send(channel, "", {
    embeds: [panelEmbed(sid)],
    components: panelButtons(sid)
  });
}

// =========================================
// TICKET DATA
// =========================================

function key(sid, number) {
  return `${sid}:${number}`;
}

function getTicket(sid, number) {
  return db.modmailTickets[key(sid, number)];
}

function ticketInChannel(channel) {
  return Object.values(db.modmailTickets).find(
    t => t.channelId === channel && t.status !== "deleted"
  );
}

function activeTickets(uid) {
  return Object.values(db.modmailTickets).filter(
    t => t.userId === uid && t.status === "open"
  );
}

function remember(t, author, message) {
  t.history ??= [];
  t.history.push({
    author,
    message,
    at: new Date().toISOString()
  });

  if (t.history.length > 2000) t.history.shift();
  save();
}

function ticketButtons(t) {
  const prefix = `tk:manage:${t.serverId}:${t.number}:`;

  return rows([
    button("Claim", prefix + "claim", "primary"),
    button("Close", prefix + "close", "danger"),
    button("Reopen", prefix + "reopen", "success"),
    button("Delete", prefix + "delete", "secondary")
  ]);
}

// =========================================
// CREATE PRIVATE STAFF TICKET
// =========================================

const opening = new Set();

async function createTicket(sid, uid, category) {
  const lock = `${sid}:${uid}`;

  if (opening.has(lock)) return;
  opening.add(lock);

  try {
    const s = settings(sid);

    if (!s.responderRole || !s.botRole) {
      throw Error("Responder role and bot role not configured.");
    }

    const existing = activeTickets(uid).find(
      t => t.serverId === sid
    );

    if (existing) {
      return dm(uid, `You already have ticket #${existing.number}.`);
    }

    // Make sure DMs work before opening a channel.
    await dm(uid, "🎫 Preparing your ticket...");

    const number = s.next;
    const name = `ticket-${String(number).padStart(4, "0")}`;


const created = await api(
  "POST",
  `/servers/${enc(sid)}/channels`,
  {
    name,
    kind: "text"
  }
);



const channelId =
  created.id ||
  created.channel_id ||
  created.channel?.id ||
  created.data?.id ||
  created.data?.channel?.id;

if (!channelId) {
  throw new Error(
    "Cannot identify created channel."
  );
}

const channel = { id: channelId };


    try {

const accessRoles = [
  ...new Set([s.responderRole, s.botRole].filter(Boolean))
];

if (accessRoles.length < 2) {
  throw new Error(
    "Configure separate responder and bot roles first."
  );
}

await api(
  "PATCH",
  `/channels/${enc(channel.id)}`,
  {
    private: true,
    role_ids: accessRoles
  }
);

// Verify that Yapper actually made the channel private.
const result = await api(
  "GET",
  `/servers/${enc(sid)}/channels`
);

const channels = Array.isArray(result)
  ? result
  : result.channels || [];

const verified = channels.find(c => c.id === channel.id);

if (!verified || verified.private !== true) {
  throw new Error(
    "Could not verify private channel settings. Ticket creation stopped."
  );
}

console.log("✅ Private ticket verified:", channel.id);

    } catch (error) {
      await api(
        "DELETE",
        `/channels/${enc(channel.id)}`
      ).catch(console.error);

      throw error;
    }

    const t = {
      number,
      serverId: sid,
      channelId: channel.id,
      userId: uid,
      category,
      status: "open",
      claimedBy: null,
      createdAt: new Date().toISOString(),
      history: []
    };

    db.modmailTickets[key(sid, number)] = t;
    db.selections[uid] = key(sid, number);
    s.next++;
    save();

    await send(channel.id, "", {
      embeds: [
        embed(
          `🎫 Ticket #${String(number).padStart(4, "0")}`,
          `**User:** <@${uid}>\n` +
          `**Category:** ${category}\n\n` +
          "Type here to send a DM to the opener.\n" +
          "Their DM replies will appear here.",
          s.panel.color
        )
      ],
      components: ticketButtons(t)
    });

    await dm(
      uid,
      `✅ Ticket #${number} opened!\n` +
      "Reply to this DM to contact support."
    );

    console.log("Ticket created:", name);
  } finally {
    opening.delete(lock);
  }
}

// =========================================
// MANAGE TICKETS
// =========================================

async function manageTicket(action, t, actor) {
  if (!t || t.status === "deleted") {
    return "Ticket not found.";
  }

  if (action === "claim") {
    if (t.status !== "open") return "Ticket is closed.";

    t.claimedBy = actor;
    save();

    return `✅ Claimed by <@${actor}>`;
  }

  if (action === "close") {
    if (t.status === "closed") return "Already closed.";

    t.status = "closed";
    save();

    await dm(
      t.userId,
      `🔒 Ticket #${t.number} has been closed.`
    ).catch(console.error);

    return "🔒 Ticket closed.";
  }

  if (action === "reopen") {
    if (t.status === "open") return "Already open.";

    t.status = "open";
    db.selections[t.userId] = key(t.serverId, t.number);
    save();

    await dm(
      t.userId,
      `🔓 Ticket #${t.number} reopened.`
    ).catch(console.error);

    return "🔓 Ticket reopened.";
  }

  if (action === "delete") {
    if (t.status !== "closed") {
      return "Close the ticket first.";
    }

    await api("DELETE", `/channels/${enc(t.channelId)}`);
    t.status = "deleted";
    save();

    return "✅ Ticket deleted.";
  }

  return "Unknown action.";
}

// =========================================
// MODMAIL: DM -> STAFF
// =========================================


async function relayDM(m) {
  const active = activeTickets(m.author_id);
  if (!active.length) return;

  let t = active.find(
    x => key(x.serverId, x.number) === db.selections[m.author_id]
  );

  if (!t && active.length === 1) {
    t = active[0];
    db.selections[m.author_id] = key(t.serverId, t.number);
    save();
  }

  if (!t) {
    return dm(
      m.author_id,
      "Choose a ticket:\n" +
      active.map(x =>
        `!selectticket ${x.serverId} ${x.number}`
      ).join("\n")
    );
  }

  const message = String(m.content || "") +
    (m.attachment
      ? "\nAttachment: " + JSON.stringify(m.attachment)
      : "");

  if (!message.trim()) return;

  const safe = message.slice(0, 1600);

  await send(
    t.channelId,
    `📩 **Ticket opener <@${m.author_id}>:**\n${safe}`
  );

  console.log("✅ DM forwarded to ticket:", t.number);

  remember(t, "opener", safe);
}

// =========================================
// MODMAIL: STAFF -> DM
// =========================================

async function relayStaff(m) {
  const t = ticketInChannel(m.channel_id);
  if (!t || t.status !== "open") return;

  if (!await canManage(t.serverId, m.author_id)) return;

  const message = String(m.content || "") +
    (m.attachment
      ? "\nAttachment: " + JSON.stringify(m.attachment)
      : "");

  if (!message.trim()) return;

  const safe = message.slice(0, 1600);

  await dm(
    t.userId,
    `📬 **Support — Ticket #${t.number}**\n${safe}`
  );

  remember(t, m.author_id, safe);
}

// =========================================
// ! COMMANDS
// =========================================

function parseCommand(content) {
  const match = String(content || "")
    .match(/^[!/]([a-z]+)(?:\s+([\s\S]*))?$/i);

  if (!match) return null;

  return {
    name: match[1].toLowerCase(),
    args: (match[2] || "").trim()
  };
}

const commands = new Set([
  "setup", "roles", "panel", "title", "description",
  "color", "addbutton", "editbutton",
  "removebutton", "preview", "publish",
  "allow", "deny", "responderrole",
  "botrole", "tickets", "ticketinfo",
  "claim", "close", "reopen", "delete",
  "selectticket", "helpdesk"
]);

async function handleCommand(m, cmd) {
  const { name, args } = cmd;

  if (!m.server_id) {
    if (name !== "selectticket") return;

    const [sid, number] = args.split(/\s+/);
    const t = getTicket(sid, number);

    if (!t || t.userId !== m.author_id || t.status !== "open") {
      return privateReply(m, "Ticket not found.");
    }

    db.selections[m.author_id] = key(sid, number);
    save();

    return privateReply(m, `✅ Selected ticket #${number}.`);
  }

  const sid = m.server_id;
  const s = settings(sid);

  if (name === "setup") {
    if (!await isOwner(sid, m.author_id)) {
      return privateReply(m, "⛔ Server owner only.");
    }

    return send(m.channel_id, "", {
      embeds: [{
        title: "⚙️ TicketBing Setup",
        description:
          "Click **Open Setup Guide** below to view your private setup instructions.",
        color: "#5865F2"
      }],
      components: rows([
        button(
          "Open Setup Guide",
          `tk:setup:${m.author_id}`,
          "primary",
          "⚙️"
        )
      ])
    });
  }


  const ownerOnly = [
    "roles", "allow", "deny", "responderrole", "botrole"
  ];

  if (ownerOnly.includes(name)) {
    if (!await isOwner(sid, m.author_id)) {
      return privateReply(m, "⛔ Server owner only.");
    }

    if (name === "roles") {
      const roles = await getRoles(sid);

      if (!roles.length) {
        return privateReply(m, "No roles found.");
      }

      let text = "🛡️ **Role IDs**\n";

      for (const r of roles) {
        const line = `${r.name}: \`${r.id}\`\n`;

        if (text.length + line.length > 1700) {
          await privateReply(m, text);
          text = "";
        }

        text += line;
      }

      return privateReply(m, text);
    }

    const value = args.replace(/^<@([^>]+)>$/, "$1");

    if (name === "allow") {
      if (!value) return privateReply(m, "Use !allow USER_ID");
      if (!s.allowed.includes(value)) s.allowed.push(value);
    }

    if (name === "deny") {
      s.allowed = s.allowed.filter(x => x !== value);
    }

    if (name === "responderrole") {
      s.responderRole = value || null;
    }

    if (name === "botrole") {
      s.botRole = value || null;
    }

    save();
    return privateReply(m, "✅ Settings updated.");
  }

  if (!await canManage(sid, m.author_id)) {
    return privateReply(m, "⛔ Not authorised.");
  }

  const p = s.panel;

  if (name === "panel") return openEditor(m);

  if (name === "helpdesk") {
    return privateReply(
      m,
      "**Ticket Commands**\n" +
      "!panel — Panel editor\n" +
      "!roles — Get role IDs\n" +
      "!responderrole ROLE_ID\n" +
      "!botrole ROLE_ID\n" +
      "!title TEXT\n" +
      "!description TEXT\n" +
      "!color #FF0000\n" +
      "!addbutton Label | Emoji | Style\n" +
      "!editbutton 1 | Label | Emoji | Style\n" +
      "!removebutton 1\n" +
      "!preview — Private preview\n" +
      "!publish — Publish here\n" +
      "!claim, !close, !reopen, !delete"
    );
  }

  if (name === "title") {
    if (!args || args.length > 256) throw Error("Invalid title.");
    p.title = args;
  }

  if (name === "description") {
    if (!args || args.length > 3000) {
      throw Error("Invalid description.");
    }

    p.description = args;
  }

  if (name === "color") {
    if (!/^#?[0-9a-f]{6}$/i.test(args)) {
      throw Error("Use !color #FF0000");
    }

    p.color = "#" + args.replace("#", "").toUpperCase();
  }

  if (name === "addbutton") {
    const [label, emoji = "", style = "primary"] =
      args.split("|").map(x => x.trim());

    if (!label || label.length > 80 ||
        !styles.includes(style)) {
      throw Error("Use !addbutton Support | 🎫 | primary");
    }

    if (p.buttons.length >= 25) throw Error("Maximum 25 buttons.");

    p.buttons.push({
      id: "b" + Date.now().toString(36),
      label,
      emoji,
      style
    });
  }

  if (name === "editbutton") {
    const [num, label, emoji = "", style = "primary"] =
      args.split("|").map(x => x.trim());

    const b = p.buttons[Number(num) - 1];

    if (!b || !label || label.length > 80 ||
        !styles.includes(style)) {
      throw Error("Use !editbutton 1 | Billing | 💰 | success");
    }

    Object.assign(b, { label, emoji, style });
  }

  if (name === "removebutton") {
    const index = Number(args) - 1;

    if (!p.buttons[index] || p.buttons.length === 1) {
      throw Error("Invalid button number.");
    }

    p.buttons.splice(index, 1);
  }

  if ([
    "title", "description", "color",
    "addbutton", "editbutton", "removebutton"
  ].includes(name)) {
    save();
    await refreshEditor(sid);
    return privateReply(m, "✅ Panel updated.");
  }

  if (name === "preview") {
    return dm(m.author_id, "👁️ Preview:", {
      embeds: [panelEmbed(sid)],
      components: panelButtons(sid)
    });
  }

  if (name === "publish") {
    await publishPanel(sid, m.channel_id);
    return privateReply(m, "✅ Panel published.");
  }

  if (name === "tickets") {
    const tickets = Object.values(db.modmailTickets)
      .filter(t => t.serverId === sid)
      .slice(-20);

    return privateReply(
      m,
      tickets.length
        ? tickets.map(t =>
            `#${t.number} — ${t.status}`
          ).join("\n")
        : "No tickets."
    );
  }

  const t = ticketInChannel(m.channel_id);

  if (!t) {
    return privateReply(m, "Use this inside a ticket channel.");
  }

  if (name === "ticketinfo") {
    return privateReply(
      m,
      `Ticket #${t.number}\n` +
      `Opener: ${t.userId}\n` +
      `Status: ${t.status}\n` +
      `Category: ${t.category}`
    );
  }

  if (["claim", "close", "reopen", "delete"].includes(name)) {
    const result = await manageTicket(name, t, m.author_id);
    return privateReply(m, result);
  }
}

// =========================================
// BUTTON INTERACTIONS
// =========================================

function acknowledge(i, content, extra = {}) {
  return api(
    "POST",
    `/interactions/${enc(i.id)}/${enc(i.token)}/callback`,
    { type: "ephemeral", content, ...extra }
  );
}

async function handleButton(i) {
  const parts = String(i.custom_id || "").split(":");

  if (parts[0] !== "tk") return;

  const action = parts[1];

  if (action === "setup") {
    const requestedBy = parts[2];

    if (!i.server_id ||
        requestedBy !== i.user_id ||
        !await isOwner(i.server_id, i.user_id)) {
      return acknowledge(i, "⛔ This setup guide is not for you.");
    }

    const description = [
      "**Welcome to TicketBing!**",
      "Follow these steps to get your ticket system running.",
      "",
      "**1. Configure your staff role**",
      "Use `!roles` to view role IDs.",
      "Use `!responderrole ROLE_ID` to set your staff role.",
      "",
      "**2. Configure the bot role**",
      "Use `!botrole ROLE_ID` to set the bot's role.",
      "Make sure the bot can manage channels and messages.",
      "",
      "**3. Create your ticket panel**",
      "Use `!panel` to open the panel builder.",
      "Change the title, description, colours and buttons.",
      "Use the Preview button to check your panel.",
      "",
      "**4. Publish your ticket panel**",
      "Use `!publish` in your preferred channel.",
      "Members can then click a button to open a ticket.",
      "",
      "**5. How tickets work**",
      "TicketBing creates ticket-0001, ticket-0002, etc.",
      "Staff can see the private ticket channels.",
      "Staff messages are sent to the customer's DMs.",
      "Customer DM replies appear in the ticket channel.",
      "",
      "**6. Manage tickets**",
      "`!claim` - Claim a ticket",
      "`!close` - Close a ticket",
      "`!reopen` - Reopen a ticket",
      "`!delete` - Delete a closed ticket",
      "",
      "**7. Staff permissions**",
      "`!allow USER_ID` - Authorise a user",
      "`!deny USER_ID` - Remove authorisation",
      "",
      "**Need help?** Use `!helpdesk`."
    ].join("\n");

    return acknowledge(i, "", {
      embeds: [{
        title: "⚙️ TicketBing — Setup Guide",
        description,
        color: "#5865F2"
      }]
    });
  }


  if (action === "open") {
    const sid = parts[2];
    const buttonId = parts[3];

    if (sid !== i.server_id) {
      return acknowledge(i, "Wrong server.");
    }

    const b = settings(sid).panel.buttons.find(
      x => x.id === buttonId
    );

    if (!b) {
      return acknowledge(i, "Button no longer configured.");
    }

    await acknowledge(i, "🎫 Creating ticket...");
    return createTicket(sid, i.user_id, b.label);
  }

  if (["color", "preview", "publish"].includes(action)) {
    if (!i.server_id ||
        !await canManage(i.server_id, i.user_id)) {
      return acknowledge(i, "⛔ Not authorised.");
    }

    const s = settings(i.server_id);

    // No strict message ID check.
    if (i.channel_id !== s.editorChannel) {
      return acknowledge(i, "Use the original editor channel.");
    }

    if (action === "color") {
      s.panel.color = "#" + parts[2];
      save();

      await acknowledge(i, "✅ Colour updated.");
      return refreshEditor(i.server_id);
    }

    if (action === "preview") {
      return acknowledge(i, "👁️ Your compact ticket panel:", {
        embeds: [panelEmbed(i.server_id)]
      });
    }

    if (action === "publish") {
      if (!s.responderRole || !s.botRole) {
        return acknowledge(
          i,
          "⚠️ Configure !responderrole and !botrole first."
        );
      }

      await acknowledge(i, "🚀 Publishing...");
      return publishPanel(i.server_id, i.channel_id);
    }
  }

  if (action === "manage") {
    const sid = parts[2];
    const number = parts[3];
    const operation = parts[4];

    const t = getTicket(sid, number);

    if (!t || t.channelId !== i.channel_id) {
      return acknowledge(i, "Ticket not found.");
    }

    if (!await canManage(sid, i.user_id)) {
      return acknowledge(i, "⛔ Staff only.");
    }

    await acknowledge(i, "Processing...");

    const result = await manageTicket(operation, t, i.user_id);

    if (t.status !== "deleted") {
      await send(i.channel_id, result);
    }
  }
}

// =========================================
// MESSAGE HANDLER
// =========================================


// Event data uses author_id/channel_id/server_id, not Discord message objects.
// Sources: https://www.yapper.website/developers and /openapi.json
async function handleMessage(m) {
  if (!m || typeof m.author_id !== "string" ||
      typeof m.channel_id !== "string" || typeof m.id !== "string") {
    console.warn("Ignored message with missing documented identity fields");
    return;
  }
  if (m.author_id === botId || m.author_bot === true || m.author?.bot === true) return;

  // A stored staff channel always takes precedence; never treat it as a DM.
  const staffTicket = ticketInChannel(m.channel_id);
  const cmd = parseCommand(m.content);
  if (staffTicket) {
    if (m.server_id !== staffTicket.serverId) return;
    if (cmd && commands.has(cmd.name)) {
      await deleteCommand(m);
      return handleCommand(m, cmd);
    }
    if (!cmd) return relayStaff(m);
    return;
  }

  // Confirm the sender's actual DM channel through the documented endpoint.
  // No inference based only on the sender having an open ticket.
  const knownDM = db.dmChannels[m.author_id];
  if (m.server_id === null || knownDM === m.channel_id) {
    if (await dmChannel(m.author_id) !== m.channel_id) return;
    const state = db.dmReads[m.author_id] ??= {
      after: db.dmRecoverySince, seen: []
    };
    if (state.seen.includes(m.id)) return;
    const dmMessage = { ...m, server_id: null };
    if (cmd?.name === "selectticket") {
      await handleCommand(dmMessage, cmd);
    } else {
      // Support text such as "!help" must not be swallowed as a staff command.
      await relayDM(dmMessage);
    }
    state.seen.push(m.id);
    if (state.seen.length > 2000) state.seen.splice(0, state.seen.length - 2000);
    save();
    return;
  }

  if (typeof m.server_id === "string" && m.server_id &&
      cmd && commands.has(cmd.name)) {
    await deleteCommand(m);
    return handleCommand(m, cmd);
  }
}

// If a DM is missing from /events, read the verified DM
// channel as a fallback. Only open-ticket users are polled; bot replies and
// already processed message IDs are ignored. Failures leave the watermark
// unchanged so the next pass retries. This runs serially with event handling.
let lastDMScan = 0;
async function recoverDMs() {
  if (Date.now() - lastDMScan < 10000) return;
  lastDMScan = Date.now();
  const users = [...new Set(Object.values(db.modmailTickets)
    .filter(t => t.status === "open").map(t => t.userId))];
  for (const uid of users) {
    try {
      const channel = await dmChannel(uid);
      const state = db.dmReads[uid] ??= { after: db.dmRecoverySince, seen: [] };
      for (let page = 0; page < 5; page++) {
        // Overlap the boundary to retain distinct messages with the same time.
        const after = new Date(Date.parse(state.after) - 1).toISOString();
        const result = await api("GET",
          `/channels/${enc(channel)}/messages?limit=100&after=${enc(after)}`);
        if (!Array.isArray(result.messages)) throw Error("Unexpected DM history schema");
        const messages = result.messages;
        let latest = state.after;
        for (const m of messages) {
          if (!m.id || !Number.isFinite(Date.parse(m.created_at))) {
            throw Error("DM history missing id or created_at");
          }
          if (m.channel_id && m.channel_id !== channel) {
            throw Error("DM history channel mismatch");
          }
          if (m.author_id === uid && Date.parse(m.created_at) >= Date.parse(db.dmRecoverySince)) {
            await handleMessage({ ...m, channel_id: channel, server_id: null });
          }
          if (Date.parse(m.created_at) > Date.parse(latest)) latest = m.created_at;
        }
        const advanced = Date.parse(latest) > Date.parse(state.after);
        state.after = latest;
        save();
        if (messages.length < 100) break;
        if (!advanced) {
          console.warn("DM recovery page cannot advance; history timestamp boundary is full");
          break;
        }
      }
    } catch (error) {
      console.error("DM recovery failed; will retry:", error.message);
    }
  }
}


// =========================================
// STARTUP
// =========================================

async function start() {
  const me = await api("GET", "/me");

  botId = me.id;
  if (!botId) throw Error("Missing bot identity from /me");
  save();
  console.log("✅ TicketBing online:", me.username);
  console.log("✅ Compact panel mode enabled");

  await api("PUT", "/commands", {
    commands: [...commands]
      .filter(name => name !== "selectticket")
      .map(name => ({
        name,
        description: `TicketBing ${name}`
      }))
  });

  if (db.cursor === "0") {
    const initial = await api("GET", "/events?after=0&wait=0");
    db.cursor = String(initial.last ?? "0");
    save();
  }

  console.log("✅ Waiting for Yapper events...");

  while (true) {
    await recoverDMs();
    try {
      const result = await api(
        "GET",
        `/events?after=${enc(db.cursor)}&wait=5`
      );

      for (const event of result.events || []) {
        try {
          if (event.type === "message") {
            await handleMessage(event.data);
          }

          if (event.type === "interaction") {
            await handleButton(event.data);
          }
        } catch (error) {
          console.error("EVENT ERROR:", error.message);
        }

        db.cursor = String(event.id);
        save();
      }

      if (result.last != null) {
        db.cursor = String(result.last);
        save();
      }
    } catch (error) {
      console.error("POLL ERROR:", error.message);
      await sleep(3000);
    }
  }
}

if (require.main === module) {
  start().catch(error => { console.error("Startup failed:", error.message); process.exitCode = 1; });
}
