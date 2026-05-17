import { IncomingForm } from 'formidable';
import fs from 'fs';
import path from 'path';

export const config = { api: { bodyParser: false } };

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

const FLOW_LABELS = {
  kyc:   '🪪 KYC — Hesap Doğrulama',
  email: '📧 E-posta Değişikliği',
  phone: '📱 Telefon Değişikliği',
};

const FILE_LABELS = {
  idFront:  'Kimlik Ön Yüz',
  idBack:   'Kimlik Arka Yüz',
  selfie:   'Selfie',
  address:  'Adres Belgesi',
};

/* ---------- Slack helpers ---------- */
async function sendWebhookMessage(text, blocks) {
  const body = { text, blocks };
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Webhook error ${res.status}: ${t}`);
  }
}

async function uploadFileToSlack(filePath, fileName, fileType, title) {
  // 1. Upload URL al
  const urlRes = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ filename: fileName, length: fs.statSync(filePath).size }),
  });
  const urlData = await urlRes.json();
  if (!urlData.ok) throw new Error(`files.getUploadURLExternal: ${urlData.error}`);

  // 2. Dosyayı yükle
  const fileBuffer = fs.readFileSync(filePath);
  const uploadRes = await fetch(urlData.upload_url, {
    method: 'POST',
    headers: { 'Content-Type': fileType || 'application/octet-stream' },
    body: fileBuffer,
  });
  if (!uploadRes.ok) throw new Error(`Upload failed: ${uploadRes.status}`);

  // 3. Tamamla (kanala gönder)
  const completeRes = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title }],
      channel_id: await resolveChannelId(),
      initial_comment: `📎 *${title}*`,
    }),
  });
  const completeData = await completeRes.json();
  if (!completeData.ok) throw new Error(`files.completeUploadExternal: ${completeData.error}`);
  return completeData.files?.[0]?.id;
}

let _channelId = null;
async function resolveChannelId() {
  if (_channelId) return _channelId;
  const channelName = SLACK_CHANNEL.replace('#', '');
  const res = await fetch(`https://slack.com/api/conversations.list?limit=200`, {
    headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
  });
  const data = await res.json();
  const ch = data.channels?.find(c => c.name === channelName);
  if (!ch) throw new Error(`Kanal bulunamadı: ${SLACK_CHANNEL}`);
  _channelId = ch.id;
  return _channelId;
}

/* ---------- Form parse ---------- */
function parseForm(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({ maxFileSize: 20 * 1024 * 1024, keepExtensions: true });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

/* ---------- Blocks builder ---------- */
function buildBlocks(flow, payload, refId) {
  const label = FLOW_LABELS[flow] || flow;
  const rows = Object.entries(payload).map(([k, v]) => ({
    type: 'mrkdwn',
    text: `*${k}:* ${v || '—'}`,
  }));

  return [
    {
      type: 'header',
      text: { type: 'plain_text', text: label, emoji: true },
    },
    {
      type: 'section',
      fields: rows.length ? rows : [{ type: 'mrkdwn', text: '_veri yok_' }],
    },
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

/* ---------- Main handler ---------- */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { fields, files } = await parseForm(req);

    const flow = Array.isArray(fields.flow) ? fields.flow[0] : fields.flow;
    const payloadRaw = Array.isArray(fields.payload) ? fields.payload[0] : fields.payload;
    const payload = JSON.parse(payloadRaw || '{}');

    const refId = `${flow.toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    // 1. Ana mesajı gönder
    const blocks = buildBlocks(flow, payload, refId);
    await sendWebhookMessage(`Yeni başvuru: ${FLOW_LABELS[flow] || flow}`, blocks);

    // 2. Dosyaları yükle
    const fileKeys = Object.keys(FILE_LABELS);
    for (const key of fileKeys) {
      const fileArr = files[key];
      if (!fileArr) continue;
      const file = Array.isArray(fileArr) ? fileArr[0] : fileArr;
      if (!file || !file.filepath) continue;
      const title = `[${refId}] ${FILE_LABELS[key] || key}`;
      try {
        await uploadFileToSlack(file.filepath, file.originalFilename || file.newFilename || key, file.mimetype, title);
      } catch (fileErr) {
        console.error(`Dosya yüklenemedi (${key}):`, fileErr.message);
        // Dosya hataları ana akışı durdurmaz
      }
    }

    return res.status(200).json({ ok: true, refId });
  } catch (err) {
    console.error('submit handler error:', err);
    return res.status(500).json({ error: err.message || 'Sunucu hatası' });
  }
}
