const { IncomingForm } = require('formidable');
const fs = require('fs');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

const FLOW_LABELS = {
  kyc:   '🪪 KYC — Hesap Doğrulama',
  email: '📧 E-posta Değişikliği',
  phone: '📱 Telefon Değişikliği',
};

const FILE_LABELS = {
  idFront: 'Kimlik Ön Yüz',
  idBack:  'Kimlik Arka Yüz',
  selfie:  'Selfie',
  address: 'Adres Belgesi',
};

async function sendWebhookMessage(text, blocks) {
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, blocks }),
  });
  if (!res.ok) throw new Error(`Webhook error ${res.status}`);
}

async function uploadFileToSlack(filePath, fileName, fileType, title, channelId) {
  const fileBuffer = fs.readFileSync(filePath);
  const fileSize = fileBuffer.length;

  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filename: fileName || 'file', length: fileSize }),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`getUploadURL: ${urlData.error}`);

  await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': fileType || 'application/octet-stream' },
    body: fileBuffer,
  });

  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title }],
      channel_id: channelId,
      initial_comment: `📎 *${title}*`,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`completeUpload: ${completeData.error}`);
}

async function resolveChannelId() {
  return 'C0B220PMH0T';
}

function buildBlocks(flow, payload, refId) {
  const label = FLOW_LABELS[flow] || flow;
  const rows = Object.entries(payload).map(([k, v]) => ({
    type: 'mrkdwn',
    text: `*${k}:* ${v || '—'}`,
  }));
  return [
    { type: 'header', text: { type: 'plain_text', text: label, emoji: true } },
    { type: 'section', fields: rows.length ? rows : [{ type: 'mrkdwn', text: '_veri yok_' }] },
    { type: 'divider' },
    {
      type: 'context',
      elements: [
        { type: 'mrkdwn', text: `🆔 Ref: \`${refId}\`` },
        { type: 'mrkdwn', text: `🕐 ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}` },
      ],
    },
  ];
}

exports.handler = async function(event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const body = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const contentType = event.headers['content-type'] || event.headers['Content-Type'] || '';

    const { fields, files } = await new Promise((resolve, reject) => {
      const form = new IncomingForm({ maxFileSize: 20 * 1024 * 1024, keepExtensions: true });
      const { Readable } = require('stream');
      const fakeReq = Object.assign(Readable.from(body), {
        headers: { 'content-type': contentType, 'content-length': String(body.length) },
      });
      form.parse(fakeReq, (err, fields, files) => {
        if (err) return reject(err);
        resolve({ fields, files });
      });
    });

    const flow = Array.isArray(fields.flow) ? fields.flow[0] : fields.flow;
    const payloadRaw = Array.isArray(fields.payload) ? fields.payload[0] : fields.payload;
    const payload = JSON.parse(payloadRaw || '{}');
    const refId = `${flow.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    const blocks = buildBlocks(flow, payload, refId);
    await sendWebhookMessage(`Yeni başvuru: ${FLOW_LABELS[flow] || flow}`, blocks);

    const channelId = await resolveChannelId();
    console.log('Files received:', JSON.stringify(Object.keys(files)));
    for (const key of Object.keys(FILE_LABELS)) {
      const fileArr = files[key];
      if (!fileArr) continue;
      const file = Array.isArray(fileArr) ? fileArr[0] : fileArr;
      console.log(`File [${key}]:`, JSON.stringify({ filepath: file?.filepath, name: file?.originalFilename, size: file?.size, mime: file?.mimetype }));
      if (!file?.filepath) continue;
      const fileName = (file.originalFilename || key).replace(/[^a-zA-Z0-9._-]/g, '_') + '.jpg';
      const title = `[${refId}] ${FILE_LABELS[key]}`;
      try {
        await uploadFileToSlack(file.filepath, fileName, file.mimetype || 'image/jpeg', title, channelId);
      } catch (e) {
        console.error(`Dosya hatası (${key}):`, e.message);
      }
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, refId }) };
  } catch (err) {
    console.error('Handler error:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message || 'Sunucu hatası' }) };
  }
};
