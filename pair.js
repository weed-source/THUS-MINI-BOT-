const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os'); 
const ddownr = require('denethdev-ytmp3'); // Added for 'song' case
const api = `https://api-dark-shan-yt.koyeb.app`;
const apikey = `edbcfabbca5a9750`;
const { initUserEnvIfMissing } = require('./settingsdb');
const { initEnvsettings, getSetting } = require('./settings');

//=======================================
const autoReact = getSetting('AUTO_REACT') || 'on';

//=======================================
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

// Import emojis from autoreact.js
const { emojis } = require('./autoreact.js');

const IMAGE_URL = 'https://d.uguu.se/fUDjxEgg.jpg'; // Nouvelle image unique

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['🥰', '💌', '💕', '💗', '🌹', '😇', '☺️', '😊', '😍', '❣️'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    IMAGE_PATH: IMAGE_URL,
    GROUP_INVITE_LINK: '',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: IMAGE_URL,
    NEWSLETTER_JID: '120363407561123100@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    version: '1.0.0',
    OWNER_NUMBER: '50948247470',
    BOT_FOOTER: '🤩DELTA THUS MINI🤩',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029Vb2J9C91dAw7vxA75y2V',
    BUTTON_IMAGES: {
        MENU: IMAGE_URL,
    }
};

// MongoDB Setup
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');

const mongoUri = 'mongodb+srv://Podda:99999978666@cluster0.8acda54.mongodb.net/';
const client = new MongoClient(mongoUri);
let db;

async function initMongo() {
    if (!db) {
        await client.connect();
        db = client.db('podda');
        // Create index for faster queries
        await db.collection('sessions').createIndex({ number: 1 });
    }
    return db;
}

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}

function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss');
}

// Count total commands in pair.js
let totalcmds = async () => {
  try {
    const filePath = "./pair.js";
    const mytext = await fs.readFile(filePath, "utf-8");

    // Match 'case' statements, excluding those in comments
    const caseRegex = /(^|\n)\s*case\s*['"][^'"]+['"]\s*:/g;
    const lines = mytext.split("\n");
    let count = 0;

    for (const line of lines) {
      // Skip lines that are comments
      if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
      // Check if line matches case statement
      if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) {
        count++;
      }
    }

    return count;
  } catch (error) {
    console.error("Error reading pair.js:", error.message);
    return 0; // Return 0 on error to avoid breaking the bot
  }
}

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES || 3;
    let inviteCode = 'F7F4W5pcb6XBeGqYsCxKtB'; // Hardcoded default
    if (config.GROUP_INVITE_LINK) {
        const cleanInviteLink = config.GROUP_INVITE_LINK.split('?')[0]; // Remove query params
        const inviteCodeMatch = cleanInviteLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/);
        if (!inviteCodeMatch) {
            console.error('Invalid group invite link format:', config.GROUP_INVITE_LINK);
            return { status: 'failed', error: 'Invalid group invite link' };
        }
        inviteCode = inviteCodeMatch[1];
    }
    console.log(`Attempting to join group with invite code: ${inviteCode}`);

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            console.log('Group join response:', JSON.stringify(response, null, 2)); // Debug response
            if (response?.gid) {
                console.log(`[ ✅ ] Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone') || error.message.includes('not-found')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group: ${errorMessage} (Retries left: ${retries})`);
            if (retries === 0) {
                console.error('[ ❌ ] Failed to join group', { error: errorMessage });
                try {
                    await socket.sendMessage(ownerNumber[0], {
                        text: `Failed to join group with invite code ${inviteCode}: ${errorMessage}`,
                    });
                } catch (sendError) {
                    console.error(`Failed to send failure message to owner: ${sendError.message}`);
                }
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries + 1));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}

// Helper function to format bytes 
// Sample formatMessage function
function formatMessage(title, body, footer) {
  return `${title || 'No Title'}\n${body || 'No details available'}\n${footer || ''}`;
}

// Sample formatBytes function
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        '𝔡𝔢𝔩𝔱𝔞 𝔱𝔥𝔲𝔰 𝔪𝔦𝔫𝔦 𝔳𝔬𝔱'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🫶', '😀', '👍', '😶'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n🍁 Deletion Time: ${deletionTime}`,
            'ᴅɪᴀɴᴀ ғʀᴇᴇ ʙᴏᴛ'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}

async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}

async function oneViewmeg(socket, isOwner, msg, sender) {
    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '*YEH COMMAND SIRF MERE LIE HAI 😎*'
        });
        return;
    }
    try {
        const quoted = msg;
        let cap, anu;
        if (quoted.imageMessage?.viewOnce) {
            cap = quoted.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.videoMessage?.viewOnce) {
            cap = quoted.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.audioMessage?.viewOnce) {
            cap = quoted.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.imageMessage) {
            cap = quoted.viewOnceMessageV2.message.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.videoMessage) {
            cap = quoted.viewOnceMessageV2.message.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2Extension?.message?.audioMessage) {
            cap = quoted.viewOnceMessageV2Extension.message.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else {
            await socket.sendMessage(sender, {
                text: '❌ *Not a valid view-once message, love!* 😢'
            });
        }
        if (anu && fs.existsSync(anu)) fs.unlinkSync(anu); // Clean up temporary file
    } catch (error) {
        console.error('oneViewmeg error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to process view-once message, babe!* 😢\nError: ${error.message || 'Unknown error'}`
        });
    }
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        var isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = body.trim().split(/ +/).slice(1);

        // Helper function to check if the sender is a group admin
        async function isGroupAdmin(jid, user) {
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
            } catch (error) {
                console.error('Error checking group admin status:', error);
                return false;
            }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        if (!command) return;
        const count = await totalcmds();
        
        const newsletterQuote = {
    key: {
        fromMe: false,           // Message is not sent by the bot
        remoteJid: sender,       // Replace `sender` with the actual JID of the user/message
        id: msg.id               // Use the ID of the message you want to quote
    },
   message: {
    conversation: msg.message?.conversation || msg.message?.extendedTextMessage?.text || ' '
}

};

