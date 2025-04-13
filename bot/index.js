const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const translate = require('google-translate-api-x');
const langdetect = require('langdetect');
const fs = require('fs');
const { exec } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const path = require('path');

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const logChat = (messageData) => {
  const logFilePath = './chatLogs.json';

  if (!fs.existsSync(logFilePath)) {
    fs.writeFileSync(logFilePath, JSON.stringify([]));
  }

  const logData = JSON.parse(fs.readFileSync(logFilePath, 'utf-8'));
  logData.push(messageData);
  fs.writeFileSync(logFilePath, JSON.stringify(logData, null, 2));
};

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState('./baileys_auth_info');

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    browser: ['Chrome', 'Windows', '10'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect.error = new Boom(lastDisconnect?.error))?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('connection closed due to', lastDisconnect?.error, ', reconnecting', shouldReconnect);
      if (shouldReconnect) startSock();
    } else if (connection === 'open') {
      console.log('✅ connected to WhatsApp');
    }
  });

  const cache = {};

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0];
    if (!msg.message || msg.key.fromMe) return;

    const from = msg.key.remoteJid;
    const text = msg.message.conversation || msg.message.extendedTextMessage?.text;

    // ✅ voice message handling
    if (msg.message.audioMessage) {
      try {
        const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: console });
        const oggPath = './voice.ogg';
        const mp3Path = './voice.mp3';

        fs.writeFileSync(oggPath, buffer);
        console.log('✅ voice.ogg saved');

        await new Promise((resolve, reject) => {
          ffmpeg(oggPath)
            .toFormat('mp3')
            .on('end', () => {
              console.log('✅ Converted to MP3');
              resolve();
            })
            .on('error', (err) => {
              console.error('❌ Error converting to MP3:', err);
              reject(err);
            })
            .save(mp3Path);
        });

        exec(`python transcribe.py "${mp3Path}"`, async (err, stdout, stderr) => {
          if (err) {
            console.error('❌ Transcribe error:', err);
            await sock.sendMessage(from, { text: '❌ Failed to transcribe voice message.' });
            return;
          }

          const transcription = stdout.trim();
          console.log('📝 Transcribed:', transcription);

          let lang = langdetect.detect(transcription)[0]?.lang || 'en';
          if (lang === 'zh-tw') lang = 'zh-CN';

          try {
            if (lang !== 'en') {
              const translated = await translate(transcription, { from: lang, to: 'en', forceFrom: true });

              await sock.sendMessage(from, {
                text: `🈶 translated:\n${translated.text}`
              });
            } else {
              await sock.sendMessage(from, { text: `🈶 translated:\n${transcription}` });
            }
          } catch (translateErr) {
            console.error('❌ Translation failed:', translateErr);
            await sock.sendMessage(from, { text: `📝 Transcribed:\n${transcription}\n⚠️ But failed to translate.` });
          }
        });
      } catch (err) {
        console.error('❌ Voice message error:', err);
        await sock.sendMessage(from, { text: '❌ Failed to process voice message.' });
      }
    }

    // ✅ text message handling
    if (text) {
      try {
        const messageData = {
          sender: from,
          timestamp: new Date().toISOString(),
          message: text,
          type: 'original'
        };
        logChat(messageData);

        let detectedLanguage = langdetect.detect(text)[0]?.lang || 'auto';
        if (detectedLanguage === 'zh-tw') detectedLanguage = 'zh-CN';

        if (detectedLanguage === 'en') {
          await sock.sendMessage(from, {
            text: `🈶 translated:\n${text}`
          });
          return;
        }

        if (cache[text]) {
          await sock.sendMessage(from, {
            text: `🈶 translated:\n${cache[text]}`
          });
          return;
        }

        await new Promise(resolve => setTimeout(resolve, 1000));

        const res = await translate(text, { from: detectedLanguage, to: 'en', forceFrom: true });
        const translated = res.text;

        const translatedData = {
          sender: 'Bot',
          timestamp: new Date().toISOString(),
          message: translated,
          type: 'translated'
        };
        logChat(translatedData);

        cache[text] = translated;

        await sock.sendMessage(from, {
          text: `🈶 translated:\n${translated}`
        });
      } catch (err) {
        await sock.sendMessage(from, { text: '❌ Failed to translate. Try again later.' });
        console.error('Translation error:', err);
      }
    }
  });
}

startSock();
