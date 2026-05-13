/**
 * Webhook server para WhatsApp Business Cloud API
 * Recibe mensajes entrantes → los guarda en Firestore
 * Envía mensajes salientes vía API de Meta
 *
 * Instalación: npm install express firebase-admin node-fetch dotenv
 * Arrancar: node server.js
 */

require('dotenv').config();
const express = require('express');
const admin   = require('firebase-admin');
const fetch   = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const app = express();
app.use(express.json());

// ── Firebase Admin Init ────────────────────────────────────
const serviceAccount = require('./firebase-service-account.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── Variables de entorno ───────────────────────────────────
const {
  WA_VERIFY_TOKEN,    // Token que pusiste en Meta al configurar el webhook
  WA_ACCESS_TOKEN,    // Token de acceso de tu app de Meta
  WA_PHONE_NUMBER_ID, // ID del número de teléfono de WhatsApp Business
  PORT = 3000
} = process.env;

// ── VERIFICACIÓN DEL WEBHOOK (GET) ────────────────────────
// Meta llama a esto para verificar la URL del webhook
app.get('/webhook', (req, res) => {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
    console.log('Webhook verificado ✓');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ── RECIBIR MENSAJES ENTRANTES (POST) ─────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const val = change.value;
        if (!val.messages) continue;

        for (const msg of val.messages) {
          if (msg.type !== 'text') continue; // Solo texto por ahora

          const phone   = msg.from;  // Número sin + (ej: 5491100000000)
          const text    = msg.text.body;
          const waId    = msg.id;
          const ts      = parseInt(msg.timestamp);

          await handleIncomingMessage({ phone, text, waId, ts });
        }
      }
    }
  } catch(e) {
    console.error('Error procesando webhook:', e);
  }
});

// ── LÓGICA DE MENSAJES ENTRANTES ──────────────────────────
async function handleIncomingMessage({ phone, text, waId, ts }) {
  const normalizedPhone = '+' + phone;

  // Buscar lead existente por teléfono
  const snap = await db.collection('leads')
    .where('phone', '==', normalizedPhone)
    .limit(1)
    .get();

  let leadId;

  if (snap.empty) {
    // Crear nuevo lead automáticamente
    const ref = await db.collection('leads').add({
      phone:       normalizedPhone,
      name:        'Desconocido',
      source:      'whatsapp',
      stage:       'falta_datos',
      salon:       'palacio', // Por defecto
      waMessageId: waId,
      lastMessage: text,
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
    leadId = ref.id;
    console.log('Nuevo lead creado:', leadId, normalizedPhone);
  } else {
    leadId = snap.docs[0].id;
    // Actualizar último mensaje
    await db.collection('leads').doc(leadId).update({
      lastMessage: text,
      waMessageId: waId,
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
  }

  // Guardar mensaje en subcollección
  await db.collection('leads').doc(leadId).collection('messages').add({
    text,
    direction: 'in',
    waId,
    createdAt: admin.firestore.Timestamp.fromMillis(ts * 1000),
    channel:   'whatsapp',
  });

  console.log(`Mensaje de ${normalizedPhone}: "${text}"`);
}

// ── ENVIAR MENSAJE (llamado desde el CRM) ─────────────────
app.post('/send', async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) return res.status(400).json({ error: 'phone y text son requeridos' });

  try {
    const cleaned = phone.replace(/\D/g, '');
    const url = `https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${WA_ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to:   cleaned,
        type: 'text',
        text: { body: text },
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));

    res.json({ ok: true, waId: data.messages?.[0]?.id });
  } catch(e) {
    console.error('Error enviando WA:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`Webhook server corriendo en puerto ${PORT}`));
