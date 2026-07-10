import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;
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
import qrcode from 'qrcode-terminal';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inisialisasi Groq
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'API_KEY_KOSONG' });
const chatHistories = {};
const groqModels = ["llama-3.3-70b-versatile", "llama3-8b-8192", "mixtral-8x7b-32768"];

async function generateResilientGroqContent(messages) {
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
                console.log(chalk.yellow(`[Groq] Rate limit hit on ${modelName}, switching model...`));
                continue; // Coba model berikutnya jika rate limit
            } else {
                throw error; // Lempar error jika bukan masalah rate limit
            }
        }
    }
    throw new Error(`Semua model gagal. Error terakhir: ${lastError.message}`);
}

async function generateQwenVisionContent(prompt, base64Image, mimeType) {
    const url = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions";
    // API Key QwenCloud
    const apiKey = process.env.QWEN_API_KEY || 'sk-ws-H.LDDRLE.IiUg.MEQCIB6x81yiZJDmT0zgNzd5oGp1uCX0QgoPCihDz2gzePifAiA2eMX5lA6e_7ZbMmyidb5tl8sr_Va-urNbxpey4RhlmA';
    
    const payload = {
        model: "qwen-vl-plus",
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: prompt || "Tolong jelaskan gambar ini dengan detail." },
                    { type: "image_url", image_url: { url: `data:${mimeType};base64,${base64Image}` } }
                ]
            }
        ],
        temperature: 0.1
    };

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const err = await response.text();
        throw new Error(`Qwen API Error: ${err}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
}

async function generateImage(prompt) {
    let width = 1024;
    let height = 1024;

    // Deteksi permintaan rasio dari prompt
    if (prompt.match(/16:9/)) {
        width = 1280;
        height = 720;
    } else if (prompt.match(/9:16/)) {
        width = 720;
        height = 1280;
    } else if (prompt.match(/4:3/)) {
        width = 1024;
        height = 768;
    } else if (prompt.match(/3:4/)) {
        width = 768;
        height = 1024;
    }

    const encodedPrompt = encodeURIComponent(prompt);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&nologo=true`;
    return imageUrl;
}

function centerText(text) {
  const lines = text.split('\n');
  const width = process.stdout.columns || 80;
  return lines
    .map(line => {
      const pad = Math.max(0, Math.floor((width - line.length) / 2));
      return ' '.repeat(pad) + line;
    })
    .join('\n');
}

function showBanner() {
  console.clear();
  const text = figlet.textSync('Fushinade Bot', { font: 'Slant' });
  console.log(chalk.cyanBright(centerText(text)));
}