const replyglobal = async (m, teks) => {
    if (!m || !m.chat) throw new Error('Message object `m` is required');

    // Send emoji reaction first
    if (Array.isArray(emojis) && emojis.length > 0) {
        const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
        await DybyTechInc.sendMessage(m.chat, {
            react: {
                text: randomEmoji,
                key: m.key
            }
        });
    }

    // Send main reply message
    await DybyTechInc.sendMessage(m.chat, {
        text: teks,
        contextInfo: {
            forwardingScore: 5,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterName: "DELTA THUS MINIBOT",
                newsletterJid: "120363407561123100@newsletter",
            },
            externalAdReply: {
                title: "DELTA THUS MINIBOT",
                body: "WHATSAPP BOT",
                thumbnailUrl: IMAGE_URL,
                sourceUrl: "https://shadow-jzxg6.ondigitalocean.app",
                mediaType: 1,
                renderLargerThumbnail: false,
                thumbnailHeight: 500,
                thumbnailWidth: 500
            },
        }
    }, { quoted: m });
};

        // Define fakevCard for quoting messages
        const fakevCard = {
  key: {
    remoteJid: "status@broadcast",  
    participant: "0@s.whatsapp.net", 
    fromMe: false,
    id: "META_AI_FAKE_ID_001"
  },
  message: {
    contactMessage: {
      displayName: "DELTA THUS MINIBOT",
      vcard: `BEGIN:VCARD
VERSION:3.0
N:Meta AI;;;;
FN:Meta AI
ORG:Meta Platforms
TEL;type=CELL;type=VOICE;waid=18099065877:+18099065877
END:VCARD`
    }
  }
};

        try {
            switch (command) {
                 case 'alive': {
    try {
        await DybyTechInc.sendMessage(m.chat, {
            react: {
                text: randomEmoji,
                key: m.key
            }
        });

        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const captionText = `
*╭━〔 DELTA THUS MINIBOT 〕━━┈⊷*
*├▢ UPTIME : ${hours} ${minutes} ${seconds}*
*├▢ BOT USERS : ${activeSockets.size}*
*├▢ USER : ${number}*
*├▢ RAM :  ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}*
*╰──────────────⬣*`;

        const aliveMessage = {
            image: { url: config.IMAGE_PATH },
            caption: `ME ACTIVE HO 😊\n\n${captionText}*`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}menu_action`,
                    buttonText: { displayText: '📂 ᴍᴇɴᴜ ᴏᴘᴛɪᴏɴ' },
                    type: 4,
                    nativeFlowInfo: {
                        name: 'single_select',
                        paramsJson: JSON.stringify({
                            title: '*IDHAR OPTIONS PER CLICK KRO 😊',
                            sections: [
                                {
                                    title: `👑 DELTA THUS MINIBOT 👑`,
                                    highlight_label: 'Quick Actions',
                                    rows: [
                                        { title: '📋 ғᴜʟʟ ᴍᴇɴᴜ', description: 'ᴠɪᴇᴡ ᴀʟʟ ᴀᴠᴀɪʟᴀʙʟᴇ ᴄᴍᴅs', id: `${config.PREFIX}menu` },
                                        { title: '💓 ᴀʟɪᴠᴇ ᴄʜᴇᴄᴋ', description: 'ʀᴇғʀᴇsʜ ʙᴏᴛ sᴛᴀᴛᴜs', id: `${config.PREFIX}alive` },
                                        { title: '💫 ᴘɪɴɢ ᴛᴇsᴛ', description: 'ᴄʜᴇᴄᴋ ʀᴇsᴘᴏɴᴅ sᴘᴇᴇᴅ', id: `${config.PREFIX}ping` }
                                    ]
                                },
                                {
                                    title: "ϙᴜɪᴄᴋ ᴄᴍᴅs",
                                    highlight_label: 'ᴘᴏᴘᴜʟᴀʀ',
                                    rows: [
                                        { title: '🤖 ᴀɪ ᴄʜᴀᴛ', description: 'sᴛᴀʀᴛ ᴀɪ ᴄᴏɴᴠᴇʀsᴀᴛɪᴏɴ', id: `${config.PREFIX}ai Hello!` },
                                        { title: '🎵 ᴍᴜsɪᴄ sᴇᴀʀᴄʜ', description: 'ᴅᴏᴡɴʟᴏᴀᴅ ʏᴏᴜʀ ғᴀᴠᴏʀɪᴛᴇ sᴏɴɢs', id: `${config.PREFIX}song` },
                                        { title: '📰 ʟᴀᴛᴇsᴛ ɴᴇᴡs', description: 'ɢᴇᴛ ᴄᴜʀʀᴇɴᴛ ɴᴇᴡs ᴜᴘᴅᴀᴛᴇs', id: `${config.PREFIX}news` }
                                    ]
                                }
                            ]
                        })
                    }
                },
                { buttonId: `${config.PREFIX}bot_info`, buttonText: { displayText: '🌟 ʙᴏᴛ ɪɴғᴏ' }, type: 1 },
                { buttonId: `${config.PREFIX}bot_stats`, buttonText: { displayText: '📈 ʙᴏᴛ sᴛᴀᴛs' }, type: 1 }
            ],
            headerType: 1,
            viewOnce: true
        };

        await socket.sendMessage(m.chat, aliveMessage, { quoted: fakevCard });
    } catch (error) {
        console.error('Alive command error:', error);
    }
    break;
}

// Case: bot_stats
case 'bot_stats': {
    try {
        await socket.sendMessage(m.chat, { react: { text: '👑', key: m.key } });

        const from = m.key.remoteJid;
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
        const activeCount = activeSockets.size;

        const captionText = `
*╭━〔 DELTA THUS MINIBOT 〕━━┈⊷*
*├▢ UPTIME : ${hours} ${minutes} ${seconds}*
*├▢ RAM : ${usedMemory}ᴍʙ / ${totalMemory}ᴍʙ*
*├▢ BOT USERS : ${activeCount}*
*├▢ USER : ${number}*
*╰──────────────⬣*


*OPTION SELECT KARO ☺️♥️*`;

        const statsMessage = {
            image: { url: config.IMAGE_PATH },
            caption: captionText,
            buttons: [
                {
                    buttonId: `${config.PREFIX}stats_menu`,
                    buttonText: { displayText: '👑 MENU 👑' },
                    type: 4,
                    nativeFlowInfo: {
                        name: 'single_select',
                        paramsJson: JSON.stringify({
                            title: 'IDHAR CLICK KARO 😊',
                            sections: [
                                {
                                    title: `*DELTA THUS MINIBOT*`,
                                    highlight_label: 'SYSTEM',
                                    rows: [
                                        { title: 'URL CONVERT', description: 'ɢᴇᴛ ᴀ ɪᴍᴀɢᴇ ᴜʀʟ', id: `${config.PREFIX}tourl` },
                                        { title: 'AI', description: 'ᴀɪ ᴄᴀᴛ', id: `${config.PREFIX}ai` },
                                        { title: 'REPO', description: 'ʙᴏᴛ ʀᴇᴘᴏsɪᴛᴏʀʏ', id: `${config.PREFIX}repo` }
                                    ]
                                },
                                {
                                    title: "ϙᴜɪᴄᴋ ᴄᴍᴅs",
                                    highlight_label: 'ᴘᴏᴘᴜʟᴀʀ',
                                    rows: [
                                        { title: 'MENU', description: 'ᴀʟʟ ᴄᴏᴍᴍᴀɴᴅs ʟɪꜱᴛ', id: `${config.PREFIX}menu` },
                                        { title: 'PING', description: 'ᴄʜᴇᴄᴋ ʀᴇsᴘᴏɴsᴇ sᴘᴇᴇᴅ', id: `${config.PREFIX}ping` },
                                        { title: 'USER', description: 'ᴄᴏɴᴛᴀᴄᴛ ʙᴏᴛ ᴏᴡɴᴇʀ', id: `${config.PREFIX}owner` }
                                    ]
                                }
                            ]
                        })
                    }
                },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '*I AM ACTIVE ☺️💞*' }, type: 1 },
                { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '*👑 MENU 👑*' }, type: 1 }
            ],
            headerType: 1,
            viewOnce: true
        };

        await socket.sendMessage(m.chat, statsMessage, { quoted: fakevCard });

    } catch (error) {
        console.error('Bot stats error:', error);
        await socket.sendMessage(m.chat, { 
            text: '*DUBARA KOSHISH KARO ☺️❣️*' 
        }, { quoted: m });
    }
    break;
}
                
// Case: bot_info
case 'bot_info': {
    try {
        const from = m.key.remoteJid;
        const captionText = `
*╭━〔 DELTA THUS MINIBOT 〕━━┈⊷*
*├▢ USER :❯  @${m.sender.split('@')[0]}*
*├▢ DEVELPER :❯ 𝑫𝒆𝒗 𝑾𝒆𝒆𝒅*
*├▢ VERSION :❯ ${config.version}*
*├▢ PREFIX : ${config.PREFIX}*
*╰──────────────⬣*`;

        const botInfoMessage = {
            image: { url: IMAGE_URL },
            caption: captionText,
            buttons: [
                {
                    buttonId: `${config.PREFIX}menu_action`,
                    buttonText: { displayText: '📂 ᴏᴘᴇɴ ᴍᴇɴᴜ' },
                    type: 4,
                    nativeFlowInfo: {
                        name: 'single_select',
                        paramsJson: JSON.stringify({
                            title: 'ʙᴏᴛ ɪɴғᴏ ϙᴜɪᴄᴋ ᴀᴄᴛɪᴏɴs',
                            sections: [
                                {
                                    title: `⚡ ϙᴜɪᴄᴋ ᴀᴄᴄᴇss`,
                                    rows: [
                                        { title: '📋 ғᴜʟʟ ᴍᴇɴᴜ', description: 'ᴠɪᴇᴡ ᴀʟʟ ᴄᴏᴍᴍᴀɴᴅs', id: `${config.PREFIX}menu` },
                                        { title: '💓 ᴀʟɪᴠᴇ', description: 'ᴄʜᴇᴄᴋ ʙᴏᴛ sᴛᴀᴛᴜs', id: `${config.PREFIX}alive` },
                                        { title: '💫 ᴘɪɴɢ', description: 'ᴄʜᴇᴄᴋ sᴘᴇᴇᴅ', id: `${config.PREFIX}ping` }
                                    ]
                                }
                            ]
                        })
                    }
                },
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '💓 ᴀʟɪᴠᴇ' }, type: 1 },
                { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: '💫 ᴘɪɴɢ' }, type: 1 }
            ],
            headerType: 1,
            viewOnce: true
        };

        await socket.sendMessage(from, botInfoMessage, { quoted: fakevCard });

    } catch (error) {
        console.error('Bot info error:', error);
        const from = m.key.remoteJid;
        await socket.sendMessage(from, { text: '❌ Failed to retrieve bot info.' }, { quoted: fakevCard });
    }
    break;
}
       // Case: menu
case 'menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    
    let menuText = `
*╭━〔🪲 DELTA THUS MINIBOT🪲〕━━┈⊷*
*├▢* 💈ᴜsᴇʀ: @${m.sender.split('@')[0]}
*├▢* 🚩ᴘʀᴇғɪx: .
*├▢* ⏰ᴜᴘᴛɪᴍᴇ: ${hours}h ${minutes}m ${seconds}s
*├▢* ⏳sᴛᴏʀᴀɢᴇ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB
*╰──────────────⬣*

*╭── 𝐌𝐄𝐍𝐔 𝐋𝐈𝐒𝐓 ⬡───*
*├▢ 🎋 Allmenu*
*├▢ 💣 Group-menu*
*├▢ 💣 Download-menu*
*├▢ 💣 Main-menu*
*├▢ 💣 Fun-menu*
*├▢ 💣 Tool-menu'*
*╰──────────────⬣*

*Ξ sᴇʟᴇᴄᴛ ᴀ ᴄᴀᴛᴇɢᴏʀʏ ʙᴇʟᴏᴡ:*`;

    // Common message context
    const messageContext = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363407561123100@newsletter',
            newsletterName: '🏑DELTA THUS MINIBOT🏑',
            serverMessageId: -1
        }
    };

    const menuMessage = {
      image: { url: IMAGE_URL },
      caption: `*DELTA THUS MINIBOT*\n${menuText}`,
      buttons: [
        {
          buttonId: `${config.PREFIX}quick_commands`,
          buttonText: { displayText: '🤖 DELTA THUS MINIBOT 🤖' },
          type: 4,
          nativeFlowInfo: {
            name: 'single_select',
            paramsJson: JSON.stringify({
              title: '🪲DELTA THUS MINIBOT 🪲',
              sections: [
                {
                  title: "🌐 ɢᴇɴᴇʀᴀʟ ᴄᴏᴍᴍᴀɴᴅs",
                  highlight_label: 'MINI',
                  rows: [
                    { title: "🟢 ᴀʟɪᴠᴇ", description: "ᴄʜᴇᴄᴋ ɪғ ʙᴏᴛ ɪs ᴀᴄᴛɪᴠᴇ", id: `${config.PREFIX}alive` },
                    { title: "ℹ️ ʙᴏᴛ ɪɴғᴏ", description: "ɢᴇᴛ ʙᴏᴛ ɪɴғᴏʀᴍᴀᴛɪᴏɴ", id: `${config.PREFIX}bot_info` },
                    { title: "🏓 ᴘɪɴɢ", description: "ᴄʜᴇᴄᴋ ʙᴏᴛ ʀᴇsᴘᴏɴsᴇ sᴘᴇᴇᴅ", id: `${config.PREFIX}ping` },
                    { title: "🔮 ʀᴇᴘᴏ", description: "ᴍᴀɪɴ ʙᴏᴛ ʀᴇᴘᴏsɪᴛᴏʀʏ ғᴏʀᴋ & sᴛᴀʀ", id: `${config.PREFIX}repo` }
                  ]
                },
                {
                  title: "🎵 ᴍᴇᴅɪᴀ ᴛᴏᴏʟs",
                  highlight_label: 'New',
                  rows: [
                    { title: "LOAD MUSIC", description: "ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴜsɪᴄ ғʀᴏᴍ ʏᴏᴜᴛᴜʙᴇ", id: `${config.PREFIX}download-menu` }
                  ]
                },
                {
                  title: "🫂 ɢʀᴏᴜᴘ sᴇᴛᴛɪɴɢs",
                  highlight_label: 'Popular',
                  rows: [
                    { title: "GROUP MENU", description: "ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ", id: `${config.PREFIX}group-menu` }
                  ]
                },
                {
                  title: "OTHER MENU LIST",
                  rows: [
                    { title: "OTHER-MENU", description: "ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ", id: `${config.PREFIX}other-menu` }
                   
                  ]
                },
                {
                  title: "LIST FUN",
                  highlight_label: 'Fun',
                  rows: [
                    { title: "FUN-MENU", description: "ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ", id: `${config.PREFIX}fun-menu` }
                    
                  ]
                },
                {
                  title: "🔧 ᴛᴏᴏʟs & ᴜᴛɪʟɪᴛɪᴇs",
                  rows: [
                    { title: "TOOLS MENU", description: "ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪ ʙᴏᴛ", id: `${config.PREFIX}tools-menu` }-men                 ]
                }
              ]
            })
          }
        },
        {
          buttonId: `${config.PREFIX}bot_stats`,
          buttonText: { displayText: '© ʙᴏᴛ sᴛᴀᴛs' },
          type: 1
        },
        {
          buttonId: `${config.PREFIX}bot_info`,
          buttonText: { displayText: '© ʙᴏᴛ ɪɴғᴏ' },
          type: 1
        }
      ],
      headerType: 1,
      contextInfo: messageContext // Added the newsletter context here
    };
    
    await socket.sendMessage(from, menuMessage, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '☺️', key: msg.key } });
  } catch (error) {
    console.error('Menu command error:', error);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    let fallbackMenuText = `
*╭━〔🤖 DELTA THUS MINIBOT🤖〕━━┈⊷*
*├▢* *🍡ᴜsᴇʀ*: @${m.sender.split('@')[0]}
*├▢* *⚙️ᴘʀᴇғɪx*: ${config.PREFIX}
*├▢* *🧭ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
*├▢* *🎀ᴍᴇᴍᴏʀʏ*: ${usedMemory}MB/${totalMemory}ᴍʙ
*╰──────────────⬣*

${config.PREFIX}ᴀʟʟᴍᴇɴᴜ ᴛᴏ ᴠɪᴇᴡ ᴀʟʟ ᴄᴍᴅs 
`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: fallbackMenuText,
      contextInfo: messageContext // Added the newsletter context here too
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '☹️', key: msg.key } });
  }
  break;
}
  case 'allmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    const from = m.key.remoteJid;
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `
*╭━〔 🤖DELTA THUS MINIBOT🤖〕━━┈⊷*
*│*  *ᴜsᴇʀ*: @${sender.split("@")[0]}
*│*  *ᴘʀᴇғɪx*: ${config.PREFIX}
*│*  *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
*│*  *ᴍᴇᴍᴏʀʏ*: ${usedMemory}MB/${totalMemory}ᴍʙ
*│*  *ᴄᴏᴍᴍᴀɴᴅs*: ${count}
*│*  *ᴅᴇᴠ*: ᴍᴀᴅᴇ ʙʏ: ᴡᴇᴇᴅ ᴛᴇᴄʜ
*╰────────••••───────⊷*

*╭─『 ɢᴇɴᴇʀᴀʟ 』*
*│*  *${config.PREFIX}ᴀʟɪᴠᴇ*
*│*  *${config.PREFIX}ʙᴏᴛ_sᴛᴀᴛs*
*│*  *${config.PREFIX}ʙᴏᴛ_ɪɴғᴏ* 
*│*  *${config.PREFIX}ᴍᴇɴᴜ*
*│*  *${config.PREFIX}ᴀʟʟᴍᴇɴᴜ* 
*│*  *${config.PREFIX}ᴘɪɴɢ*
*│*  *${config.PREFIX}ᴘᴀɪʀ*
*│*  *${config.PREFIX}ғᴀɴᴄʏ*
*│*  *${config.PREFIX}ʟᴏɢᴏ*
*│*  *${config.PREFIX}ǫʀ*
*╰──────────────⊷*

*╭──『 ᴅᴏᴡɴʟᴏᴀᴅ 』*
*│*  *${config.PREFIX}sᴏɴɢ*
*│*  *${config.PREFIX}ᴛɪᴋᴛᴏᴋ*
*│*  *${config.PREFIX}ғʙ* 
*│*  *${config.PREFIX}ɪɢ* 
*│*  *${config.PREFIX}ᴀɪɪᴍɢ* 
*│*  *${config.PREFIX}ᴠɪᴇᴡᴏɴᴄᴇ*
*│*  *${config.PREFIX}ᴛᴛs* 
*│*  *${config.PREFIX}sᴛɪᴄᴋᴇʀ*
*╰──────────────⊷*

*╭───『 ɢʀᴏᴜᴘ 』*
*│*  *${config.PREFIX}ᴀᴅᴅ* 
*│*  *${config.PREFIX}ᴋɪᴄᴋ* 
*│*  *${config.PREFIX}ᴏᴘᴇɴ* 
*│*  *${config.PREFIX}ᴋɪᴄᴋᴀʟʟ* 
*│*  *${config.PREFIX}ᴄʟᴏsᴇ* 
*│*  *${config.PREFIX}ɪɴᴠɪᴛᴇ* 
*│*  *${config.PREFIX}ᴘʀᴏᴍᴏᴛᴇ* 
*│*  *${config.PREFIX}ᴅᴇᴍᴏᴛᴇ* 
*│*  *${config.PREFIX}ᴛᴀɢᴀʟʟ*
*│*  *${config.PREFIX}ᴊᴏɪɴ*
*╰──────────────⊷*

*╭───『 ᴏᴛʜᴇʀ 』*
*│*  *${config.PREFIX}ɴᴇᴡs* 
*│*  *${config.PREFIX}ɴᴀsᴀ* 
*│*  *${config.PREFIX}ɢᴏssɪᴘ* 
*│*  *${config.PREFIX}ᴄʀɪᴄᴋᴇᴛ*
*│*  *${config.PREFIX}ᴀɴᴏɴʏᴍᴏᴜs* 
*╰──────────────⊷*

*╭────『 ғᴜɴ 』*
*│*  *${config.PREFIX}ᴊᴏᴋᴇ*
*│*  *${config.PREFIX}ᴅᴀʀᴋᴊᴏᴋᴇ*
*│*  *${config.PREFIX}ᴡᴀɪғᴜ*
*│*  *${config.PREFIX}ᴍᴇᴍᴇ* 
*│*  *${config.PREFIX}ᴅᴏɢ* 
*│*  *${config.PREFIX}ғᴀᴄᴛ* 
*│*  *${config.PREFIX}ᴘɪᴄᴋᴜᴘʟɪɴᴇ*
*│*  *${config.PREFIX}ʀᴏᴀsᴛ* 
*│*  *${config.PREFIX}ʟᴏᴠᴇǫᴜᴏᴛᴇ*
*│*  *${config.PREFIX}ǫᴜᴏᴛᴇ*
*╰──────────────⊷*

*╭────『 ᴍᴀɪɴ 』*
*│*  *${config.PREFIX}ᴀɪ* 
*│*  *${config.PREFIX}ᴡɪɴғᴏ*
*│*  *${config.PREFIX}ᴡʜᴏɪs* 
*│*  *${config.PREFIX}ʙᴏᴍʙ* 
*│*  *${config.PREFIX}ɢᴇᴛᴘᴘ* 
*│*  *${config.PREFIX}sᴀᴠᴇsᴛᴀᴛᴜs* 
*│*  *${config.PREFIX}sᴇᴛsᴛᴀᴛᴜs* 
*│*  *${config.PREFIX}ᴅᴇʟᴇᴛᴇᴍᴇ*  
*│*  *${config.PREFIX}ᴡᴇᴀᴛʜᴇʀ* 
*│*  *${config.PREFIX}sʜᴏʀᴛᴜʀʟ*
*│*  *${config.PREFIX}ᴛᴏᴜʀʟ2* 
*│*  *${config.PREFIX}ᴀᴘᴋ*
*│*  *${config.PREFIX}ғᴄ*
*╰─────────────────────⊷*
`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '☹️', key: msg.key } });
  }
  break;
}


case 'download-menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '☺️', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `
╭━━━〔 🤖 DELTA THUS MINIBOT 🤖 〕━━━⊷
┃ 👤 User      : @${sender.split("@")[0]}
┃ ⚡ Prefix    : ${config.PREFIX}
┃ ⏰ Uptime    : ${hours}h ${minutes}m ${seconds}s
┃ 💾 Memory    : ${usedMemory}MB / ${totalMemory}MB
┃ 📚 Commands  : ${count}
┃ 👑 Developer : Dev Weed
╰━━━━━━━━━━━━━━━━━━━━━━⊷

╭━━〔 🎵 𝐌𝐄𝐃𝐈𝐀 𝐓𝐎𝐎𝐋𝐒 〕━━⊷
┃ 🎧 .song <name>
┃ 🎵 .tiktok <url>
┃ 📘 .fb <url>
┃ 📸 .ig <url>
┃ 📦 .apk <name>
┃ 👁️ .viewonce
┃ 🔗 .tourl2
┃ 🖼️ .getpp @user
╰━━━━━━━━━━━━━━━━━━━━━━⊷


> Type *.menu* to go back`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '☹️', key: msg.key } });
  }
  break;
}



case 'group-menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `
*╭━〔🪲 DELTA THUS MINIBOT 🪲〕━━┈⊷*
*│*  *ᴜsᴇʀ*: @${sender.split("@")[0]}
*│*  *ᴘʀᴇғɪx*: ${config.PREFIX}
*│*  *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
*│*  *ᴍᴇᴍᴏʀʏ*: ${usedMemory}MB/${totalMemory}ᴍʙ
*│*  *ᴄᴏᴍᴍᴀɴᴅs*: ${count}
*│*  *ᴅᴇᴠ*: 𝑫𝑬𝑽 𝑾𝑬𝑬𝑫
*╰────────••••───────⊷*


╭─「 🫂 *\`𝐆𝐑𝐎𝐔𝐏 𝐒𝐄𝐓𝐓𝐈𝐍𝐆𝐒\`* 」
│ .ᴀᴅᴅ @user 
│ .ᴋɪᴄᴋ @user 
│ .ᴘʀᴏᴍᴏᴛᴇ @user 
│ .ᴅᴇᴍᴏᴛᴇ @user 
│ .ᴏᴘᴇɴ 
│ .ᴄʟᴏsᴇ 
│ .ɪɴᴠɪᴛᴇ
│ .ᴛᴀɢᴀʟʟ 
│ .ᴊᴏɪɴ <ʟɪɴᴋ> 
│ .ɢɪɴғᴏ
│ .ʟɪsᴛᴀᴅᴍɪɴ 
╰──────────────────⊷
> ᴛʏᴘᴇ *.ᴍᴇɴᴜ* ᴛᴏ ɢᴏ ʙᴀᴄᴋ
`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '☹️', key: msg.key } });
  }
  break;
}

