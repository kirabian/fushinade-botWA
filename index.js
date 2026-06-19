import { makeWASocket, useMultiFileAuthState, DisconnectReason } from 'atexovi-baileys';
import pino from 'pino';
import fs from 'fs';
import path from 'path';
import inquirer from 'inquirer';
import chalk from 'chalk';
import figlet from 'figlet';
import dotenv from 'dotenv';
import moment from 'moment-timezone';
import schedule from 'node-schedule';
import weather from 'weather-js';
import Parser from 'rss-parser';
import sharp from 'sharp';
import Groq from 'groq-sdk';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inisialisasi Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'API_KEY_KOSONG' });
const chatHistories = {};
const groqModels = ["llama-3.3-70b-versatile", "llama3-8b-8192", "mixtral-8x7b-32768"];

async function generateResilientGroqContent(messages, retries = 2) {
    let lastError = null;
    for (const modelName of groqModels) {
        try {
            const completion = await groq.chat.completions.create({
                messages: messages,
                model: modelName,
            });
            return completion.choices[0]?.message?.content || "";
        } catch (error) {
            lastError = error;
            const errorMsg = (error.message || "").toLowerCase();
            const isRateLimit = errorMsg.includes("429") || errorMsg.includes("rate limit");
            
            if (isRateLimit) {
                console.warn(`Model ${modelName} rate limit exceeded, trying next model...`);
                continue;
            }
            if (retries > 0) {
                console.log(`Retrying after error: ${error.message} (${retries} attempts left)`);
                await new Promise(resolve => setTimeout(resolve, 2000));
                return generateResilientGroqContent(messages, retries - 1);
            }
        }
    }
    if (lastError) {
        const lastErrorMsg = (lastError.message || "").toLowerCase();
        if (lastErrorMsg.includes("429") || lastErrorMsg.includes("rate limit")) {
            throw new Error("GROQ_QUOTA_EXCEEDED");
        }
        throw lastError;
    }
    throw new Error("Failed to generate content with all available Groq models.");
}

const authDir = path.join(__dirname, 'session');

let isAskingNumber = false;

function showBanner() {
  const text = figlet.textSync('Fushinade Bot', { font: 'Slant' });
  console.log(chalk.cyanBright(text));
}

