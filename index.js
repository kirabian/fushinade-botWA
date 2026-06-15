const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const moment = require('moment-timezone');
const fs = require('fs');
const axios = require('axios');
const weather = require('weather-js');
const Parser = require('rss-parser');
const rssParser = new Parser();
require('dotenv').config();
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Inisialisasi Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || 'API_KEY_KOSONG');

const client = new Client({
    authStrategy: new LocalAuth(), // Saves session so you don't have to scan QR every time
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox'] // Good for compatibility
    }
});

client.on('qr', (qr) => {
    // Generate and scan this code with your phone
    qrcode.generate(qr, { small: true });
    console.log('Scan the QR code above with WhatsApp!');
});

client.on('ready', () => {
    console.log('Client is ready!');
});

client.on('message_create', async msg => {
    // We use message_create to catch both our own messages and incoming messages
    // If you only want to respond to others, use `client.on('message', ...)`
    
    const text = msg.body;
    const sender = msg.from;

    if (text === '.ping') {
        msg.reply('pong! Bot is aktif dan merespon.');
        return;
    }

    // 1. AI Chatbot (Gemini)
    if (text.startsWith('.ai ') || text.startsWith('.ask ')) {
        if (!process.env.GEMINI_API_KEY) {
            return msg.reply('API Key Gemini belum disetting di file .env. Silakan tambahkan GEMINI_API_KEY.');
        }
        const prompt = text.replace(/^\.(ai|ask)\s+/, '');
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const result = await model.generateContent(prompt);
            const response = await result.response;
            msg.reply(response.text());
        } catch (error) {
            console.error(error);
            msg.reply('Maaf, AI sedang mengalami gangguan.');
        }
        return;
    }

    // 2. Sticker Maker
    if (text === '.sticker') {
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media) {
                client.sendMessage(msg.from, media, { sendMediaAsSticker: true });
            }
        } else if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia) {
                const media = await quotedMsg.downloadMedia();
                if (media) {
                    client.sendMessage(msg.from, media, { sendMediaAsSticker: true });
                }
            } else {
                msg.reply('Kirim gambar dengan caption .sticker atau reply gambar dengan .sticker');
            }
        } else {
            msg.reply('Kirim gambar dengan caption .sticker atau reply gambar dengan .sticker');
        }
        return;
    }

    // 3. To-Do List
    if (text.startsWith('.catat ')) {
        const item = text.replace('.catat ', '').trim();
        let todos = {};
        if (fs.existsSync('./todos.json')) {
            todos = JSON.parse(fs.readFileSync('./todos.json'));
        }
        if (!todos[sender]) todos[sender] = [];
        todos[sender].push(item);
        fs.writeFileSync('./todos.json', JSON.stringify(todos, null, 2));
        msg.reply(`Catatan ditambahkan! Ketik .catatan untuk melihat list.`);
        return;
    }

    if (text === '.catatan') {
        let todos = {};
        if (fs.existsSync('./todos.json')) {
            todos = JSON.parse(fs.readFileSync('./todos.json'));
        }
        if (!todos[sender] || todos[sender].length === 0) {
            return msg.reply('Kamu tidak punya catatan.');
        }
        let replyTxt = '*Daftar Catatanmu:*\n';
        todos[sender].forEach((item, index) => {
            replyTxt += `${index + 1}. ${item}\n`;
        });
        replyTxt += '\n_(Ketik .hapuscatatan <nomor> untuk menghapus)_';
        msg.reply(replyTxt);
        return;
    }

    if (text.startsWith('.hapuscatatan ')) {
        const idx = parseInt(text.replace('.hapuscatatan ', '').trim()) - 1;
        let todos = {};
        if (fs.existsSync('./todos.json')) {
            todos = JSON.parse(fs.readFileSync('./todos.json'));
        }
        if (!todos[sender] || todos[sender].length === 0 || isNaN(idx) || idx < 0 || idx >= todos[sender].length) {
            return msg.reply('Nomor catatan tidak valid.');
        }
        const removed = todos[sender].splice(idx, 1);
        fs.writeFileSync('./todos.json', JSON.stringify(todos, null, 2));
        msg.reply(`Catatan "${removed}" berhasil dihapus.`);
        return;
    }

    // 4. Info Cuaca & Berita
    if (text.startsWith('.cuaca ')) {
        const city = text.replace('.cuaca ', '').trim();
        weather.find({search: city, degreeType: 'C'}, function(err, result) {
            if(err || result.length === 0) {
                return msg.reply('Maaf, kota tidak ditemukan.');
            }
            const current = result[0].current;
            msg.reply(`*Cuaca di ${current.observationpoint}*\nSuhu: ${current.temperature}°C\nKondisi: ${current.skytext}\nKelembapan: ${current.humidity}%`);
        });
        return;
    }

    if (text === '.berita') {
        try {
            const feed = await rssParser.parseURL('https://www.antaranews.com/rss/terkini.xml');
            let replyTxt = '*Berita Terkini (Antara News):*\n\n';
            for (let i = 0; i < 5 && i < feed.items.length; i++) {
                replyTxt += `📰 *${feed.items[i].title}*\n${feed.items[i].link}\n\n`;
            }
            msg.reply(replyTxt);
        } catch (error) {
            console.error(error);
            msg.reply('Maaf, gagal mengambil berita.');
        }
        return;
    }

    // 5. Downloader (Template)
    if (text.startsWith('.tiktok ') || text.startsWith('.ig ') || text.startsWith('.yt ')) {
        const link = text.split(' ')[1];
        if (!link) return msg.reply('Harap sertakan link videonya.');
        
        msg.reply('⏳ Fitur downloader membutuhkan API khusus yang belum dikonfigurasi. Ini adalah template respons.');
        // Contoh implementasi (Butuh API endpoint):
        // try {
        //     const res = await axios.get(`https://api.example.com/download?url=${link}`);
        //     const mediaUrl = res.data.url;
        //     const media = await MessageMedia.fromUrl(mediaUrl);
        //     client.sendMessage(msg.from, media, { caption: 'Ini videonya!' });
        // } catch (e) {
        //     msg.reply('Gagal mendownload.');
        // }
        return;
    }

    // 6. Sticker to Image (HD Upscale Template)
    if (text === '.toimg') {
        if (msg.hasQuotedMsg) {
            const quotedMsg = await msg.getQuotedMessage();
            if (quotedMsg.hasMedia && quotedMsg.type === 'sticker') {
                const media = await quotedMsg.downloadMedia();
                if (media) {
                    msg.reply('⏳ Mengubah stiker ke gambar...');
                    // Untuk 4K HD, buffer gambar ini dikirim ke layanan Upscaler API (contoh: Replicate).
                    // Disini kita memproses pengubahan dasar tanpa upscaling.
                    media.filename = 'image.png'; 
                    client.sendMessage(msg.from, media, { sendMediaAsSticker: false, caption: 'Ini gambar dari stiker (Untuk 4K HD butuh API Key khusus).' });
                }
            } else {
                msg.reply('Harap reply sebuah stiker dengan command .toimg');
            }
        } else {
            msg.reply('Harap reply sebuah stiker dengan command .toimg');
        }
        return;
    }

    // Command format: .schedule 08123456789 05.30 Besok meeting
    if (msg.body.startsWith('.schedule ')) {
        const textStr = msg.body.substring('.schedule '.length).trim();
        
        // Match format: <number> <HH.mm or HH:mm> <message>
        const match = textStr.match(/^(\d+)\s+(\d{1,2})[.:](\d{2})\s+(.+)/);

        if (!match) {
            msg.reply('Format salah.\nContoh: *.schedule 08123456789 05.30 Pesan yang ingin dikirim*');
            return;
        }

        let targetNumber = match[1];
        const hour = parseInt(match[2], 10);
        const minute = parseInt(match[3], 10);
        const scheduleMessage = match[4];

        if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
            msg.reply('Jam tidak valid. Gunakan format 24 jam (00-23) dan menit (00-59).');
            return;
        }

        // Format number to 628xxx...
        if (targetNumber.startsWith('0')) {
            targetNumber = '62' + targetNumber.substring(1);
        } else if (targetNumber.startsWith('8')) {
            targetNumber = '62' + targetNumber;
        }

        // Validate number and get contact
        let contactName = targetNumber;
        let finalChatId = targetNumber + '@c.us';

        try {
            const numberId = await client.getNumberId(targetNumber);
            if (!numberId) {
                msg.reply(`Nomor ${targetNumber} tidak terdaftar di WhatsApp.`);
                return;
            }
            finalChatId = numberId._serialized;
            const contact = await client.getContactById(finalChatId);
            if (contact) {
                contactName = contact.name || contact.pushname || contact.shortName || targetNumber;
            }
        } catch (e) {
            console.log('Error fetching contact:', e);
        }

        // Get current time in Jakarta/WIB
        const nowWib = moment().tz('Asia/Jakarta');
        // Create the target time for today using moment
        let targetWib = moment.tz([nowWib.year(), nowWib.month(), nowWib.date(), hour, minute, 0], 'Asia/Jakarta');

        // If the target time is in the past for today, schedule it for tomorrow
        if (targetWib.isBefore(nowWib)) {
            targetWib.add(1, 'days');
        }

        // Convert the target timezone (Asia/Jakarta) back to local Date object for node-schedule
        const targetDate = targetWib.toDate();
        const formattedDate = targetWib.format('DD/MM/YYYY HH:mm');

        msg.reply(`Sip! Pesan akan dikirim ke *${contactName}* pada *${formattedDate} WIB*.\nPesan: "${scheduleMessage}"`);

        // Schedule the job
        schedule.scheduleJob(targetDate, async () => {
            try {
                // Send to the target number
                await client.sendMessage(finalChatId, `Halo *${contactName}*,\n\n*[Pesan Terjadwal]*\n${scheduleMessage}`);
                console.log(`Sent scheduled message to ${contactName} (${finalChatId}): ${scheduleMessage}`);
            } catch (err) {
                console.error('Failed to send scheduled message:', err);
            }
        });
    }
});

// Start the client
client.initialize();