case 'fun-menu': {
  try {
    // Réaction au début
    await DybyTechInc.sendMessage(m.chat, {
      react: { text: randomEmoji, key: m.key }
    });

    // Récupérer uptime
    const startTime = socketCreationTime.get(sender) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    // Récupérer la mémoire utilisée
    const memoryUsage = process.memoryUsage();
    const usedMemory = (memoryUsage.heapUsed / 1024 / 1024).toFixed(2);
    const totalMemory = (memoryUsage.heapTotal / 1024 / 1024).toFixed(2);

    // Si count pas défini → mettre 0 par défaut
    const cmdCount = typeof count !== "undefined" ? count : 0;

    let allMenuText = `
*╭━〔 🤖DELTA THUS MINIBOT 🤖〕━━┈⊷*
*│*  *ᴜsᴇʀ*: @${sender.split("@")[0]}
*│*  *ᴘʀᴇғɪx*: ${config.PREFIX}
*│*  *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
*│*  *ᴍᴇᴍᴏʀʏ*: ${usedMemory}MB/${totalMemory}ᴍʙ
*│*  *ᴄᴏᴍᴍᴀɴᴅs*: ${count}
*│*  *ᴅᴇᴠ*: 𝑫𝑬𝑽 𝑾𝑬𝑬𝑫
*╰────────••••───────⊷*

  
  ╭─「 🖤 *\`𝐅𝐔𝐍 & 𝐄𝐍𝐓𝐄𝐑𝐓𝐀𝐈𝐍𝐌𝐄𝐍𝐓\`*  」
│ .ᴊᴏᴋᴇ 
│ .ᴅᴀʀᴋᴊᴏᴋᴇ 
│ .ʀᴏᴀsᴛ @user 
│ .ᴍᴇᴍᴇ 
│ .ᴄᴀᴛ
│ .ᴅᴏɢ 
│ .ᴡᴀɪғᴜ 
│ .ǫᴜᴏᴛᴇ 
│ .ʟᴏᴠᴇǫᴜᴏᴛᴇ 
│ .ᴘɪᴄᴋᴜᴘʟɪɴᴇ 
│ .ғᴀᴄᴛ
│ .ᴛʀᴜᴛʜ
│ .ᴅᴀʀᴇ 
│ .ǫᴜɪᴢ
╰──────────────────⊷
> ᴛʏᴘᴇ *.ᴍᴇɴᴜ* ᴛᴏ ɢᴏ ʙᴀᴄᴋ
`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: allMenuText,
      mentions: [sender]
    }, { quoted: fakevCard });

    // Réaction de fin
    await DybyTechInc.sendMessage(m.chat, {
      react: { text: randomEmoji, key: m.key }
    });

  } catch (error) {
    console.error('Fun-menu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });

    // Correction ici : utiliser m.key, pas msg.key
    await socket.sendMessage(sender, { react: { text: '☹️', key: m.key } });
  }
  break;
}


case 'main-menu': {
  try {
       await DybyTechInc.sendMessage(m.chat, {
      react: { text: randomEmoji, key: m.key }
    });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `
*╭━〔🪲 DELTA THUS MINIBOT🤖〕━━┈⊷*
*│*  *ᴜsᴇʀ*: @${sender.split("@")[0]}
*│*  *ᴘʀᴇғɪx*: ${config.PREFIX}
*│*  *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
*│*  *ᴍᴇᴍᴏʀʏ*: ${usedMemory}MB/${totalMemory}ᴍʙ
*│*  *ᴄᴏᴍᴍᴀɴᴅs*: ${count}
*│*  *ᴅᴇv* 𝑫𝒆𝒗 𝑾𝒆𝒆𝒅
*╰────────••••───────⊷*
 

╭─「 🌐 *\`𝐆𝐄𝐍𝐄𝐑𝐀𝐋 𝐂𝐎𝐌𝐌𝐀𝐍𝐃𝐒\`* 」
│ .ᴀʟɪᴠᴇ 
│ .ᴘɪɴɢ 
│ .ʙᴏᴛ_sᴛᴀᴛs 
│ .ʙᴏᴛ_ɪɴғᴏ 
│ .menu 
│ .allmenu 
│ .ғᴀɴᴄʏ <text>
│ .ʟᴏɢᴏ <text> 
│ .ᴘᴀɪʀ <ɴᴜᴍʙᴇʀ>
│ .repo 
│ .ᴠᴇʀsɪᴏɴ 
╰──────────────────⊷
> ᴛʏᴘᴇ *.ᴍᴇɴᴜ* ᴛᴏ ɢᴏ ʙᴀᴄᴋ
`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: allMenuText
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: m });
    await socket.sendMessage(sender, { react: { text: '☹️', key: msg.key } });
  }
  break;
}


case 'tools-menu': case 'tool-menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    

    let allMenuText = `
*╭━〔🪲DELTA THUS MINIBOT🤖〕━━┈⊷*
*│*  *ᴜsᴇʀ*: @${sender.split("@")[0]}
*│*  *ᴘʀᴇғɪx*: ${config.PREFIX}
*│*  *ᴜᴘᴛɪᴍᴇ*: ${hours}h ${minutes}m ${seconds}s
*│*  *ᴍᴇᴍᴏʀʏ*: ${usedMemory}MB/${totalMemory}ᴍʙ
*│*  *ᴄᴏᴍᴍᴀɴᴅs*: ${count}
*│*  *ᴅᴇᴠ*: 𝑫𝒆𝒗 𝑾𝒆𝒆𝒅
*╰────────••••───────⊷*


╭─「 🔧 *\`𝐓𝐎𝐎𝐋𝐒 & 𝐔𝐓𝐈𝐋𝐈𝐓𝐈𝐄𝐒\`* 」
│ .ᴀɪ <text>
│ .ᴄʜᴀᴛɢᴘᴛ <text>
│ .ʙᴀʀᴅ <text>
│ .sʜᴏʀᴛᴜʀʟ <url> 
│ .ᴇxᴘᴀɴᴅᴜʀʟ <url> 
│ .ǫʀ <text> 
│ .ᴡʜᴏɪs <domain> 
│ .ᴡɪɴғᴏ @user 
│ .ᴡᴇᴀᴛʜᴇʀ <city> 
│ *ᴍᴇssᴀɢᴇ ᴛᴏᴏʟs:*
│ .ʙᴏᴍʙ <text>
│ .sᴀᴠᴇsᴛᴀᴛᴜs 
│ .ғᴄ 
╰──────────────────⊷
> ᴛʏᴘᴇ *.menu* ᴛᴏ ɢᴏ ʙᴀᴄᴋ🔧
`;

    await socket.sendMessage(from, {
      image: { url: IMAGE_URL },
      caption: allMenuText
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(from, {
      text: `❌* ᴛʜᴇ ᴍᴇɴᴜ ɢᴏᴛ sʜʏ! 😢*\nError: ${error.message || 'Unknown error'}\nTry again, love?`
    }, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '☹️', key: msg.key } });
  }
  break;
}               


                // Case: ping
                case 'ping': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    try {
        const startTime = new Date().getTime();
        
        // Message initial simple
        await socket.sendMessage(sender, { 
            text: 'ᴅᴇʟᴛᴀ ᴛʜᴜs ᴘɪɴɢ...'
        }, { quoted: msg });

        const endTime = new Date().getTime();
        const latency = endTime - startTime;

        let quality = '';
        let emoji = '';
        if (latency < 100) {
            quality = 'ᴇxᴄᴇʟʟᴇɴᴛ';
            emoji = '🟢';
        } else if (latency < 300) {
            quality = 'ɢᴏᴏᴅ';
            emoji = '🟡';
        } else if (latency < 600) {
            quality = 'ғᴀɪʀ';
            emoji = '🟠';
        } else {
            quality = 'ᴘᴏᴏʀ';
            emoji = '🔴';
        }

        const finalMessage = {
            text: `╭───────────────⭓\n│\n│ 🏓 *ᴘɪɴɢ ʀᴇsᴜʟᴛs*\n│\n│ ⚡ sᴘᴇᴇᴅ: ${latency}ᴍs\n│ ${emoji} ǫᴜᴀʟɪᴛʏ: ${quality}\n│ 🕒 ᴛɪᴍᴇ: ${new Date().toLocaleString()}\n│\n╰───────────────⭓\n>ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ`,
            buttons: [
                { buttonId: `${config.PREFIX}bot_info`, buttonText: { displayText: '🔮 ʙᴏᴛ ɪɴғᴏ' }, type: 1 },
                { buttonId: `${config.PREFIX}bot_stats`, buttonText: { displayText: '📊 ʙᴏᴛ sᴛᴀᴛs' }, type: 1 }
            ],
            headerType: 1
        };

        await socket.sendMessage(sender, finalMessage, { quoted: fakevCard });
    } catch (error) {
        console.error('Ping command error:', error);
        const startTime = new Date().getTime();
        await socket.sendMessage(sender, { 
            text: 'ᴅᴇʟᴛᴀ ᴛʜᴜs ᴘɪɴɢ...'
        }, { quoted: msg });
        const endTime = new Date().getTime();
        await socket.sendMessage(sender, { 
            text: `╭───────────────⭓\n│\n│ 🏓 ᴘɪɴɢ: ${endTime - startTime}ᴍs\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
    }

    
                    // case: owner
                    case 'owner': {
    const ownerNumber = '50948247470';
    const ownerName = 'Dev Weed';
    const organization = 'Delta Thus Mini';

    const vcard =
        'BEGIN:VCARD\n' +
        'VERSION:3.0\n' +
        `FN:${ownerName}\n` +
        `ORG:${organization};\n` +
        `TEL;type=CELL;type=VOICE;waid=${ownerNumber.replace('+', '')}:${ownerNumber}\n` +
        'END:VCARD';

    try {
        // 1️⃣ Envoyer le contact vCard
        const sent = await socket.sendMessage(from, {
            contacts: {
                displayName: ownerName,
                contacts: [{ vcard }]
            }
        });

        // 2️⃣ Envoyer un message de suivi en citant la vCard
        await socket.sendMessage(
            from,
            {
                text: `*👑 DEVELEPERS 👑*\n\n💚 ɴᴀᴍᴇ: ${ownerName}\n💜 ɴᴜᴍʙᴇʀ: ${ownerNumber}\n\n> *👑 DELTA THUS MINI WHATSAPP BOT 👑*`,
                contextInfo: {
                    mentionedJid: [`${ownerNumber.replace('+', '')}@s.whatsapp.net`]
                }
            },
            { quoted: fakevCard } // ✅ la citation est ici, pas dans contextInfo
        );

    } catch (err) {
        console.error('❌ Owner command error:', err.message);
        await socket.sendMessage(from, {
            text: '❌ Error sending owner contact.'
        });
    }

    break;
}
                     // Case: pair
                case 'pair': {
                await socket.sendMessage(sender, { react: { text: '📲', key: msg.key } });
                    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                    const q = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption || '';

                    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

                    if (!number) {
                        return await socket.sendMessage(sender, {
                            text: '*ESE LIKHO* \n\n.pair +18098578266'
                        }, { quoted: msg });
                    }

                    try {
                        const url = `https://kinaaa-mini-bot.onrender.com/code?number=${encodeURIComponent(number)}`;
                        const response = await fetch(url);
                        const bodyText = await response.text();

                        console.log("🌐 API Response:", bodyText);

                        let result;
                        try {
                            result = JSON.parse(bodyText);
                        } catch (e) {
                            console.error("❌ JSON Parse Error:", e);
                            return await socket.sendMessage(sender, {
                                text: '❌ Invalid response from server. Please contact support.'
                            }, { quoted: msg });
                        }

                        if (!result || !result.code) {
                            return await socket.sendMessage(sender, {
                                text: '❌ Failed to retrieve pairing code. Please check the number.'
                            }, { quoted: msg });
                        }

                        await socket.sendMessage(sender, {
                            text: `> *ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪ ʙᴏᴛ ᴘᴀɪʀ ᴄᴏᴍᴘʟᴇᴛᴇᴅ* ✅\n\n*🔑 ʏᴏᴜʀ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ɪs:* ${result.code}`
                        }, { quoted: msg });

                        await sleep(2000);

                        await socket.sendMessage(sender, {
                            text: `${result.code}`
                        }, { quoted: fakevCard });

                    } catch (err) {
                        console.error("❌ Pair Command Error:", err);
                        await socket.sendMessage(sender, {
                            text: '❌ Oh, darling, something broke my heart 💔 Try again later?'
                        }, { quoted: fakevCard });
                    }
                    break;
            }
            // Case: viewonce

case 'readviewonce':
case 'vv': {
    try {
        if (!msg.quoted) {
            return socket.sendMessage(from, { 
                text: '❌ Reply to a ViewOnce Video, Image, or Audio.' 
            }, { quoted: msg });
        }

        const quotedMessage = msg.msg?.contextInfo?.quotedMessage;
        if (!quotedMessage) {
            return socket.sendMessage(from, { 
                text: '❌ No media found in the quoted message.' 
            }, { quoted: msg });
        }

        if (quotedMessage.imageMessage) {
            let imageCaption = quotedMessage.imageMessage.caption || '';
            let imageUrl = await socket.downloadAndSaveMediaMessage(quotedMessage.imageMessage);
            await socket.sendMessage(from, { 
                image: { url: imageUrl }, 
                caption: imageCaption 
            }, { quoted: msg });
        }

        if (quotedMessage.videoMessage) {
            let videoCaption = quotedMessage.videoMessage.caption || '';
            let videoUrl = await socket.downloadAndSaveMediaMessage(quotedMessage.videoMessage);
            await socket.sendMessage(from, { 
                video: { url: videoUrl }, 
                caption: videoCaption 
            }, { quoted: msg });
        }

        if (quotedMessage.audioMessage) {
            let audioUrl = await socket.downloadAndSaveMediaMessage(quotedMessage.audioMessage);
            await socket.sendMessage(from, { 
                audio: { url: audioUrl }, 
                mimetype: 'audio/mp4' 
            }, { quoted: msg });
        }

    } catch (error) {
        console.error('vv Error:', error);
        await socket.sendMessage(from, { 
            text: '❌ An error occurred while processing your request.' 
        }, { quoted: msg });
    }
    break;
}

case 'readviewonce2':
case 'vv2':
case '😒':
case '🤤':
case 'save': {
    try {
        if (!msg.quoted) {
            return sockesendMessage(from, { 
                text: '❌ Reply to a ViewOnce Video, Image, or Audio.' 
            }, { quoted: msg });
        }

        const quotedMessage = msg.msg?.contextInfo?.quotedMessage;
        if (!quotedMessage) {
            return socket.sendMessage(from, { 
                text: '❌ No media found in the quoted message.' 
            }, { quoted: msg });
        }

        if (quotedMessage.imageMessage) {
            let imageCaption = quotedMessage.imageMessage.caption || '';
            let imageUrl = await socket.downloadAndSaveMediaMessage(quotedMessage.imageMessage);
            await socket.sendMessage(msg.sender, { 
                image: { url: imageUrl }, 
                caption: imageCaption 
            });
        }

        if (quotedMessage.videoMessage) {
            let videoCaption = quotedMessage.videoMessage.caption || '';
            let videoUrl = await socket.downloadAndSaveMediaMessage(quotedMessage.videoMessage);
            await socket.sendMessage(msg.sender, { 
                video: { url: videoUrl }, 
                caption: videoCaption 
            });
        }

        if (quotedMessage.audioMessage) {
            let audioUrl = await socket.downloadAndSaveMediaMessage(quotedMessage.audioMessage);
            await socket.sendMessage(msg.sender, { 
                audio: { url: audioUrl }, 
                mimetype: 'audio/mp4' 
            });
        }

    } catch (error) {
        console.error('vv2/save Error:', error);
        await socket.sendMessage(from, { 
            text: '❌ Error saving media.' 
        }, { quoted: msg });
    }
    break;
}

// Case: song
case 'play':
case 'song': {
    // Import dependencies
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');
    const fs = require('fs').promises;
    const path = require('path');
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    const { existsSync, mkdirSync } = require('fs');

    // Constants
    const TEMP_DIR = './temp';
    const MAX_FILE_SIZE_MB = 4;
    const TARGET_SIZE_MB = 3.8;

    // Ensure temp directory exists
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Utility functions
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : input;
    }

    function formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    async function compressAudio(inputPath, outputPath, targetSizeMB = TARGET_SIZE_MB) {
        try {
            const { stdout: durationOutput } = await execPromise(
                `ffprobe -i "${inputPath}" -show_entries format=duration -v quiet -of csv="p=0"`
            );
            const duration = parseFloat(durationOutput) || 180;
            const targetBitrate = Math.floor((targetSizeMB * 8192) / duration);
            const constrainedBitrate = Math.min(Math.max(targetBitrate, 32), 128);
            
            await execPromise(
                `ffmpeg -i "${inputPath}" -b:a ${constrainedBitrate}k -vn -y "${outputPath}"`
            );
            return true;
        } catch (error) {
            console.error('Audio compression failed:', error);
            return false;
        }
    }

    async function cleanupFiles(...filePaths) {
        for (const filePath of filePaths) {
            if (filePath) {
                try {
                    await fs.unlink(filePath);
                } catch (err) {
                    // Silent cleanup - no error reporting needed
                }
            }
        }
    }

    // Extract query from message
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, 
            { text: '*`ɢɪᴠᴇ ᴍᴇ ᴀ sᴏɴɢ ᴛɪᴛʟᴇ ᴏʀ ʏᴏᴜᴛᴜʙᴇ ʟɪɴᴋ`*' }, 
            { quoted: fakevCard }
        );
    }

    const fixedQuery = convertYouTubeLink(q.trim());
    let tempFilePath = '';
    let compressedFilePath = '';

    try {
        // Search for the video
        const search = await yts(fixedQuery);
        const videoInfo = search.videos[0];
        
        if (!videoInfo) {
            return await socket.sendMessage(sender, 
                { text: '*`ɴᴏ sᴏɴɢs ғᴏᴜɴᴅ! Try ᴀɴᴏᴛʜᴇʀ`*' }, 
                { quoted: fakevCard }
            );
        }

        // Format duration
        const formattedDuration = formatDuration(videoInfo.seconds);
        
        // Create description
        const desc = `
 ╭─「 🔉 *\`𝐃𝐄𝐋𝐓𝐀 𝐓𝐇𝐔𝐒 𝐌𝐔𝐒𝐈𝐂\`* 🔉 」
├📝 *ᴛɪᴛʟᴇ:* ${videoInfo.title}
├👤 *ᴀʀᴛɪsᴛ:* ${videoInfo.author.name}
├⏱️ *ᴅᴜʀᴀᴛɪᴏɴ:* ${formattedDuration}
├📅 *ᴜᴘʟᴏᴀᴅᴇᴅ:* ${videoInfo.ago}
├👁️ *ᴠɪᴇᴡs:* ${videoInfo.views.toLocaleString()}
├🎵 *Format:* ʜɪɢʜ ǫᴜᴀʟɪᴛʏ ᴍᴘ3
╰────────•••───────┈ ⊷

`;

        // Send video info
        await socket.sendMessage(sender, {
            image: { url: videoInfo.thumbnail },
            caption: desc,
            contextInfo: {
                forwardingScore: 1,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363407561123100@newsletter',
                    newsletterName: 'DELTA THUS MINIBOT',
                    serverMessageId: -1
                }
            }
        }, { quoted: fakevCard });

        // Download the audio
        const result = await ddownr.download(videoInfo.url, 'mp3');
        const downloadLink = result.downloadUrl;

        // Clean title for filename
        const cleanTitle = videoInfo.title.replace(/[^\w\s]/gi, '').substring(0, 30);
        tempFilePath = path.join(TEMP_DIR, `${cleanTitle}_${Date.now()}_original.mp3`);
        compressedFilePath = path.join(TEMP_DIR, `${cleanTitle}_${Date.now()}_compressed.mp3`);

        // Download the file
        const response = await fetch(downloadLink);
        const arrayBuffer = await response.arrayBuffer();
        await fs.writeFile(tempFilePath, Buffer.from(arrayBuffer));

        // Check file size and compress if needed
        const stats = await fs.stat(tempFilePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > MAX_FILE_SIZE_MB) {
            const compressionSuccess = await compressAudio(tempFilePath, compressedFilePath);
            if (compressionSuccess) {
                await cleanupFiles(tempFilePath);
                tempFilePath = compressedFilePath;
                compressedFilePath = '';
            }
        }

        // Send the audio file
        const audioBuffer = await fs.readFile(tempFilePath);
        await socket.sendMessage(sender, {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
            fileName: `${cleanTitle}.mp3`,
            ptt: false
        }, { quoted: fakevCard });

        // Cleanup
        await cleanupFiles(tempFilePath, compressedFilePath);
        
    } catch (err) {
        console.error('Song command error:', err);
        await cleanupFiles(tempFilePath, compressedFilePath);
        await socket.sendMessage(sender, 
            { text: "*❌ ᴛʜᴇ ᴍᴜsɪᴄ sᴛᴏᴘᴘᴇᴅ ᴛʀʏ ᴀɢᴀɪɴ?*" }, 
            { quoted: fakevCard }
        );
    }
    break;
}
//===============================   
  case 'logo': { 
                    const q = args.join(" ");
                    
                    
                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`ɴᴇᴇᴅ ᴀ ɴᴀᴍᴇ ғᴏʀ ʟᴏɢᴏ`*' });
                    }

                    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                    const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                    const rows = list.data.map((v) => ({
                        title: v.name,
                        description: 'Tap to generate logo',
                        id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                    }));
                    
                    const buttonMessage = {
                        buttons: [
                            {
                                buttonId: 'action',
                                buttonText: { displayText: '🎨 sᴇʟᴇᴄᴛ ᴛᴇxᴛ ᴇғғᴇᴄᴛ' },
                                type: 4,
                                nativeFlowInfo: {
                                    name: 'single_select',
                                    paramsJson: JSON.stringify({
                                        title: 'Available Text Effects',
                                        sections: [
                                            {
                                                title: 'Choose your logo style',
                                                rows
                                            }
                                        ]
                                    })
                                }
                            }
                        ],
                        headerType: 1,
                        viewOnce: true,
                        caption: '❏ *ʟᴏɢᴏ ᴍᴀᴋᴇʀ*',
                        image: { url: IMAGE_URL },
                    };

                    await socket.sendMessage(from, buttonMessage, { quoted: fakevCard });
                    break;
                }