async function startBot() {
  showBanner();

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './session' }),
    puppeteer: {
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  console.log(chalk.cyanBright('⏳ Membangun koneksi ke server WhatsApp... (Menunggu QR Code)'));

  client.on('qr', (qr) => {
    console.log(chalk.cyan('\n📱 Silakan scan QR Code di bawah ini menggunakan WhatsApp Anda:'));
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    console.log(chalk.greenBright('\n✅ Connected to WhatsApp!'));
    console.log(chalk.cyan(`👤 User: ${client.info.wid.user}`));
  });

  client.on('message_create', async msg => {
    const from = msg.from;
    
    // Hanya merespon pesan yang dikirim dari nomor Anda sendiri (085811683696)
    if (!msg.fromMe) return;

    const body = msg.body || "";
    const text = body.trim();
    const command = text;

    if (command.toLowerCase() === 'ping' || command.toLowerCase() === '.ping') {
        await msg.reply('pong! Bot is aktif dan merespon.');
        return;
    }

    if (command === '.menu') {
        const menuText = `*🤖 FUSHINADE BOT MENU 🤖*\n
*🤖 AI & Chatbot*
- .ai <pesan> : Chat AI (Contoh: .ai halo)
- .ask <pesan> : Tanya AI (Contoh: .ask siapa kamu)

*🛠️ Utilities*
- .ping : Cek respon bot
- .schedule <waktu> <pesan> : (Contoh: .schedule 1 08:00 pesan)
- .stiker : Buat stiker dari gambar (Kirim/Balas gambar dengan .stiker)
- .stikerteks <pesan> : Buat stiker dari teks (Contoh: .stikerteks Halo)
- .toimg : Ubah stiker jadi gambar (Balas stiker dengan .toimg)

*📝 Catatan (To-Do)*
- .catatan : Lihat Catatan
- .catat <pesan> : Tambah Catatan (Contoh: .catat belanja)
- .hapuscatatan <nomor> : Menghapus Catatan

*🌐 Info & Berita*
- .berita : Berita Terkini
- .cuaca <kota> : Cek Cuaca (Contoh: .cuaca Jakarta)

© Fushinade Bot 2025`;

        await msg.reply(menuText);
        return;
    }

    if (command === '.stiker' || command === '.sticker') {
        let targetMsg = msg;
        if (!msg.hasMedia && msg.hasQuotedMsg) {
            targetMsg = await msg.getQuotedMessage();
        }

        if (targetMsg.hasMedia) {
            try {
                const media = await targetMsg.downloadMedia();
                if (media.mimetype.includes('image') || media.mimetype.includes('video')) {
                    await msg.reply(media, undefined, { 
                        sendMediaAsSticker: true,
                        stickerName: 'Fushinade Bot',
                        stickerAuthor: 'Fushinade Bot'
                    });
                } else {
                    await msg.reply('Format media tidak didukung untuk dijadikan stiker.');
                }
            } catch (err) {
                console.error(err);
                await msg.reply('Gagal mengunduh atau membuat stiker.');
            }
        } else {
            await msg.reply('Kirim gambar/video pendek dengan caption *.stiker* atau balas gambar/video dengan *.stiker*.');
        }
        return;
    }

    if (command === '.toimg' || command === '.foto' || command === '.image') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia) {
                try {
                    const media = await quotedMsg.downloadMedia();
                    // Stiker di WhatsApp biasanya berformat image/webp
                    if (media.mimetype === 'image/webp') {
                        // Mengirim kembali sebagai gambar biasa
                        await msg.reply(media);
                    } else {
                        await msg.reply('Pesan yang dibalas bukan stiker!');
                    }
                } catch (err) {
                    console.error(err);
                    await msg.reply('Gagal mengubah stiker menjadi gambar.');
                }
            } else {
                await msg.reply('Balas stiker dengan perintah *.toimg*');
            }
        } else {
            await msg.reply('Balas stiker dengan perintah *.toimg* untuk mengubahnya menjadi gambar.');
        }
        return;
    }

    if (command.startsWith('.stikerteks ')) {
        const textToSticker = command.replace('.stikerteks ', '').trim();
        if (!textToSticker) {
            await msg.reply('Teksnya mana? Contoh: .stikerteks Halo bang');
            return;
        }

        try {
            const words = textToSticker.split(' ');
            let lines = [];
            let currentLine = "";
            const maxCharsPerLine = 12; // Perkiraan aman untuk font besar

            words.forEach(word => {
                // Handle kata yang sangat panjang
                if (word.length > maxCharsPerLine) {
                    if (currentLine) lines.push(currentLine.trim());
                    // Potong kata yang kepanjangan
                    const chunks = word.match(new RegExp(`.{1,${maxCharsPerLine}}`, 'g'));
                    if (chunks) {
                        for (let i = 0; i < chunks.length - 1; i++) {
                            lines.push(chunks[i]);
                        }
                        currentLine = chunks[chunks.length - 1] + " ";
                    }
                } else if ((currentLine + word).length > maxCharsPerLine) {
                    if (currentLine) lines.push(currentLine.trim());
                    currentLine = word + " ";
                } else {
                    currentLine += word + " ";
                }
            });
            if (currentLine) lines.push(currentLine.trim());

            // Batasi jumlah baris agar tidak keluar kotak (max 7 baris)
            if (lines.length > 7) {
                lines = lines.slice(0, 7);
                lines[6] = "...";
            }

            const lineHeight = 65;
            const startY = 80; // Mulai dari atas dengan sedikit padding

            const tspans = lines.map((line, i) => {
                // Escape karakter khusus XML
                const safeLine = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                // x=30 untuk rata kiri dengan sedikit padding
                return `<tspan x="30" y="${startY + i * lineHeight}">${safeLine}</tspan>`;
            }).join('');

            const svg = `
            <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
                <rect width="100%" height="100%" fill="white" rx="15" ry="15"/>
                <text font-family="Arial, sans-serif" font-weight="normal" font-size="65" fill="black" text-anchor="start">
                    ${tspans}
                </text>
            </svg>`;

            const svgBuffer = Buffer.from(svg);
            const pngBuffer = await sharp(svgBuffer).png().toBuffer();
            
            const { MessageMedia } = pkg;
            const media = new MessageMedia('image/png', pngBuffer.toString('base64'), 'sticker.png');
            
            await msg.reply(media, undefined, { 
                sendMediaAsSticker: true,
                stickerName: 'Stiker Teks',
                stickerAuthor: 'Fushinade Bot' 
            });
        } catch (error) {
            console.error(error);
            await msg.reply('Maaf, gagal membuat stiker teks.');
        }
        return;
    }

    if (command.startsWith('.ai') || command.startsWith('.ask')) {
        const prompt = command.replace(/^\.(ai|ask)\s*/, '').trim();
        const senderId = from;

        // Handle Vision / Image Analysis via Qwen
        let targetMsg = msg;
        if (!msg.hasMedia && msg.hasQuotedMsg) {
            targetMsg = await msg.getQuotedMessage();
        }
        
        if (targetMsg.hasMedia) {
            try {
                const media = await targetMsg.downloadMedia();
                if (media && media.mimetype.includes('image')) {
                    await msg.reply('👁️ *Vision AI (Qwen):* Sedang menganalisis gambar...');
                    const responseText = await generateQwenVisionContent(prompt, media.data, media.mimetype);
                    await msg.reply(responseText);
                    return;
                }
            } catch (err) {
                console.error("Gagal mendownload media untuk vision", err);
                await msg.reply('Maaf, AI Vision gagal menganalisis gambar Anda.');
                return;
            }
        }

        if (!prompt) {
            await msg.reply('Mau tanya apa? Contoh: .ai halo atau kirim/balas gambar dengan caption .ai');
            return;
        }

        if (!chatHistories[senderId]) {
            const currentDate = moment().tz('Asia/Jakarta').format('DD MMMM YYYY');
            chatHistories[senderId] = [{ role: "system", content: `Kamu adalah asisten AI dari WhatsApp Bot yang cerdas, ramah, dan asyik diajak ngobrol. Selalu gunakan Bahasa Indonesia yang natural, santai namun sopan. Sebagai informasi tambahan: Hari ini adalah tanggal ${currentDate}. Presiden Republik Indonesia saat ini adalah Prabowo Subianto (periode 2024-2029) dengan Wakil Presiden Gibran Rakabuming Raka.` }];
        }

        chatHistories[senderId].push({ role: "user", content: prompt });
        if (chatHistories[senderId].length > 10) chatHistories[senderId].splice(1, 1);

        try {
            const responseText = await generateResilientGroqContent(chatHistories[senderId]);
            chatHistories[senderId].push({ role: "assistant", content: responseText });
            if (chatHistories[senderId].length > 10) chatHistories[senderId].splice(1, 1);
            await msg.reply(responseText);
        } catch (error) {
            chatHistories[senderId].pop();
            console.error(error);
            if (error.message === "GROQ_QUOTA_EXCEEDED") {
                await msg.reply('Maaf, kuota API Groq (Limit Rate) Anda sedang habis. Silakan coba beberapa saat lagi.');
            } else {
                await msg.reply('Maaf, AI sedang mengalami gangguan / tidak ada model yang tersedia.');
            }
        }
        return;
    }

    if (command.startsWith('.gambar ') || command.startsWith('.imagine ')) {
        const prompt = command.replace(/^\.(gambar|imagine)\s+/, '').trim();
        if (!prompt) {
            await msg.reply('❌ Masukkan deskripsi gambar! Contoh: .gambar Kucing pakai kacamata hitam di pantai');
            return;
        }

        await msg.reply(`🎨 *AI Image Generator:*\nSedang melukis gambar "${prompt}"...\n⏳ Mohon tunggu sebentar.`);
        try {
            const imageUrl = await generateImage(prompt);
            const { MessageMedia } = pkg;
            const media = await MessageMedia.fromUrl(imageUrl, { unsafeMime: true });
            await msg.reply(media, undefined, { caption: `✅ Gambar Selesai!\n\n🎨 Prompt: ${prompt}` });
        } catch (err) {
            console.error("Gagal generate gambar:", err);
            await msg.reply(`❌ ${err.message || 'Gagal membuat gambar.'}`);
        }
        return;
    }

    if (command.startsWith('.catat ')) {
        const item = command.replace('.catat ', '').trim();
        let todos = {};
        if (fs.existsSync('./todos.json')) todos = JSON.parse(fs.readFileSync('./todos.json'));
        if (!todos[from]) todos[from] = [];
        todos[from].push(item);
        fs.writeFileSync('./todos.json', JSON.stringify(todos, null, 2));
        await msg.reply(`Catatan ditambahkan! Ketik .catatan untuk melihat list.`);
        return;
    }

    if (command === '.catatan') {
        let todos = {};
        if (fs.existsSync('./todos.json')) todos = JSON.parse(fs.readFileSync('./todos.json'));
        if (!todos[from] || todos[from].length === 0) {
            await msg.reply('Kamu tidak punya catatan.');
            return;
        }
        let replyTxt = '*Daftar Catatanmu:*\n';
        todos[from].forEach((item, index) => { replyTxt += `${index + 1}. ${item}\n`; });
        replyTxt += '\n_(Ketik .hapuscatatan <nomor> untuk menghapus)_';
        await msg.reply(replyTxt);
        return;
    }

    if (command.startsWith('.hapuscatatan ')) {
        const idx = parseInt(command.replace('.hapuscatatan ', '').trim()) - 1;
        let todos = {};
        if (fs.existsSync('./todos.json')) todos = JSON.parse(fs.readFileSync('./todos.json'));
        if (!todos[from] || todos[from].length === 0 || isNaN(idx) || idx < 0 || idx >= todos[from].length) {
            await msg.reply('Nomor catatan tidak valid.');
            return;
        }
        const removed = todos[from].splice(idx, 1);
        fs.writeFileSync('./todos.json', JSON.stringify(todos, null, 2));
        await msg.reply(`Catatan "${removed}" berhasil dihapus.`);
        return;
    }

    if (command.startsWith('.cuaca ')) {
        const city = command.replace('.cuaca ', '').trim();
        weather.find({search: city, degreeType: 'C'}, async function(err, result) {
            if(err || result.length === 0) {
                await msg.reply('Maaf, kota tidak ditemukan.');
                return;
            }
            const current = result[0].current;
            await msg.reply(`*Cuaca di ${current.observationpoint}*\nSuhu: ${current.temperature}°C\nKondisi: ${current.skytext}\nKelembapan: ${current.humidity}%`);
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
            await msg.reply(replyTxt);
        } catch (error) {
            console.error(error);
            await msg.reply('Maaf, gagal mengambil berita.');
        }
        return;
    }

    if (command.startsWith('.tiktok ')) {
        const url = command.replace('.tiktok ', '').trim();
        if (!url.includes('tiktok.com')) {
            await msg.reply('❌ Link tidak valid! Kirimkan link TikTok yang benar.');
            return;
        }
        await msg.reply('⏳ Sedang mendownload video TikTok...');
        try {
            const response = await fetch(`https://www.tikwm.com/api/?url=${url}`);
            const data = await response.json();
            if (data.code === 0 && data.data) {
                // Gunakan video standar (play) bukan HD (hdplay) agar tidak memberatkan server & WA
                const videoUrl = data.data.play || data.data.hdplay;
                const { MessageMedia } = pkg;
                const media = await MessageMedia.fromUrl(videoUrl, { unsafeMime: true });
                await msg.reply(media, undefined, { caption: `✅ Download Berhasil!\n\nJudul: ${data.data.title || '-'}` });
            } else {
                await msg.reply('❌ Gagal mendapatkan video dari link tersebut. Pastikan video tidak di-private.');
            }
        } catch (err) {
            console.error(err);
            await msg.reply('❌ Terjadi kesalahan pada server downloader TikTok (Video mungkin terlalu besar).');
        }
        return;
    }

    if (command.startsWith('.ig ')) {
        const url = command.replace('.ig ', '').trim();
        if (!url.includes('instagram.com')) {
            await msg.reply('❌ Link tidak valid! Kirimkan link Instagram yang benar.');
            return;
        }
        await msg.reply('⏳ Sedang mendownload video Instagram...');
        try {
            // Menggunakan API gratis Ryzendesu (alternatif: vreden)
            const response = await fetch(`https://api.ryzendesu.vip/api/downloader/igdl?url=${url}`);
            const data = await response.json();
            
            // Format response ryzendesu biasanya mengembalikan array URL media
            if (data && data.url && data.url.length > 0) {
                const videoUrl = data.url[0]; // Ambil slide pertama
                const { MessageMedia } = pkg;
                const media = await MessageMedia.fromUrl(videoUrl, { unsafeMime: true });
                await msg.reply(media, undefined, { caption: '✅ Sukses Download Instagram!' });
            } else {
                await msg.reply('❌ Gagal mendownload. Pastikan akun IG tidak diprivate.');
            }
        } catch (err) {
            console.error(err);
            await msg.reply('❌ Terjadi kesalahan pada server downloader IG (Mungkin API gratis sedang limit/down).');
        }
        return;
    }

    if (command.startsWith('.yt ')) {
        const url = command.replace('.yt ', '').trim();
        if (!url.includes('youtube.com') && !url.includes('youtu.be')) {
            await msg.reply('❌ Link tidak valid! Kirimkan link YouTube yang benar.');
            return;
        }
        await msg.reply('⏳ Sedang mendownload video YouTube (Batas WA maksimal 16MB)...');
        try {
            const response = await fetch(`https://api.ryzendesu.vip/api/downloader/ytmp4?url=${url}`);
            const data = await response.json();
            if (data && data.url) {
                const videoUrl = data.url;
                const { MessageMedia } = pkg;
                const media = await MessageMedia.fromUrl(videoUrl, { unsafeMime: true });
                await msg.reply(media, undefined, { caption: `✅ Sukses Download YouTube!` });
            } else {
                await msg.reply('❌ Gagal mendownload video YouTube ini.');
            }
        } catch (err) {
            console.error(err);
            await msg.reply('❌ Terjadi kesalahan atau ukuran video terlalu besar untuk dikirim via WA.');
        }
        return;
    }

  });
  
  client.on('disconnected', (reason) => {
    console.log(chalk.red('❌ Sesi terputus: ', reason));
  });

  client.initialize();
}

startBot();
