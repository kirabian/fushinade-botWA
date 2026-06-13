const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const schedule = require('node-schedule');
const moment = require('moment-timezone');

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
    
    if (msg.body === '.ping') {
        msg.reply('pong! Bot is aktif dan merespon.');
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