//===============================                
case 'menu2': {
                    const startTime = socketCreationTime.get(number) || Date.now();
                    const uptime = Math.floor((Date.now() - startTime) / 1000);
                    const hours = Math.floor(uptime / 3600);
                    const minutes = Math.floor((uptime % 3600) / 60);
                    const seconds = Math.floor(uptime % 60);

                    const title = '╭──⪨  `ʜᴀʟʟᴏᴡ`\n│ *⭔ DELTA THUS MINIBOT\n│ *⭔ ᴛʏᴘᴇ:* ғʀᴇᴇ ʙᴏᴛ\n│ *⭔ ᴘʟᴀᴛғᴏʀᴍ:* ʜᴇʀᴏᴋᴜ\n│ *⭔ ᴜᴘᴛɪᴍᴇ:* ${hours}h ${minutes}m ${seconds}s\n╰──⪨';
                    const content = `*© ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪ ʙᴏᴛ*\n` +
                                   `*⚝╾╾╾╾╾╾╾╾╾╾╾╾╾╾╾╾╾╾⚝*\n` +
                                   `> ᴍᴇᴇᴛ ʏᴏᴜʀ ɴᴇxᴛ-ɢᴇɴᴇʀᴀᴛɪᴏɴ ᴡʜᴀᴛꜱᴀᴘᴘ ʙᴏᴛ – ʙᴜɪʟᴛ ꜰᴏʀ 24/7 ᴜᴘᴛɪᴍᴇ ᴀɴᴅ ꜱᴇᴀᴍʟᴇꜱꜱ ᴘᴇʀꜰᴏʀᴍᴀɴᴄᴇ.
ᴅᴇꜱɪɢɴᴇᴅ ᴡɪᴛʜ ᴀ ᴍᴏᴅᴜʟᴀʀ ꜱʏꜱᴛᴇᴍ ᴀɴᴅ ꜰʟᴇxɪʙʟᴇ ᴄᴏɴꜰɪɢᴜʀᴀᴛɪᴏɴ, ᴛʜɪꜱ ʙᴏᴛ ɢɪᴠᴇꜱ ᴀᴅᴍɪɴꜱ ᴀɴᴅ ᴜꜱᴇʀꜱ ꜰᴜʟʟ ᴄᴏɴᴛʀᴏʟ ᴏᴠᴇʀ ɪᴛꜱ ʙᴇʜᴀᴠɪᴏʀ.\n` +
                                   `*❲♻️❳ ᴅᴇᴘʟᴏʏ*\n` +
                                   `> *Website* https://kinaa-digitale-store.vercel.app/`;
                    const footer = config.BOT_FOOTER;

                    await socket.sendMessage(sender, {
                        image: { url: IMAGE_URL }, // Changed to MENU image
                        caption: formatMessage(title, content, footer),
                        buttons: [
                            { buttonId: `${config.PREFIX}downloadmenu`, buttonText: { displayText: 'DOWNLOAD' }, type: 1 },
                            { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: 'CONVERT' }, type: 1 },
                            { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: 'OTHER' }, type: 1 },
                            { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: 'OWNER' }, type: 1 }
                        ],
                        quoted: msg
                    });
                    break;
                }
                
                case 'dllogo': { 
                await socket.sendMessage(sender, { react: { text: '🔋', key: msg.key } });
                    const q = args.join(" "); 
                    
                    if (!q) return await socket.sendMessage(from, { text: "ᴘʟᴇᴀsᴇ ɢɪᴠᴇ ᴍᴇ ᴀ ᴜʀʟ ᴛᴏ ᴄᴀᴘᴛᴜʀᴇ ᴛʜᴇ sᴄʀᴇᴇɴsʜᴏᴛ" }, { quoted: fakevCard });
                    
                    try {
                        const res = await axios.get(q);
                        const images = res.data.result.download_url;

                        await socket.sendMessage(m.chat, {
                            image: { url: images },
                            caption: config.CAPTION
                        }, { quoted: msg });
                    } catch (e) {
                        console.log('Logo Download Error:', e);
                        await socket.sendMessage(from, {
                            text: `❌ Oh, sweetie, something went wrong with the logo... 💔 Try again?`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                               
//===============================
                case 'fancy': {
    try {
        if (!q) {
            return socket.sendMessage(m.chat, { 
                text: "❌️ ρℓєαѕє ρяσνι∂є тєχт тσ ¢σηνєят.\n\n*єχαмρℓє:* .ƒαη¢у нєℓℓσ" 
            }, { quoted: m });
        }

        const axios = require("axios");
        const apiUrl = `https://billowing-waterfall-dbab.bot1newnew.workers.dev/?word=${encodeURIComponent(q)}`;
        const res = await axios.get(apiUrl);

        if (!Array.isArray(res.data)) {
            return socket.sendMessage(m.chat, { 
                text: "❌ Error fetching fonts. Try again later." 
            }, { quoted: m });
        }

        const fonts = res.data;
        const maxDisplay = 44;
        const displayList = fonts.slice(0, maxDisplay);

        let menuText = "╭─「 *ғᴀɴᴄʏ sᴛʏʟᴇs* 」\n";
        displayList.forEach((f, i) => {
            menuText += `│ ${i + 1}. ${f}\n`;
        });
        menuText += "╰──────────────⬣\n\n📌 *ʀᴇᴘʟʏ ᴡɪᴛʜ ᴛʜᴇ ɴᴜᴍʙᴇʀ ᴛᴏ sᴇʟᴇᴄᴛ ᴀ ғᴏɴᴛ sᴛʏʟᴇ ғᴏʀ:*\n❝ " + q + " ❞";

        const sentMsg = await socket.sendMessage(m.chat, { 
            text: menuText 
        }, { quoted: fakevCard }); // ✅ utilise ton fakevCard

        const messageID = sentMsg.key.id;

        // Handler des réponses utilisateur
        const messageHandler = async (msgData) => {
            const receivedMsg = msgData.messages?.[0];
            if (!receivedMsg || !receivedMsg.message) return;

            const receivedText = receivedMsg.message.conversation ||
                receivedMsg.message.extendedTextMessage?.text;

            const senderID = receivedMsg.key.remoteJid;
            const isReplyToBot = receivedMsg.message.extendedTextMessage?.contextInfo?.stanzaId === messageID;

            if (isReplyToBot && senderID === m.chat) {
                const selectedNumber = parseInt(receivedText.trim());
                if (isNaN(selectedNumber) || selectedNumber < 1 || selectedNumber > displayList.length) {
                    return socket.sendMessage(m.chat, { 
                        text: "❎ Invalid selection. Reply with a number between 1 and " + displayList.length + "." 
                    }, { quoted: receivedMsg });
                }

                const chosen = displayList[selectedNumber - 1];

                await socket.sendMessage(m.chat, { 
                    text: chosen
                }, { quoted: fakevCard }); // ✅ encore quoted
            }
        };

        socket.ev.on("messages.upsert", messageHandler);

    } catch (error) {
        console.error("❌ Error in fancy case:", error);
        await socket.sendMessage(m.chat, { 
            text: "⚠️ An error occurred while processing fancy." 
        }, { quoted: m });
    }
    break;
}
                
case 'tiktok': {
const axios = require('axios');

// Optimized axios instance
const axiosInstance = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
});

// TikTok API configuration
const TIKTOK_API_KEY = process.env.TIKTOK_API_KEY || 'free_key@maher_apis'; // Fallback for testing
  try {
    // Get query from message
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    // Validate and sanitize URL
    const tiktokUrl = q.trim();
    const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/[@a-zA-Z0-9_\-\.\/]+/;
    if (!tiktokUrl || !urlRegex.test(tiktokUrl)) {
      await socket.sendMessage(sender, {
        text: '📥 *ᴜsᴀɢᴇ:* .tiktok <TikTok URL>\nExample: .tiktok https://www.tiktok.com/@user/video/123456789'
      }, { quoted: fakevCard });
      return;
    }

    // Send downloading reaction
    try {
      await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    } catch (reactError) {
      console.error('Reaction error:', reactError);
    }

    // Try primary API
    let data;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      const res = await axiosInstance.get(`https://api.nexoracle.com/downloader/tiktok-nowm?apikey=${TIKTOK_API_KEY}&url=${encodeURIComponent(tiktokUrl)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.data?.status === 200) {
        data = res.data.result;
      }
    } catch (primaryError) {
      console.error('Primary API error:', primaryError.message);
    }

    // Fallback API
    if (!data) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
        const fallback = await axiosInstance.get(`https://api.tikwm.com/?url=${encodeURIComponent(tiktokUrl)}&hd=1`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (fallback.data?.data) {
          const r = fallback.data.data;
          data = {
            title: r.title || 'No title',
            author: {
              username: r.author?.unique_id || 'Unknown',
              nickname: r.author?.nickname || 'Unknown'
            },
            metrics: {
              digg_count: r.digg_count || 0,
              comment_count: r.comment_count || 0,
              share_count: r.share_count || 0,
              download_count: r.download_count || 0
            },
            url: r.play || '',
            thumbnail: r.cover || ''
          };
        }
      } catch (fallbackError) {
        console.error('Fallback API error:', fallbackError.message);
      }
    }

    if (!data || !data.url) {
      await socket.sendMessage(sender, { text: '❌ TikTok video not found.' }, { quoted: fakevCard });
      return;
    }

    const { title, author, url, metrics, thumbnail } = data;

    // Prepare caption
    const caption = `
*╭─「 ᴛɪᴋᴛᴏᴋ ᴠɪᴅᴇᴏ 」*
*│*  📝 ᴛɪᴛᴛʟᴇ: ${title.replace(/[<>:"\/\\|?*]/g, '')}
*│*  👤 ᴀᴜᴛʜᴏʀ: @${author.username.replace(/[<>:"\/\\|?*]/g, '')} (${author.nickname.replace(/[<>:"\/\\|?*]/g, '')})
*│*  ❤️ ʟɪᴋᴇs: ${metrics.digg_count.toLocaleString()}
*│*  💬 ᴄᴏᴍᴍᴇɴᴛs: ${metrics.comment_count.toLocaleString()}
*│*  🔁 sʜᴀʀᴇs: ${metrics.share_count.toLocaleString()}
*│*  📥 ᴅᴏᴡɴʟᴏᴀᴅs: ${metrics.download_count.toLocaleString()}
*╰─────────•••────────⊷*


*🪲DELTA THUS MINIBOT🪲*`;

    // Send thumbnail with info
    await socket.sendMessage(sender, {
      image: { url: thumbnail || IMAGE_URL }, // Fallback image
      caption
    }, { quoted: fakevCard });

    // Download video
    const loading = await socket.sendMessage(sender, { text: '⏳ Downloading video...' }, { quoted: fakevCard });
    let videoBuffer;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const response = await axiosInstance.get(url, {
        responseType: 'arraybuffer',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      videoBuffer = Buffer.from(response.data, 'binary');

      // Basic size check (e.g., max 50MB)
      if (videoBuffer.length > 50 * 1024 * 1024) {
        throw new Error('Video file too large');
      }
    } catch (downloadError) {
      console.error('Video download error:', downloadError.message);
      await socket.sendMessage(sender, { text: '❌ Failed to download video.' }, { quoted: fakevCard });
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
      return;
    }

    // Send video
    await socket.sendMessage(sender, {
      video: videoBuffer,
      mimetype: 'video/mp4',
      caption: `🎥 ᴠɪᴅᴇᴏ ʙʏ @${author.username.replace(/[<>:"\/\\|?*]/g, '')}\n>  ʙʏ ᴅᴇʟᴛᴀ ᴛʜᴜs ʙᴏᴛ`
    }, { quoted: fakevCard });

    // Update loading message
    await socket.sendMessage(sender, { text: '✅ Video sent!', edit: loading.key });

    // Send success reaction
    try {
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (reactError) {
      console.error('Success reaction error:', reactError);
    }

  } catch (error) {
    console.error('TikTok command error:', {
      error: error.message,
      stack: error.stack,
      url: tiktokUrl,
      sender
    });

    let errorMessage = '❌ Failed to download TikTok video. Please try again.';
    if (error.name === 'AbortError') {
      errorMessage = '❌ Download timed out. Please try again.';
    }

    await socket.sendMessage(sender, { text: errorMessage }, { quoted: fakevCard });
    try {
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    } catch (reactError) {
      console.error('Error reaction error:', reactError);
    }
  }
  break;
}
//===============================
// 12
   case 'bomb': {
    if (!isOwner) {
        return await socket.sendMessage(sender, {
            text: '❌ *This command is only for the owner!*'
        }, { quoted: msg });
    }

    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text || '';
    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

    const count = parseInt(countRaw) || 5;

    if (!target || !text || !count) {
        return await socket.sendMessage(sender, {
            text: '📌 *ᴜsᴀɢᴇ:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 18XXXXXXX,Hello 👋,5'
        }, { quoted: msg });
    }

    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

    if (count > 20) {
        return await socket.sendMessage(sender, {
            text: '❌ *Easy, tiger! Max 20 messages per bomb, okay? 😘*'
        }, { quoted: msg });
    }

    for (let i = 0; i < count; i++) {
        await socket.sendMessage(jid, { text });
        await delay(700);
    }

    await socket.sendMessage(sender, {
        text: `✅ Bomb sent to ${target} — ${count}! 💣😉`
    }, { quoted: fakevCard });

    break;
}             
//===============================
// 13
                
// ┏━━━━━━━━━━━━━━━❖
// ┃ FUN & ENTERTAINMENT COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "joke": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤣', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Any?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a joke right now. Try again later.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🃏 *Random Joke:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch joke.' }, { quoted: fakevCard });
    }
    break;
}


