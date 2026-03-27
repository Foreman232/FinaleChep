const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();
app.use(bodyParser.json());

const CHATWOOT_API_TOKEN  = process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const CHATWOOT_INBOX_ID   = process.env.CHATWOOT_INBOX_ID;
const BASE_URL            = 'https://srv904439.hstgr.cloud/api/v1/accounts';
const D360_API_URL        = 'https://waba-v2.360dialog.io/messages';
const D360_API_KEY        = process.env.D360_API_KEY;

async function findOrCreateContact(phone, name = 'Cliente WhatsApp') {
  const identifier = `+${phone}`;
  const payload = {
    inbox_id: CHATWOOT_INBOX_ID,
    name,
    identifier,
    phone_number: identifier
  };
  try {
    const response = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return response.data.payload;
  } catch (err) {
    if (err.response?.data?.message?.includes('has already been taken')) {
      const getResp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/search?q=${identifier}`, {
        headers: { api_access_token: CHATWOOT_API_TOKEN }
      });
      return getResp.data.payload[0];
    }
    console.error(':x: Contacto error:', err.message);
    return null;
  }
}

async function linkContactToInbox(contactId, phone) {
  try {
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/contact_inboxes`, {
      inbox_id: CHATWOOT_INBOX_ID,
      source_id: `+${phone}`
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    if (!err.response?.data?.message?.includes('has already been taken')) {
      console.error(':x: Inbox link error:', err.message);
    }
  }
}

async function getOrCreateConversation(contactId, sourceId) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    if (convRes.data.payload.length > 0) return convRes.data.payload[0].id;
    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      inbox_id: CHATWOOT_INBOX_ID
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return newConv.data.id;
  } catch (err) {
    console.error(':x: Error creando conversación:', err.message);
    return null;
  }
}

async function sendToChatwoot(conversationId, type, content) {
  try {
    const payload = {
      content,
      message_type: 'incoming',
      private: false
    };
    if (['image', 'document', 'audio', 'video'].includes(type)) {
      payload.attachments = [{ file_type: type, file_url: content }];
      delete payload.content;
    }
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, payload, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
  } catch (err) {
    console.error(':x: Error enviando a Chatwoot:', err.message);
  }
}

// Entrante desde WhatsApp (360dialog)
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return res.sendStatus(200);
    const contact = await findOrCreateContact(phone, name);
    if (!contact) return res.sendStatus(500);
    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.sendStatus(500);
    const type = msg.type;
    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);
    } else if (type === 'image') {
      await sendToChatwoot(conversationId, 'image', msg.image?.link || 'Imagen recibida');
    } else if (type === 'document') {
      await sendToChatwoot(conversationId, 'document', msg.document?.link || 'Documento recibido');
    } else if (type === 'audio') {
      await sendToChatwoot(conversationId, 'audio', msg.audio?.link || 'Nota de voz recibida');
    } else if (type === 'video') {
      await sendToChatwoot(conversationId, 'video', msg.video?.link || 'Video recibido');
    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `Ubicación recibida 📍\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);
    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]');
    }
    res.sendStatus(200);
  } catch (err) {
    console.error(':x: Webhook error:', err.message);
    res.sendStatus(500);
  }
});

// Saliente desde Chatwoot
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing') return res.sendStatus(200);
  const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content = msg.content;
  if (!number || !content) return res.sendStatus(200);
  try {
    await axios.post(D360_API_URL, {
      recipient_type: "individual",
      to: number,
      type: "text",
      messaging_product: "whatsapp",
      text: { body: content }
    }, {
      headers: { 'D360-API-KEY': D360_API_KEY, 'Content-Type': 'application/json' }
    });
    console.log(`✅ Enviado a WhatsApp: ${content}`);
    res.sendStatus(200);
  } catch (err) {
    console.error(':x: Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Registrar mensaje masivo saliente en Chatwoot
app.post('/send-chatwoot-message', async (req, res) => {
  const { phone, name, content } = req.body;
  if (!phone || !content) return res.status(400).json({ ok: false });
  try {
    const cleanPhone = phone.replace('+', '');
    const contact = await findOrCreateContact(cleanPhone, name || 'Cliente WhatsApp');
    if (!contact) return res.status(500).json({ ok: false });
    await linkContactToInbox(contact.id, cleanPhone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return res.status(500).json({ ok: false });
    await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`, {
      content,
      message_type: 'outgoing',
      private: false
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    console.log(`✅ Mensaje masivo registrado en Chatwoot: ${phone}`);
    res.json({ ok: true, messageId: conversationId });
  } catch (err) {
    console.error(':x: Error send-chatwoot-message:', err.message);
    res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