async function startBot() {
  showBanner();

  const files = fs.existsSync(authDir) ? fs.readdirSync(authDir).filter(f => f.endsWith('.json')) : [];
  let waNumber;

  if (files.length === 0) {
    try {
      const response = await inquirer.prompt([
        {
          type: 'input',
          name: 'waNumber',
          message: chalk.cyanBright('📱 Masukkan nomor WhatsApp Anda (tanpa tanda +):'),
          validate: (input) => /^\d{8,}$/.test(input) ? true : '⚠️ Nomor tidak valid.',
        },
      ]);
      waNumber = response.waNumber;
    } catch (err) {
      console.log(chalk.red('\n⚠️ Prompt dibatalkan.'));
      process.exit(1);
    }
  }

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  if (waNumber) {
    setTimeout(async () => {
        try {
            const code = await sock.requestPairingCode(waNumber);
            console.log(chalk.greenBright('\n✅ Pairing Code Ditemukan!'));
            console.log(chalk.yellowBright('📌 Kode Anda:'), chalk.bold.magenta(code));
            console.log(chalk.cyan('📱 Buka WhatsApp di HP: Perangkat Tertaut → Tautkan Perangkat → Pilih opsi Tautkan Dengan Nomor Telepon'));
        } catch (err) {
            console.error(chalk.red('\n❌ Error mendapatkan pairing code:'), err.message);
            if (err.message.includes('428') || err.message.includes('Connection Closed')) {
                console.log(chalk.yellow('⚠️ WhatsApp membatasi permintaan kode (Rate Limit). Silakan tunggu 5-10 menit sebelum mencoba lagi.'));
                process.exit(1);
            }
        }
    }, 2000);
  }

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      console.log(chalk.greenBright('✅ Connected to WhatsApp!'));
    } else if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      
      if (reason === 428) {
         console.log(chalk.red('\n❌ Koneksi ditolak oleh WhatsApp (Rate Limit/428). Silakan tunggu 5-10 menit sebelum mencoba lagi.'));
         process.exit(1);
      }

      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        console.log(chalk.yellow('🔁 Connection lost. Reconnecting...'));
        startBot();
      } else {
        console.log(chalk.red('❌ Sesi tidak valid / Ter-logout. Menghapus sesi lama...'));
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch(e) {}
        console.log(chalk.green('✅ Sesi lama dihapus. Silakan jalankan ulang bot.'));
        process.exit(1);
      }
    }
  });

  sock.ev.on('creds.update', saveCreds);
  
  sock.ev.on('messages.upsert', async m => {
    const msg = m.messages?.[0];
    if (!msg || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || msg.message?.imageMessage?.caption || "";
    const text = body.trim();
    
    // Check if the message is a button response
    let rowId;
    try {
      if (msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage) {
        rowId = JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson).id;
      } else if (msg.message?.listResponseMessage?.singleSelectReply?.selectedRowId) {
        rowId = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
      } else if (msg.message?.buttonsResponseMessage?.selectedButtonId) {
        rowId = msg.message.buttonsResponseMessage.selectedButtonId;
      }
    } catch {}

    const command = rowId ? rowId : text;

    if (command === '.ping') {
        await sock.sendMessage(from, { text: 'pong! Bot is aktif dan merespon.' }, { quoted: msg });
        return;
    }

    if (command === '.menu') {
        const menuText = `*🤖 FUSHINADE BOT MENU 🤖*\n\n` +
            `*1. 🤖 AI & Chatbot*\n` +
            `   ➔ .ai <pertanyaan>\n` +
            `   ➔ .ask <pertanyaan>\n\n` +
            `*2. 🛠️ Utilities*\n` +
            `   ➔ .ping\n` +
            `   ➔ .schedule <no> <jam> <pesan>\n\n` +
            `*3. 📝 Catatan (To-Do)*\n` +
            `   ➔ .catat <isi catatan>\n` +
            `   ➔ .catatan (Lihat list)\n` +
            `   ➔ .hapuscatatan <nomor>\n\n` +
            `*4. 🌐 Info & Berita*\n` +
            `   ➔ .cuaca <kota>\n` +
            `   ➔ .berita\n`;

        await sock.sendMessage(from, {
            text: menuText,
            interactiveButtons: [
              {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                  display_text: 'Ping Bot',
                  id: '.ping'
                })
              },
              {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                  display_text: 'Berita Terkini',
                  id: '.berita'
                })
              },
              {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({
                  display_text: 'Lihat Catatan',
                  id: '.catatan'
                })
              }
            ]
        });
        return;
    }

    if (command.startsWith('.ai ') || command.startsWith('.ask ')) {
        const prompt = command.replace(/^\.(ai|ask)\s+/, '');
        const senderId = from;

        if (!chatHistories[senderId]) {
            const currentDate = moment().tz('Asia/Jakarta').format('DD MMMM YYYY');
            chatHistories[senderId] = [
                { role: "system", content: `Kamu adalah asisten AI dari WhatsApp Bot yang cerdas, ramah, dan asyik diajak ngobrol. Selalu gunakan Bahasa Indonesia yang natural, santai namun sopan. Sebagai informasi tambahan: Hari ini adalah tanggal ${currentDate}. Presiden Republik Indonesia saat ini adalah Prabowo Subianto (periode 2024-2029) dengan Wakil Presiden Gibran Rakabuming Raka.` }
            ];
        }

        chatHistories[senderId].push({ role: "user", content: prompt });
        if (chatHistories[senderId].length > 10) chatHistories[senderId].splice(1, 1);

        try {
            const responseText = await generateResilientGroqContent(chatHistories[senderId]);
            chatHistories[senderId].push({ role: "assistant", content: responseText });
            if (chatHistories[senderId].length > 10) chatHistories[senderId].splice(1, 1);
            await sock.sendMessage(from, { text: responseText }, { quoted: msg });
        } catch (error) {
            chatHistories[senderId].pop();
            console.error(error);
            if (error.message === "GROQ_QUOTA_EXCEEDED") {
                await sock.sendMessage(from, { text: 'Maaf, kuota API Groq (Limit Rate) Anda sedang habis. Silakan coba beberapa saat lagi.' });
            } else {
                await sock.sendMessage(from, { text: 'Maaf, AI sedang mengalami gangguan / tidak ada model yang tersedia.' });
            }
        }
        return;
    }

    // Catatan
    if (command.startsWith('.catat ')) {
        const item = command.replace('.catat ', '').trim();
        let todos = {};
        if (fs.existsSync('./todos.json')) todos = JSON.parse(fs.readFileSync('./todos.json'));
        if (!todos[from]) todos[from] = [];
        todos[from].push(item);
        fs.writeFileSync('./todos.json', JSON.stringify(todos, null, 2));
        await sock.sendMessage(from, { text: `Catatan ditambahkan! Ketik .catatan untuk melihat list.` }, { quoted: msg });
        return;
    }

    if (command === '.catatan') {
        let todos = {};
        if (fs.existsSync('./todos.json')) todos = JSON.parse(fs.readFileSync('./todos.json'));
        if (!todos[from] || todos[from].length === 0) {
            await sock.sendMessage(from, { text: 'Kamu tidak punya catatan.' }, { quoted: msg });
            return;
        }
        let replyTxt = '*Daftar Catatanmu:*\n';
        todos[from].forEach((item, index) => { replyTxt += `${index + 1}. ${item}\n`; });
        replyTxt += '\n_(Ketik .hapuscatatan <nomor> untuk menghapus)_';
        await sock.sendMessage(from, { text: replyTxt }, { quoted: msg });
        return;
    }

    if (command.startsWith('.hapuscatatan ')) {
        const idx = parseInt(command.replace('.hapuscatatan ', '').trim()) - 1;
        let todos = {};
        if (fs.existsSync('./todos.json')) todos = JSON.parse(fs.readFileSync('./todos.json'));
        if (!todos[from] || todos[from].length === 0 || isNaN(idx) || idx < 0 || idx >= todos[from].length) {
            await sock.sendMessage(from, { text: 'Nomor catatan tidak valid.' }, { quoted: msg });
            return;
        }
        const removed = todos[from].splice(idx, 1);
        fs.writeFileSync('./todos.json', JSON.stringify(todos, null, 2));
        await sock.sendMessage(from, { text: `Catatan "${removed}" berhasil dihapus.` }, { quoted: msg });
        return;
    }

    if (command.startsWith('.cuaca ')) {
        const city = command.replace('.cuaca ', '').trim();
        weather.find({search: city, degreeType: 'C'}, async function(err, result) {
            if(err || result.length === 0) {
                await sock.sendMessage(from, { text: 'Maaf, kota tidak ditemukan.' });
                return;
            }
            const current = result[0].current;
            await sock.sendMessage(from, { text: `*Cuaca di ${current.observationpoint}*\nSuhu: ${current.temperature}°C\nKondisi: ${current.skytext}\nKelembapan: ${current.humidity}%` });
        });
        return;
    }

    if (command === '.berita') {
        try {
            const rssParser = new Parser();
            const feed = await rssParser.parseURL('https://www.antaranews.com/rss/terkini.xml');
            let replyTxt = '*Berita Terkini (Antara News):*\n\n';
            for (let i = 0; i < 5 && i < feed.items.length; i++) {
                replyTxt += `📰 *${feed.items[i].title}*\n${feed.items[i].link}\n\n`;
            }
            await sock.sendMessage(from, { text: replyTxt });
        } catch (error) {
            console.error(error);
            await sock.sendMessage(from, { text: 'Maaf, gagal mengambil berita.' });
        }
        return;
    }

    // Downloader
    if (command.startsWith('.tiktok ') || command.startsWith('.ig ') || command.startsWith('.yt ')) {
        await sock.sendMessage(from, { text: '⏳ Fitur downloader membutuhkan API khusus yang belum dikonfigurasi.' }, { quoted: msg });
        return;
    }

  });
}

startBot();