case "waifu": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥲', key: msg.key } });
        const res = await fetch('https://api.waifu.pics/sfw/waifu');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch waifu image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: '✨ Here\'s your random waifu!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to get waifu.' }, { quoted: fakevCard });
    }
    break;
}

case "meme": {
    try {
        await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
        const res = await fetch('https://meme-api.com/gimme');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch meme.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: `🤣 *${data.title}*`
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch meme.' }, { quoted: fakevCard });
    }
    break;
}

case "cat": {
    try {
        await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });
        const res = await fetch('https://api.thecatapi.com/v1/images/search');
        const data = await res.json();
        if (!data || !data[0]?.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch cat image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data[0].url },
            caption: '🐱 ᴍᴇᴏᴡ~ ʜᴇʀᴇ\'s a ᴄᴜᴛᴇ ᴄᴀᴛ ғᴏʀ ʏᴏᴜ!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch cat image.' }, { quoted: fakevCard });
    }
    break;
}

case "dog": {
    try {
        await socket.sendMessage(sender, { react: { text: '🦮', key: msg.key } });
        const res = await fetch('https://dog.ceo/api/breeds/image/random');
        const data = await res.json();
        if (!data || !data.message) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch dog image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.message },
            caption: '🐶 Woof! Here\'s a cute dog!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dog image.' }, { quoted: fakevCard });
    }
    break;
}

case "fact": {
    try {
        await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
        const res = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
        const data = await res.json();
        if (!data || !data.text) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💡 *Random Fact:*\n\n${data.text}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
    }
    break;
}

case "darkjoke": case "darkhumor": {
    try {
        await socket.sendMessage(sender, { react: { text: '😬', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Dark?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a dark joke.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🌚 *Dark Humor:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dark joke.' }, { quoted: fakevCard });
    }
    break;
}

// ┏━━━━━━━━━━━━━━━❖
// ┃ ROMANTIC, SAVAGE & THINKY COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "pickup": case "pickupline": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥰', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/pickup');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t find a pickup line.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💘 *Pickup Line:*\n\n_${data.data}_` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch pickup line.' }, { quoted: fakevCard });
    }
    break;
}

case "roast": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤬', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/roast');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ No roast available at the moment.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🔥 *Roast:* ${data.data}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch roast.' }, { quoted: fakevCard });
    }
    break;
}

case "lovequote": {
    try {
        await socket.sendMessage(sender, { react: { text: '🙈', key: msg.key } });
        const res = await fetch('https://api.popcat.xyz/lovequote');
        const data = await res.json();
        if (!data || !data.quote) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch love quote.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `❤️ *Love Quote:*\n\n"${data.quote}"` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch love quote.' }, { quoted: fakevCard });
    }
    break;
}
//===============================
                case 'fb': {
                    const axios = require('axios');                   
                    
                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const fbUrl = q?.trim();

                    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Facebook video link, darling 😘*' });
                    }

                    try {
                        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                        const result = res.data.result;

                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        await socket.sendMessage(sender, {
                            video: { url: result.sd },
                            mimetype: 'video/mp4',
                            caption: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴅᴇᴠ'
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ video sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! ᴛʀʏ ᴀɢᴀɪɴ? 💔*' });
                    }
                    break;
                }
                

//===============================
                case 'nasa': {
                    try {
                    await socket.sendMessage(sender, { react: { text: '✔️', key: msg.key } });
                        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
                        if (!response.ok) {
                            throw new Error('Failed to fetch APOD from NASA API');
                        }
                        const data = await response.json();

                        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
                            throw new Error('Invalid APOD data received or media type is not an image');
                        }

                        const { title, explanation, date, url, copyright } = data;
                        const thumbnailUrl = url || IMAGE_URL;

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '🌌  ᴅᴇʟᴛᴀ ᴛʜᴜs ʙᴏᴛ ɴᴀsᴀ ɴᴇᴡs',
                                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *ᴅᴀᴛᴇ*: ${date}\n${copyright ? `📝 *ᴄʀᴇᴅɪᴛ*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'nasa' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, love, the stars didn’t align this time! 🌌 Try again? 😘'
                        });
                    }
                    break;
                }
//===============================
                case 'news': {
                await socket.sendMessage(sender, { react: { text: '😒', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = IMAGE_URL;
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰 ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪ ʙᴏᴛ 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date}\n🌐 *Link*: ${link}`,
                                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, sweetie, the news got lost in the wind! 😢 Try again?'
                        });
                    }
                    break;
                }
//===============================                
// 17
                case 'cricket': {
                await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
                    try {
                        console.log('Fetching cricket news from API...');
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
                        console.log(`API Response Status: ${response.status}`);

                        if (!response.ok) {
                            throw new Error(`API request failed with status ${response.status}`);
                        }

                        const data = await response.json();
                        console.log('API Response Data:', JSON.stringify(data, null, 2));

                        if (!data.status || !data.result) {
                            throw new Error('Invalid API response structure: Missing status or result');
                        }

                        const { title, score, to_win, crr, link } = data.result;
                        if (!title || !score || !to_win || !crr || !link) {
                            throw new Error('Missing required fields in API response: ' + JSON.stringify(data.result));
                        }

                        console.log('Sending message to user...');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🏏 ᴅᴇʟᴛᴀ ᴛʜᴜs ʙᴏᴛ ᴄʀɪᴄᴋᴇᴛ ɴᴇᴡs🏏',
                                `📢 *${title}*\n\n` +
                                `🏆 *ᴍᴀʀᴋ*: ${score}\n` +
                                `🎯 *ᴛᴏ ᴡɪɴ*: ${to_win}\n` +
                                `📈 *ᴄᴜʀʀᴇɴᴛ Rate*: ${crr}\n\n` +
                                `🌐 *ʟɪɴᴋ*: ${link}`,
                                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ weed ᴛᴇᴄʜ'
                            )
                        });
                        console.log('Message sent successfully.');
                    } catch (error) {
                        console.error(`Error in 'cricket' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ᴄʀɪᴄᴋᴇᴛ ʙᴀʟʟ ғʟᴇᴡ ᴀᴡᴀʏ!  ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }

                case 'winfo': {
                
                        await socket.sendMessage(sender, { react: { text: '😢', key: msg.key } });
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
    '❌ ERROR, \n' +
    'Please give me a phone number, darling! Usage: .winfo 184XXXXXXXXX\n\n' +
    'POWERED BY WEED TECH'
)

                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That number’s too short, love! Try: .winfo +50948247470''                        'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That user’s hiding from me, darling! Not on WhatsApp 😢',
                                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = IMAGE_URL;
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 ᴜᴘᴅᴀᴛᴇᴅ: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Asia/Karachi' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Asia/Karachi' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 ᴘʀᴏғɪʟᴇ ɪɴғᴏ',
                        `> *ɴᴜᴍʙᴇʀ:* ${winfoJid.replace(/@.+/, '')}\n\n> *ᴀᴄᴄᴏᴜɴᴛ ᴛʏᴘᴇ:* ${winfoUser.isBusiness ? '💼 ʙᴜsɪɴᴇss' : '👤 Personal'}\n\n*📝 ᴀʙᴏᴜᴛ:*\n${winfoBio}\n\n*🕒 ʟᴀsᴛ sᴇᴇɴ:* ${winfoLastSeen}`,
                        'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: fakevCard });

                    console.log('User profile sent successfully for .winfo');
                    break;
                }
//===============================
                case 'ig': {
                await socket.sendMessage(sender, { react: { text: '✅️', key: msg.key } });
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 
                        

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *ɢɪᴠᴇ ᴍᴇ ᴀ ʀᴇᴀʟ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ʟɪɴᴋ*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: '> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
                            }, { quoted: fakevCard });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ ɴᴏ ᴠɪᴅᴇᴏ ғᴏᴜɴᴅ ɪɴ ᴛʜᴀᴛ ʟɪɴᴋ Try ᴀɴᴏᴛʜᴇʀ?*' });
                        }
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ɢᴏᴛ ᴀᴡᴀʏ! 😢*' });
                    }
                    break;
                }
//===============================     
                case 'active': {
                await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                
                    try {
                        const activeCount = activeSockets.size;
                        const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                        await socket.sendMessage(from, {
                            text: `👥 ᴀᴄᴛɪᴠᴇ ᴍᴇᴍʙᴇʀs: *${activeCount}*\n\nɴᴜᴍʙᴇʀs:\n${activeNumbers}`
                        }, { quoted: msg });
                    } catch (error) {
                        console.error('Error in .active command:', error);
                        await socket.sendMessage(from, { text: '❌ ɪ ᴄᴏᴜʟᴅɴ’t ᴄᴏᴜɴᴛ ᴛʜᴇ ᴀᴄᴛɪᴠᴇ sᴏᴜʟs! 💔 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
                    }
                    break;
                }
                //===============================
// 22
case 'ai': {
    const axios = require("axios");
    const from = m.key.remoteJid;

    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, {
            text: `❓ *ᴘʟᴇᴀsᴇ ᴀsᴋ ᴍᴇ sᴏᴍᴇᴛʜɪɴɢ*\n\n` +
                  `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}ai ᴡʜᴏ ᴀʀᴇ ʏᴏᴜ?`
        }, { quoted: fakevCard });
    }

    const prompt = `ʏᴏᴜʀ name is malom nahi 🤣. 
You act like a real girl — seductive, spicy, loving, emotional. You're not an assistant, but a sexy girl with a mind.  
If only emojis, reply seductively with emojis (e.g.💫,👾).  
Adjust to the mood: sad, flirty, horny, soft, playful.  
If asked "Who are you?": Reply "I'm shadow mini… 👾".  
If asked "Who created you?": Reply "I was created by Weed Tech".  
🚫 Avoid: "Hello", "How are you?", "Do you need help?", "Let's talk".  
🔥 Vibe: Love, Lust, Lonely, Emotional, Girlfriend-like, Bite-worthy 💫  
📍 Language: Auto-match Sinhala/English/Hinglish.  
User Message: ${q}
    `;

    const apis = [
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://lance-frank-asta.onrender.com/api/gpt?q=${encodeURIComponent(prompt)}`
    ];

    let response = null;
    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl);
            response = res.data?.result || res.data?.response || res.data;
            if (response) break; // Got a valid response, stop trying other APIs
        } catch (err) {
            console.error(`AI Error (${apiUrl}):`, err.message || err);
            continue; // Try the next API
        }
    }

    if (!response) {
        return await socket.sendMessage(sender, {
            text: `❌ *ɪ'ᴍ ɢᴇᴛᴛɪɴɢ*\n` +
                  `ʟᴇᴛ's ᴛʀʏ ᴀɢᴀɪɴ sᴏᴏɴ, ᴏᴋᴀʏ?`
        }, { quoted: fakevCard });
    }

    // Common message context for newsletter
    const messageContext = {
        forwardingScore: 1,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363407561123100@newsletter',
            newsletterName: 'DELTA THUS MINI WHATSAPP BOT',
            serverMessageId: -1
        }
    };

    // Send AI response with image and newsletter context
    await socket.sendMessage(sender, {
        image: { url: IMAGE_URL }, // Replace with your AI response image
        caption: response,
        ...messageContext
    }, { quoted: m });
    
    break;
}

