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
  const fileS