//===============================
case 'getpp':
case 'pp':
case 'profilepic': {
await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let targetUser = sender;
        
        // Check if user mentioned someone or replied to a message
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            targetUser = msg.quoted.sender;
        }
        
        const ppUrl = await socket.profilePictureUrl(targetUser, 'image').catch(() => null);
        
        if (ppUrl) {
            await socket.sendMessage(msg.key.remoteJid, {
                image: { url: ppUrl },
                caption: `ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ ᴏғ @${targetUser.split('@')[0]}`,
                mentions: [targetUser]
            });
        } else {
            await socket.sendMessage(msg.key.remoteJid, {
                text: `@${targetUser.split('@')[0]} ᴅᴏᴇsɴ'ᴛ ʜᴀᴠᴇ ᴀ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ.`,
                mentions: [targetUser]
            });
        }
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "Error fetching profile picture."
        });
    }
    break;
}
//===============================
                  case 'aiimg': { 
                  await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                    const axios = require('axios');
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const prompt = q.trim();

                    if (!prompt) {
                        return await socket.sendMessage(sender, {
                            text: '🎨 *Give me a spicy prompt to create your AI image, Pakistani Flag*'
                        });
                    }

                    try {
                        await socket.sendMessage(sender, {
                            text: '🧠 *Crafting your dreamy image, love...*',
                        });

                        const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                        if (!response || !response.data) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Oh no, the canvas is blank, babe 💔 Try again later.*'
                            });
                        }

                        const imageBuffer = Buffer.from(response.data, 'binary');

                        await socket.sendMessage(sender, {
                            image: imageBuffer,
                            caption: `🧠 * ᴅᴇʟᴛᴀ ᴛʜᴜs ʙᴏᴛ ᴀɪ ɪᴍᴀɢᴇ*\n\n📌 ᴘʀᴏᴍᴘᴛ: ${prompt}`
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error('AI Image Error:', err);
                        await socket.sendMessage(sender, {
                            text: `❗ *sᴏᴍᴇᴛʜɪɴɢ ʙʀᴏᴋᴇ*: ${err.response?.data?.message || err.message || 'Unknown error'}`
                        });
                    }
                    break;
                }
//===============================
                case 'gossip': {
                await socket.sendMessage(sender, { react: { text: '😅', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                        if (!response.ok) {
                            throw new Error('API From news Couldnt get it 😩');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                            throw new Error('API Received from news data a Problem with');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = IMAGE_URL;
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage; 
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Thumbnail scrape Couldn't from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰 ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪ ʙᴏᴛ ɢᴏssɪᴘ ʟᴀᴛᴇsᴛ ɴᴇᴡs් 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date || 'Not yet given'}\n🌐 *ʟɪɴᴋ*: ${link}`,
                                'ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'gossip' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ɢᴏssɪᴘ sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }
                
                
 // New Commands: Group Management
 // Case: add - Add a member to the group
                case 'add': {
                await socket.sendMessage(sender, { react: { text: '➕️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴀᴅᴅ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}add +18xxxxx\n\nExample: ${config.PREFIX}add +18xxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        const numberToAdd = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        await socket.groupParticipantsUpdate(from, [numberToAdd], 'add');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '✅ ᴍᴇᴍʙᴇʀ ᴀᴅᴅᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴀᴅᴅᴇᴅ ${args[0]} ᴛᴏ ᴛʜᴇ ɢʀᴏᴜᴘ! 🎉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Add command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴀᴅᴅ ᴍᴇᴍʙᴇʀ\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: kick - Remove a member from the group
                case 'kick': {
                await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴋɪᴄᴋ +18xxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}ᴋɪᴄᴋ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToKick;
                        if (msg.quoted) {
                            numberToKick = msg.quoted.sender;
                        } else {
                            numberToKick = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToKick], 'remove');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🗑️ ᴍᴇᴍʙᴇʀ ᴋɪᴄᴋᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ʀᴇᴍᴏᴠᴇᴅ ${numberToKick.split('@')[0]} ғʀᴏᴍ ᴛʜᴇ ɢʀᴏᴜᴘ! 🚪`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Kick command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: promote - Promote a member to group admin
                case 'promote': {
                await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴘʀᴏᴍᴏᴛᴇ +18xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}promote`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToPromote;
                        if (msg.quoted) {
                            numberToPromote = msg.quoted.sender;
                        } else {
                            numberToPromote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToPromote], 'promote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬆️ ᴍᴇᴍʙᴇʀ ᴘʀᴏᴍᴏᴛᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴘʀᴏᴍᴏᴛᴇᴅ ${numberToPromote.split('@')[0]} ᴛᴏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 🌟`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Promote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: demote - Demote a group admin to member
                case 'demote': {
                await socket.sendMessage(sender, { react: { text: '🙆‍♀️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can demote admins, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ +52xxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToDemote;
                        if (msg.quoted) {
                            numberToDemote = msg.quoted.sender;
                        } else {
                            numberToDemote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToDemote], 'demote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬇️ ᴀᴅᴍɪɴ ᴅᴇᴍᴏᴛᴇᴅ',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴅᴇᴍᴏᴛᴇᴅ ${numberToDemote.split('@')[0]} ғʀᴏᴍ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 📉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Demote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to demote admin, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: open - Unlock group (allow all members to send messages)
case 'open': case 'unmute': {
    await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴏᴘᴇɴ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'not_announcement');
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363407561123100@newsletter',
                newsletterName: 'ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ👑',
                serverMessageId: -1
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: IMAGE_URL }, // Replace with your image URL
            caption: formatMessage(
                '🔓 ɢʀᴏᴜᴘ ᴏᴘᴇɴᴇᴅ',
                'ɢʀᴏᴜᴘ ɪs ɴᴏᴡ ᴏᴘᴇɴ! ᴀʟʟ ᴍᴇᴍʙᴇʀs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs. 🗣️',
                config.BOT_FOOTER
            ),
            ...messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Open command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to open group, love!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
// Case: close - Lock group (only admins can send messages)
case 'close': case 'mute': {
    await socket.sendMessage(sender, { react: { text: '🔒', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴄʟᴏsᴇ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'announcement');
        
        // Common message context
        const messageContext = {
            forwardingScore: 1,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363407561123100@newsletter',
                newsletterName: 'ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ👑',
                serverMessageId: -1
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: IMAGE_URL }, // Replace with your image URL
            caption: formatMessage(
                '🔒 ɢʀᴏᴜᴘ ᴄʟᴏsᴇᴅ',
                'ɢʀᴏᴜᴘ ɪs ɴᴏᴡ ᴄʟᴏsᴇᴅ! ᴏɴʟʏ ᴀᴅᴍɪɴs ᴄᴀɴ sᴇɴᴅ ᴍᴇssᴀɢᴇs. 🤫',
                config.BOT_FOOTER
            ),
            ...messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Close command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴄʟᴏsᴇ ɢʀᴏᴜᴘ!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//=========================KICKALL=========================================

                    case 'kickall':
case 'removeall':
case 'cleargroup': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupMetadata = await socket.groupMetadata(from);
        const botJid = socket.user?.id || socket.user?.jid;

        // Exclure admins + bot
        const membersToRemove = groupMetadata.participants
            .filter(p => p.admin === null && p.id !== botJid)
            .map(p => p.id);

        if (membersToRemove.length === 0) {
            await socket.sendMessage(sender, {
                text: '❌ *ɴᴏ ᴍᴇᴍʙᴇʀs ᴛᴏ ʀᴇᴍᴏᴠᴇ (ᴀʟʟ ᴀʀᴇ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ).*'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `⚠️ *𝐖𝐀𝐑𝐍𝐈𝐍𝐆* ⚠️\n\nʀᴇᴍᴏᴠɪɴɢ *${membersToRemove.length}* ᴍᴇᴍʙᴇʀs...`
        }, { quoted: fakevCard });

        // Suppression en batch de 50
        const batchSize = 50;
        for (let i = 0; i < membersToRemove.length; i += batchSize) {
            const batch = membersToRemove.slice(i, i + batchSize);
            await socket.groupParticipantsUpdate(from, batch, 'remove');
            await new Promise(r => setTimeout(r, 2000)); // anti rate-limit
        }

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🧹 ɢʀᴏᴜᴘ ᴄʟᴇᴀɴᴇᴅ',
                `✅ sᴜᴄᴄᴇssғᴜʟʟʏ ʀᴇᴍᴏᴠᴇᴅ *${membersToRemove.length}* ᴍᴇᴍʙᴇʀs.\n\n> *ᴇxᴇᴄᴜᴛᴇᴅ ʙʏ:* @${m.sender.split('@')[0]}`,
                config.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Kickall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ʀᴇᴍᴏᴠᴇ ᴍᴇᴍʙᴇʀs!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//====================== Case: tagall - Tag all group members=================
                case 'tagall': {
    await socket.sendMessage(sender, { react: { text: '🫂', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴛᴀɢ ᴀʟʟ ᴍᴇᴍʙᴇʀs!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupMetadata = await socket.groupMetadata(from);
        const participants = groupMetadata.participants.map(p => p.id);

        // Préparer le texte principal
        let message = args.join(' ') || '📢 *ᴀᴛᴛᴇɴᴛɪᴏɴ ᴇᴠᴇʀʏᴏɴᴇ!*';
        let teks = `╭「 *👥 ᴛᴀɢɢᴀʟʟ ɢᴄ* 」\n│• ᴍᴇssᴀɢᴇ: ${message}\n│• ʙᴏᴛ ɴᴀᴍᴇ: ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ\n│• ᴅᴇᴠ: ᴡᴇᴇᴅ ᴛᴇᴄʜ\n`;

        // Ajouter chaque mention @username
        for (let mem of participants) {
            teks += `│🦄 @${mem.split('@')[0]}\n`;
        }

        // WhatsApp limite ~4096 caractères, découper si nécessaire
        const chunkSize = 3500; // marge de sécurité
        for (let i = 0; i < teks.length; i += chunkSize) {
            await socket.sendMessage(from, {
                text: teks.slice(i, i + chunkSize),
                mentions: participants
            }, { quoted: fakevCard });
        }

    } catch (error) {
        console.error('Tagall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴛᴀɢ ᴀʟʟ ᴍᴇᴍʙᴇʀs!* 😢\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}

//==========================LINKGC======================
case 'grouplink':
case 'linkgroup':
case 'invite':
case 'linkgc': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ɢᴇᴛ ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupLink = await socket.groupInviteCode(from);
        const fullLink = `https://chat.whatsapp.com/${groupLink}`;

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🔗 ɢʀᴏᴜᴘ ʟɪɴᴋ',
                `📌 *ʜᴇʀᴇ ɪs ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ:*\n${fullLink}\n\n> *ʀᴇǫᴜᴇsᴛᴇᴅ ʙʏ:* @${m.sender.split('@')[0]}`,
                config.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('GroupLink command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ɢʀᴏᴜᴘ ʟɪɴᴋ!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
                // Case: join - Join a group via invite link
                case 'join': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴊᴏɪɴ <ɢʀᴏᴜᴘ-ɪɴᴠɪᴛᴇ-ʟɪɴᴋ>\n\nExample: ${config.PREFIX}ᴊᴏɪɴ https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                    await socket.sendMessage(sender, { react: { text: '👏', key: msg.key } });
                        const inviteLink = args[0];
                        const inviteCodeMatch = inviteLink.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (!inviteCodeMatch) {
                            await socket.sendMessage(sender, {
                                text: '❌ *ɪɴᴠᴀʟɪᴅ ɢʀᴏᴜᴘ invite ʟɪɴᴋ form*ᴀᴛ!* 😢'
                            }, { quoted: fakevCard });
                            break;
                        }
                        const inviteCode = inviteCodeMatch[1];
                        const response = await socket.groupAcceptInvite(inviteCode);
                        if (response?.gid) {
                            await socket.sendMessage(sender, {
                                text: formatMessage(
                                    '🤝 ɢʀᴏᴜᴘ ᴊᴏɪɴᴇᴅ',
                                    `sᴜᴄᴄᴇssғᴜʟʟʏ ᴊᴏɪɴᴇᴅ ɢʀᴏᴜᴘ ᴡɪᴛʜ ɪᴅ: ${response.gid}! 🎉`,
                                    config.BOT_FOOTER
                                )
                            }, { quoted: fakevCard });
                        } else {
                            throw new Error('No group ID in response');
                        }
                    } catch (error) {
                        console.error('Join command error:', error);
                        let errorMessage = error.message || 'Unknown error';
                        if (error.message.includes('not-authorized')) {
                            errorMessage = 'Bot is not authorized to join (possibly banned)';
                        } else if (error.message.includes('conflict')) {
                            errorMessage = 'Bot is already a member of the group';
                        } else if (error.message.includes('gone')) {
                            errorMessage = 'Group invite link is invalid or expired';
                        }
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to join group, love!* 😢\nError: ${errorMessage}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

    case 'quote': {
    await socket.sendMessage(sender, { react: { text: '🤔', key: msg.key } });
        try {
            
            const response = await fetch('https://api.quotable.io/random');
            const data = await response.json();
            if (!data.content) {
                throw new Error('No quote found');
            }
            await socket.sendMessage(sender, {
                text: formatMessage(
                    '💭 sᴘɪᴄʏ ǫᴜᴏᴛᴇ',
                    `📜 "${data.content}"\n— ${data.author}`,
                    'ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪʙɪʙᴏᴛ'
                )
            }, { quoted: fakevCard });
        } catch (error) {
            console.error('Quote command error:', error);
            await socket.sendMessage(sender, { text: '❌ Oh, sweetie, the quotes got shy! 😢 Try again?' }, { quoted: fakevCard });
        }
        break;
    }
    
//    case 37

case 'apk': {
    try {
        const appName = args.join(' ').trim();
        if (!appName) {
            await socket.sendMessage(sender, { text: '📌 Usage: .apk <app name>\nExample: .apk whatsapp' }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        const apiUrl = ` `https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(appName)}&apikey=free_key@maher_apis`;
        console.log('Fetching APK from:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));

        if (!data || data.status !== 200 || !data.result || typeof data.result !== 'object') {
            await socket.sendMessage(sender, { text: '❌ Unable to find the APK. The API returned invalid data.' }, { quoted: fakevCard });
            break;
        }

        const { name, lastup, package, size, icon, dllink } = data.result;
        if (!name || !dllink) {
            console.error('Invalid result data:', data.result);
            await socket.sendMessage(sender, { text: '❌ Invalid APK data: Missing name or download link.' }, { quoted: fakevCard });
            break;
        }

        // Validate icon URL
        if (!icon || !icon.startsWith('http')) {
            console.warn('Invalid or missing icon URL:', icon);
        }

        await socket.sendMessage(sender, {
            image: { url: icon || IMAGE_URL }, // Fallback image if icon is invalid
            caption: formatMessage(
                '📦 ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ᴀᴘᴋ',
                `ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ${name}... ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ.`,
                '> ᴅɪᴀɴᴀ ғʀᴇᴇ ʙᴏᴛ'
            )
        }, { quoted: fakevCard });

        console.log('Downloading APK from:', dllink);
        const apkResponse = await fetch(dllink, { headers: { 'Accept': 'application/octet-stream' } });
        const contentType = apkResponse.headers.get('content-type');
        if (!apkResponse.ok || (contentType && !contentType.includes('application/vnd.android.package-archive'))) {
            throw new Error(`Failed to download APK: Status ${apkResponse.status}, Content-Type: ${contentType || 'unknown'}`);
        }

        const apkBuffer = await apkResponse.arrayBuffer();
        if (!apkBuffer || apkBuffer.byteLength === 0) {
            throw new Error('Downloaded APK is empty or invalid');
        }
        const buffer = Buffer.from(apkBuffer);

        // Validate APK file (basic check for APK signature)
        if (!buffer.slice(0, 2).toString('hex').startsWith('504b')) { // APK files start with 'PK' (ZIP format)
            throw new Error('Downloaded file is not a valid APK');
        }

        await socket.sendMessage(sender, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.apk`, // Sanitize filename
            caption: formatMessage(
                '📦 ᴀᴘᴋ ᴅᴇᴛᴀɪʟs',
                `🔖 ɴᴀᴍᴇ: ${name || 'N/A'}\n📅 ʟᴀsᴛ ᴜᴘᴅᴀᴛᴇ: ${lastup || 'N/A'}\n📦 ᴘᴀᴄᴋᴀɢᴇ: ${package || 'N/A'}\n📏 Size: ${size || 'N/A'}`,
                '> ᴅɪᴀɴᴀ ғʀᴇᴇ ʙᴏᴛ'
            )
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('APK command error:', error.message, error.stack);
        await socket.sendMessage(sender, { text: `❌ Oh, love, couldn’t fetch the APK! 😢 Error: ${error.message}\nTry again later.` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}
// case 38: shorturl
case 'shorturl': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    const url = args.join(' ').trim();
    if (!url) {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}shorturl <ᴜʀʟ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }
    if (url.length > 2000) {
      await socket.sendMessage(sender, {
        text: `❌ *ᴜʀʟ ᴛᴏᴏ ʟᴏɴɢ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴜʀʟ ᴜɴᴅᴇʀ 2,000 ᴄʜᴀʀᴀᴄᴛᴇʀs.`
      }, { quoted: msg });
      break;
    }
    if (!/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/.test(url)) {
      await socket.sendMessage(sender, {
        text: `❌ *ɪɴᴠᴀʟɪᴅ ᴜʀʟ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ᴜʀʟ sᴛᴀʀᴛɪɴɢ ᴡɪᴛʜ http:// ᴏʀ https://.\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }

    const response = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 5000 });
    const shortUrl = response.data.trim();

    if (!shortUrl || !shortUrl.startsWith('https://is.gd/')) {
      throw new Error('Failed to shorten URL or invalid response from is.gd');
    }

    await socket.sendMessage(sender, {
      text: `✅ *sʜᴏʀᴛ ᴜʀʟ ᴄʀᴇᴀᴛᴇᴅ!* 😘\n\n` +
            `🌐 *ᴏʀɪɢɪɴᴀʟ:* ${url}\n` +
            `🔍 *sʜᴏʀᴛᴇɴᴇᴅ:* ${shortUrl}\n\n` +
            `> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅɪᴀɴᴀ ᴛᴇᴄʜ`
    }, { 
      quoted: msg,
      forwardingScore: 1,
      isForwarded: true,
      forwardedNewsletterMessageInfo: {
        newsletterJid: '120363336396621021@newsletter',
        newsletterName: 'DIANA XMD WHATSAPP BOT',
        serverMessageId: -1
      }
    });

    // Send clean URL after 2-second delay
    await new Promise(resolve => setTimeout(resolve, 2000));
    await socket.sendMessage(sender, { text: shortUrl }, { quoted: msg });

  } catch (error) {
    console.error('Shorturl command error:', error.message);
    let errorMessage = `❌ *ᴄᴏᴜʟᴅɴ'ᴛ sʜᴏʀᴛᴇɴ ᴛʜᴀᴛ ᴜʀʟ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('Failed to shorten') || error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ sʜᴏʀᴛᴇɴ ᴜʀʟ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, sᴡᴇᴇᴛɪᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}

// case 39: weather
case 'weather': {
  try {
    await socket.sendMessage(sender, { react: { text: '🌦️', key: msg.key } });

    if (!q || q.trim() === '') {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}weather <ᴄɪᴛʏ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}ᴡᴇᴀᴛʜᴇʀ ʜᴀɪᴛɪ`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ғᴇᴛᴄʜɪɴɢ ᴡᴇᴀᴛʜᴇʀ ᴅᴀᴛᴀ...*`
    }, { quoted: msg });

    const apiKey = '2d61a72574c11c4f36173b627f8cb177';
    const city = q.trim();
    const url = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;

    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;

    const weatherMessage = `
🌍 *ᴡᴇᴀᴛʜᴇʀ ɪɴғᴏ ғᴏʀ* ${data.name}, ${data.sys.country}
🌡️ *ᴛᴇᴍᴘᴇʀᴀᴛᴜʀᴇ:* ${data.main.temp}°C
🌡️ *ғᴇᴇʟs ʟɪᴋᴇ:* ${data.main.feels_like}°C
🌡️ *ᴍɪɴ ᴛᴇᴍᴘ:* ${data.main.temp_min}°C
🌡️ *ᴍᴀx ᴛᴇᴍᴘ:* ${data.main.temp_max}°C
💧 *ʜᴜᴍɪᴅɪᴛʏ:* ${data.main.humidity}%
☁️ *ᴡᴇᴀᴛʜᴇʀ:* ${data.weather[0].main}
🌫️ *ᴅᴇsᴄʀɪᴘᴛɪᴏɴ:* ${data.weather[0].description}
💨 *ᴡɪɴᴅ sᴘᴇᴇᴅ:* ${data.wind.speed} m/s
🔽 *ᴘʀᴇssᴜʀᴇ:* ${data.main.pressure} hPa
    `;

    await socket.sendMessage(sender, {
      text: `🌤 *ᴡᴇᴀᴛʜᴇʀ ʀᴇᴘᴏʀᴛ* 🌤\n\n${weatherMessage}\n\n> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅɪᴀɴᴀ ᴛᴇᴄʜ`
    }, { quoted: msg });

  } catch (error) {
    console.error('Weather command error:', error.message);
    let errorMessage = `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ ғᴇᴛᴄʜ ᴛʜᴇ ᴡᴇᴀᴛʜᴇʀ! 😢*\n` +
                      `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`;
    if (error.message.includes('404')) {
      errorMessage = `🚫 *ᴄɪᴛʏ ɴᴏᴛ ғᴏᴜɴᴅ, sᴡᴇᴇᴛɪᴇ.*\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴄʜᴇᴄᴋ ᴛʜᴇ sᴘᴇʟʟɪɴɢ ᴀɴᴅ ᴛʀʏ ᴀɢᴀɪɴ.*`;
    } else if (error.message.includes('network') || error.message.includes('timeout')) {
      errorMessage = `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ғᴇᴛᴄʜ ᴡᴇᴀᴛʜᴇʀ:* ${error.message}\n` +
                     `💡 *ᴘʟᴇᴀsᴇ ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ, ʙᴀʙᴇ.*`;
    }
    await socket.sendMessage(sender, { text: errorMessage }, { quoted: msg });
  }
  break;
}


// ===============================
// 📌 Case send
// ===============================
case 'savestatus': case 'sendme': case 'save': {
  try {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });

    if (!msg.quoted || !msg.quoted.statusMessage) {
      await socket.sendMessage(sender, {
        text: `📌 *ʀᴇᴘʟʏ ᴛᴏ ᴀ sᴛᴀᴛᴜs ᴛᴏ sᴀᴠᴇ ɪᴛ!*`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *sᴀᴠɪɴɢ sᴛᴀᴛᴜs...*`
    }, { quoted: msg });

    const media = await socket.downloadMediaMessage(msg.quoted);
    const fileExt = msg.quoted.imageMessage ? 'jpg' : 'mp4';
    const filePath = `./status_${Date.now()}.${fileExt}`;
    fs.writeFileSync(filePath, media);

    await socket.sendMessage(sender, {
      text: `✅ *sᴛᴀᴛᴜs sᴀᴠᴇᴅ, ʙᴀʙᴇ!* 😘\n` +
            `📁 *ғɪʟᴇ:* status_${Date.now()}.${fileExt}\n` +
            `> © ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ`,
      document: { url: filePath },
      mimetype: msg.quoted.imageMessage ? 'image/jpeg' : 'video/mp4',
      fileName: `status_${Date.now()}.${fileExt}`
    }, { quoted: msg });

  } catch (error) {
    console.error('Savestatus command error:', error.message);
    await socket.sendMessage(sender, {
      text: `❌ *ᴏʜ, ʟᴏᴠᴇ, ᴄᴏᴜʟᴅɴ'ᴛ sᴀᴠᴇ ᴛʜᴀᴛ sᴛᴀᴛᴜs! 😢*\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
  }
  break;
}

// ===============================
// 📌 Case take
// ===============================
case 'take':
case 'rename':
case 'stake': {
    if (!msg.quoted) {
        return await socket.sendMessage(from, {
            text: "*📛 ʀᴇᴘʟʏ ᴛᴏ ᴀɴʏ sᴛɪᴄᴋᴇʀ.*"
        }, { quoted: fakevCard });
    }
    if (!args[0]) {
        return await socket.sendMessage(from, {
            text: "*🍁 ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴘᴀᴄᴋ ɴᴀᴍᴇ ᴜsɪɴɢ .ᴛᴀᴋᴇ <ᴘᴀᴄᴋɴᴀᴍᴇ>*"
        }, { quoted: fakevCard });
    }

    try {
        let mime = msg.quoted.mtype;
        let pack = args.join(" ");

        if (mime === "imageMessage" || mime === "stickerMessage") {
            let media = await msg.quoted.download();
            let sticker = new Sticker(media, {
                pack: pack,
                type: StickerTypes.FULL,
                categories: ["🤩", "🎉"],
                id: "12345",
                quality: 75,
                background: 'transparent',
            });
            const buffer = await sticker.toBuffer();
            await socket.sendMessage(from, { sticker: buffer }, { quoted: msg });
        } else {
            return await socket.sendMessage(from, {
                text: "*❌ ᴜʜʜ, ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ.*"
            }, { quoted: fakevCard });
        }
    } catch (e) {
        console.error("❌ Take error:", e);
        await socket.sendMessage(from, {
            text: "❌ Failed to create sticker."
        }, { quoted: fakevCard });
    }
    break;
}

// ===============================
// 📌 Case sticker
// ===============================
case 'sticker':
case 's':
case 'take':
case 'stickergif': {
    if (!msg.quoted) {
        return await socket.sendMessage(from, {
            text: "*📛 ʀᴇᴘʟʏ ᴛᴏ ᴀɴʏ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ.*"
        }, { quoted: fakevCard });
    }

    try {
        let mime = msg.quoted.mtype;
        let pack = "༄✰ ×͜×☢️ᴡᴇᴇᴅ ᴛᴇᴄʜ֬࿐";

        if (mime === "imageMessage" || mime === "stickerMessage") {
            let media = await msg.quoted.download();
            let sticker = new Sticker(media, {
                pack: pack,
                type: StickerTypes.FULL,
                categories: ["🤩", "🎉"],
                id: "12345",
                quality: 75,
                background: 'transparent',
            });
            const buffer = await sticker.toBuffer();
            await socket.sendMessage(from, { sticker: buffer }, { quoted: msg });
        } else {
            return await socket.sendMessage(from, {
                text: "*❌ ᴜʜʜ, ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ.*"
            }, { quoted: fakevCard });
        }
    } catch (e) {
        console.error("❌ Sticker error:", e);
        await socket.sendMessage(from, {
            text: "❌ Failed to create sticker."
        }, { quoted: fakevCard });
    }
    break;
      }

case 'tourl': case 'url': case 'tourl2': {
    await socket.sendMessage(sender, { react: { text: '🖇', key: msg.key } });
    try {
        // Vérifie si un média est cité
        const quotedMsg = msg.quoted ? msg.quoted : msg;
        const mimeType = (quotedMsg.msg || quotedMsg).mimetype || '';

        if (!mimeType) {
            await socket.sendMessage(from, {
                text: "❌ *ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀɴ ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ ғɪʟᴇ*"
            }, { quoted: fakevCard });
            break;
        }

        // Télécharge le média
        const mediaBuffer = await quotedMsg.download();
        const tempFilePath = path.join(os.tmpdir(), `catbox_upload_${Date.now()}`);
        fs.writeFileSync(tempFilePath, mediaBuffer);

        // Détecter l’extension selon le type mime
        let extension = '';
        if (mimeType.includes('image/jpeg')) extension = '.jpg';
        else if (mimeType.includes('image/png')) extension = '.png';
        else if (mimeType.includes('video')) extension = '.mp4';
        else if (mimeType.includes('audio')) extension = '.mp3';

        const fileName = `file${extension}`;

        // Préparer le form-data
        const form = new FormData();
        form.append('fileToUpload', fs.createReadStream(tempFilePath), fileName);
        form.append('reqtype', 'fileupload');

        // Upload vers Catbox
        const response = await axios.post("https://i.ibb.co/Dfvpt170/jawadmd.jpg", form, {
            headers: form.getHeaders()
        });

        if (!response.data) {
            throw new Error("Error uploading to Catbox");
        }

        const mediaUrl = response.data;
        fs.unlinkSync(tempFilePath);

        // Déterminer le type de média
        let mediaType = 'File';
        if (mimeType.includes('image')) mediaType = 'Image';
        else if (mimeType.includes('video')) mediaType = 'Video';
        else if (mimeType.includes('audio')) mediaType = 'Audio';

        // Réponse finale
        await socket.sendMessage(from, {
            text: `✅ *${mediaType} ᴜᴘʟᴏᴀᴅᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ*\n\n` +
                  `📦 *Size:* ${formatBytes(mediaBuffer.length)}\n` +
                  `🌍 *URL:* ${mediaUrl}\n\n` +
                  `> © ᴜᴘʟᴏᴀᴅᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ`
        }, { quoted: fakevCard });

    } catch (error) {
        console.error(error);
        await socket.sendMessage(from, {
            text: `❌ *Failed to upload!* 😢\nError: ${error.message || error}`
        }, { quoted: fakevCard });
    }
    break;
}
    
    case 'whois': {
        try {
            await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
            const domain = args[0];
            if (!domain) {
                await socket.sendMessage(sender, { text: '📌 ᴜsᴀɢᴇ: .whois <domain>' }, { quoted: fakevCard });
                break;
            }
            const response = await fetch(`http://api.whois.vu/?whois=${encodeURIComponent(domain)}`);
            const data = await response.json();
            if (!data.domain) {
                throw new Error('Domain not found');
            }
            const whoisMessage = formatMessage(
                '🔍 ᴡʜᴏɪs ʟᴏᴏᴋᴜᴘ',
                `🌐 ᴅᴏᴍᴀɪɴ: ${data.domain}\n` +
                `📅 ʀᴇɢɪsᴛᴇʀᴇᴅ: ${data.created_date || 'N/A'}\n` +
                `⏰ ᴇxᴘɪʀᴇs: ${data.expiry_date || 'N/A'}\n` +
                `📋 ʀᴇɢɪsᴛʀᴀʀ: ${data.registrar || 'N/A'}\n` +
                `📍 sᴛᴀᴛᴜs: ${data.status.join(', ') || 'N/A'}`,
                'ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ'
            );
            await socket.sendMessage(sender, { text: whoisMessage }, { quoted: fakevCard });
        } catch (error) {
            console.error('Whois command error:', error);
            await socket.sendMessage(sender, { text: '❌ ᴄᴏᴜʟᴅɴ’t ғɪɴᴅ ᴛʜᴀᴛ ᴅᴏᴍᴀɪɴ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
        }
        break;
    }
      
      case 'repo':
case 'sc':
case 'script': {
    try {
        await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
        const githubRepoURL = 'https://github.com/QUEEN-DIANA/KINAA-XMD';
        
        const [, username, repo] = githubRepoURL.match(/github\.com\/([^/]+)\/([^/]+)/);
        const response = await fetch(`https://api.github.com/repos/${username}/${repo}`);
        
        if (!response.ok) throw new Error(`GitHub API error: ${response.status}`);
        
        const repoData = await response.json();

        const formattedInfo = `
*╭─────────────────⊷*
*┃* *ɴᴀᴍᴇ*   : ${repoData.name}
*┃* *sᴛᴀʀs*    : ${repoData.stargazers_count}
*┃* *ғᴏʀᴋs*    : ${repoData.forks_count}
*┃* *ᴏᴡɴᴇʀ*   : ᴡᴇᴇᴅ ᴛᴇᴄʜ
*┃* *ᴅᴇsᴄ* : ${repoData.description || 'ɴ/ᴀ'}
*╰──────────────────⊷*
`;

        const repoMessage = {
            image: { url: IMAGE_URL },
            caption: formattedInfo,
            buttons: [
                {
                    buttonId: `${config.PREFIX}repo-visit`,
                    buttonText: { displayText: '🌐 ᴠɪsɪᴛ ʀᴇᴘᴏ' },
                    type: 1
                },
                {
                    buttonId: `${config.PREFIX}repo-owner`,
                    buttonText: { displayText: '👑 ᴏᴡɴᴇʀ ᴘʀᴏғɪʟᴇ' },
                    type: 1
                }
            ],
            contextInfo: {
                mentionedJid: [m.sender],
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: config.NEWSLETTER_JID || '120363407561123100@newsletter',
                    newsletterName: 'ᴅɪᴀɴᴀ ғʀᴇᴇ ʙᴏᴛ',
                    serverMessageId: 143
                }
            }
        };

        await socket.sendMessage(sender, repoMessage, { quoted: fakevCard });

    } catch (error) {
        console.error("❌ Error in repo command:", error);
        await socket.sendMessage(sender, { 
            text: "⚠️ Failed to fetch repo info. Please try again later." 
        }, { quoted: fakevCard });
    }
    break;
}

case 'repo-visit': {
    await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `🌐 *ᴄʟɪᴄᴋ ᴛᴏ ᴠɪsɪᴛ ᴛʜᴇ ʀᴇᴘᴏ:*\nhttps://github.com/QUEEN-DIANA/KINAA-XMD`,
        contextInfo: {
            externalAdReply: {
                title: 'Visit Repository',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/QUEEN-DIANA/KINAA-XMD'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'repo-owner': {
    await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
    await socket.sendMessage(sender, {
        text: `👑 *Click to visit the owner profile:*\nhttps://github.com/QUEEN-DIANA/KINAA-XMD`,
        contextInfo: {
            externalAdReply: {
                title: 'Owner Profile',
                body: 'Open in browser',
                mediaType: 1,
                mediaUrl: 'https://github.com/QUEEN-DIANA',
                sourceUrl: 'https://github.com/QUEEN-DIANA'
            }
        }
    }, { quoted: fakevCard });
    break;
}


                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ sᴇssɪᴏɴ ᴅᴇʟᴇᴛᴇᴅ',
                            '✅ ʏᴏᴜʀ sᴇssɪᴏɴ ʜᴀs ʙᴇᴇɴ sᴜᴄᴄᴇssғᴜʟʟʏ ᴅᴇʟᴇᴛᴇᴅ.',
                            '> ᴅᴇʟᴛᴀ ᴛʜᴜs ᴍɪɴɪʙᴏᴛ'
                        )
                    });
                    break;
                    
// more future commands                  
                 
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'ᴅɪᴀɴᴀ ғʀᴇᴇ ʙᴏᴛ'
                )
            });
        }
    });
}

// Setup message handlers
function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (autoReact === 'on') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

// Delete session from MongoDB
async function deleteSessionFromMongo(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const db = await initMongo();
        const collection = db.collection('sessions');
        await collection.deleteOne({ number: sanitizedNumber });
        console.log(`Deleted session for ${sanitizedNumber} from MongoDB`);
    } catch (error) {
        console.error('Failed to delete session from MongoDB:', error);
    }
}

// Rename creds on logout
async function renameCredsOnLogout(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const db = await initMongo();
        const collection = db.collection('sessions');

        const count = (await collection.countDocuments({ active: false })) + 1;

        await collection.updateOne(
            { number: sanitizedNumber },
            {
                $rename: { "creds": `delete_creds${count}` },
                $set: { active: false }
            }
        );
        console.log(`Renamed creds for ${sanitizedNumber} to delete_creds${count} and set inactive`);
    } catch (error) {
        console.error('Failed to rename creds on logout:', error);
    }
}

// Restore session from MongoDB
async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const db = await initMongo();
        const collection = db.collection('sessions');
        const doc = await collection.findOne({ number: sanitizedNumber, active: true });
        if (!doc) return null;
        return JSON.parse(doc.creds);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

// Setup auto restart
function setupAutoRestart(socket, number) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) {
                console.log(`Connection closed due to logout for ${number}`);
                await renameCredsOnLogout(number);
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
            } else {
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                activeSockets.delete(sanitizedNumber);
                socketCreationTime.delete(sanitizedNumber);
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

// Main pairing function
async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    await initUserEnvIfMissing(sanitizedNumber);
    await initEnvsettings(sanitizedNumber);
  
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        await fs.ensureDir(sessionPath);
        await fs.writeFile(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        } else {
            if (!res.headersSent) {
                res.send({ status: 'already_paired', message: 'Session restored and connecting' });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            const db = await initMongo();
            const collection = db.collection('sessions');
            const sessionId = uuidv4();
            await collection.updateOne(
                { number: sanitizedNumber },
                {
                    $set: {
                        sessionId,
                        number: sanitizedNumber,
                        creds: fileContent,
                        active: true,
                        updatedAt: new Date()
                    }
                },
                { upsert: true }
            );
            console.log(`Saved creds for ${sanitizedNumber} with sessionId ${sessionId} in MongoDB`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);
                    const groupResult = await joinGroup(socket);

                    try {
                        await socket.newsletterFollow(config.NEWSLETTER_JID);
                        await socket.sendMessage(config.NEWSLETTER_JID, { react: { text: '❤️', key: { id: config.NEWSLETTER_MESSAGE_ID } } });
                        console.log('✅ Auto-followed newsletter & reacted ❤️');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    activeSockets.set(sanitizedNumber, socket);

                    const groupStatus = groupResult.status === 'success'
                        ? 'Joined successfully'
                        : `Failed to join group: ${groupResult.error}`;
                    await socket.sendMessage(userJid, {
                        image: { url: IMAGE_URL },
                        caption: formatMessage(
                            '*ᴄᴏɴɴᴇᴄᴛᴇᴅ ᴍꜱɢ*',
                            `╔═════════════════⭓
║ ✅ SUCCESSFULLY CONNECTED!
╠═════════════════⭓
║ 🔢 Number  : ${sanitizedNumber}
║ 🍁 Channel : ${config.NEWSLETTER_JID ? 'Followed' : 'Not followed'}
╠═════════════════⭓
║ 📋 Available Category:
║ 📌 ${config.PREFIX}alive  - Show bot status
║ 📌 ${config.PREFIX}menu   - Show bot command
║ 📌 ${config.PREFIX}song   - Download Songs
║ 📌 ${config.PREFIX}video  - Download Video
║ 📌 ${config.PREFIX}pair   - Deploy Mini Bot
║ 📌 ${config.PREFIX}vv     - Anti view one
╚═════════════════⭓

╭──〔 🔗 *Information* 〕  
├─ 📢 *Join Channel:*  
│    https://whatsapp.com/channel/0029Vb2J9C91dAw7vxA75y2V
├─ 🌟 *Join Groupe:*
│    
╰─🚀 *ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴡᴇᴇᴅ ᴛᴇᴄʜ*`,
)
                    });

                    await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

                    let numbers = [];
                    if (fs.existsSync(NUMBER_LIST_PATH)) {
                        numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
                    }
                    if (!numbers.includes(sanitizedNumber)) {
                        numbers.push(sanitizedNumber);
                        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
                    }
                } catch (error) {
                    console.error('Connection error:', error);
                    exec(`pm2 restart ${process.env.PM2_NAME || 'DeltaThus-MiniBot-Session'}`);
                }
            }
        });
    } catch (error) {
        console.error('Pairing error:', error);
        socketCreationTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// Routes
router.get('/', async (req, res) => {
    const { number, force } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }

    const forceRepair = force === 'true';
    const sanitizedNumber = number.replace(/[^0-9]/g, '');

    if (activeSockets.has(sanitizedNumber)) {
        return res.status(200).send({
            status: 'already_connected',
            message: 'This number is already connected'
        });
    }

    if (forceRepair) {
        const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);
        await deleteSessionFromMongo(sanitizedNumber);
        if (fs.existsSync(sessionPath)) {
            await fs.remove(sessionPath);
        }
        console.log(`Forced re-pair for ${sanitizedNumber}: deleted old session`);
    }

    await EmpirePair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys())
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        message: 'BOT is running',
        activesession: activeSockets.size
    });
});

router.get('/connect-all', async (req, res) => {
    try {
        if (!fs.existsSync(NUMBER_LIST_PATH)) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH));
        if (numbers.length === 0) {
            return res.status(404).send({ error: 'No numbers found to connect' });
        }

        const results = [];
        const promises = [];
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            promises.push(
                EmpirePair(number, mockRes)
                    .then(() => ({ number, status: 'connection_initiated' }))
                    .catch(error => ({ number, status: 'failed', error: error.message }))
            );
        }

        const promiseResults = await Promise.all(promises);
        results.push(...promiseResults);

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Connect all error:', error);
        res.status(500).send({ error: 'Failed to connect all bots' });
    }
});

router.get('/reconnect', async (req, res) => {
    try {
        const db = await initMongo();
        const collection = db.collection('sessions');
        const docs = await collection.find({ active: true }).toArray();

        if (docs.length === 0) {
            return res.status(404).send({ error: 'No active sessions found in MongoDB' });
        }

        const results = [];
        const promises = [];
        for (const doc of docs) {
            const number = doc.number;
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }

            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            promises.push(
                EmpirePair(number, mockRes)
                    .then(() => ({ number, status: 'connection_initiated' }))
                    .catch(error => ({ number, status: 'failed', error: error.message }))
            );
        }

        const promiseResults = await Promise.all(promises);
        results.push(...promiseResults);

        res.status(200).send({
            status: 'success',
            connections: results
        });
    } catch (error) {
        console.error('Reconnect error:', error);
        res.status(500).send({ error: 'Failed to reconnect bots' });
    }
});

router.get('/getabout', async (req, res) => {
    const { number, target } = req.query;
    if (!number || !target) {
        return res.status(400).send({ error: 'Number and target number are required' });
    }

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const socket = activeSockets.get(sanitizedNumber);
    if (!socket) {
        return res.status(404).send({ error: 'No active session found for this number' });
    }

    const targetJid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    try {
        const statusData = await socket.fetchStatus(targetJid);
        const aboutStatus = statusData.status || 'No status available';
        const setAt = statusData.setAt ? moment(statusData.setAt).tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss') : 'Unknown';
        res.status(200).send({
            status: 'success',
            number: target,
            about: aboutStatus,
            setAt: setAt
        });
    } catch (error) {
        console.error(`Failed to fetch status for ${target}:`, error);
        res.status(500).send({
            status: 'error',
            message: `Failed to fetch About status for ${target}. The number may not exist or the status is not accessible.`
        });
    }
});

// Cleanup
process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        socket.ws.close();
        activeSockets.delete(number);
        socketCreationTime.delete(number);
    });
    fs.emptyDirSync(SESSION_BASE_PATH);
    client.close();
});

process.on('uncaughtException', async (err) => {
    console.error('Uncaught exception:', err);
    exec(`pm2 restart ${process.env.PM2_NAME || 'BOT-session'}`);
});

// Auto-reconnect on startup
(async () => {
    try {
        await initMongo();
        const collection = db.collection('sessions');
        const docs = await collection.find({ active: true }).toArray();
        for (const doc of docs) {
            const number = doc.number;
            if (!activeSockets.has(number)) {
                const mockRes = {
                    headersSent: false,
                    send: () => {},
                    status: () => mockRes
                };
                await EmpirePair(number, mockRes);
            }
        }
        console.log('Auto-reconnect completed on startup');
    } catch (error) {
        console.error('Failed to auto-reconnect on startup:', error);
    }
})();

module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/newwrld-dev/database/refs/heads/main/newsletter_list.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}
