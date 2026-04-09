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

const mensajesMasivosEnviados = new Set();

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
    console.error('❌ Contacto error:', err.message);
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
      console.error('❌ Inbox link error:', err.message);
    }
  }
}

async function getOrCreateConversation(contactId, sourceId) {
  try {
    const convRes = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${contactId}/conversations`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    // FIX #2: Buscar conversación abierta o pendiente, no solo la primera
    const conversations = convRes.data.payload;
    const activeConv = conversations.find(c => c.status === 'open' || c.status === 'pending');
    if (activeConv) return activeConv.id;

    // Si todas están resueltas, crear una nueva SIN asignar agente
    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      inbox_id: CHATWOOT_INBOX_ID,
      assignee_id: null  // FIX #2: Explícitamente sin asignar
    }, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });
    return newConv.data.id;
  } catch (err) {
    console.error('❌ Error creando conversación:', err.message);
    return null;
  }
}

async function abrirConversacion(conversationId) {
  try {
    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/toggle_status`,
      { status: 'open' },
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    console.log(`✅ Conversación ${conversationId} abierta`);
  } catch (err) {
    console.error('❌ Error abriendo conversación:', err.message);
  }
}

// FIX #2: Quitar asignación de una conversación
async function desasignarConversacion(conversationId) {
  try {
    await axios.patch(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/assignments`,
      { assignee_id: null },
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    console.log(`✅ Conversación ${conversationId} desasignada`);
  } catch (err) {
    console.error('❌ Error desasignando conversación:', err.message);
  }
}

// FIX #1: Manejo correcto de tipos de mensaje en Chatwoot
async function sendToChatwoot(conversationId, type, content) {
  try {
    let payload;

    if (type === 'text') {
      payload = {
        content,
        message_type: 'incoming',
        private: false
      };
    } else if (['image', 'document', 'audio', 'video'].includes(type)) {
      // Chatwoot no puede descargar URLs autenticadas de 360dialog directamente.
      // Enviamos el link como texto con un label claro para que el agente pueda verlo.
      const labels = {
        image: '🖼️ Imagen recibida',
        document: '📄 Documento recibido',
        audio: '🎤 Nota de voz recibida',
        video: '🎥 Video recibido'
      };
      payload = {
        content: `${labels[type]}:\n${content}`,
        message_type: 'incoming',
        private: false
      };
    } else {
      payload = {
        content,
        message_type: 'incoming',
        private: false
      };
    }

    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      payload,
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.message);
  }
}

// FIX #3: Obtener la URL del media desde 360dialog antes de enviarlo a Chatwoot
async function getMediaUrl(mediaId) {
  try {
    const resp = await axios.get(`https://waba-v2.360dialog.io/media/${mediaId}`, {
      headers: { 'D360-API-KEY': D360_API_KEY }
    });
    return resp.data?.url || null;
  } catch (err) {
    console.error('❌ Error obteniendo media URL:', err.message);
    return null;
  }
}

// Entrante desde WhatsApp (360dialog)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // FIX #3: Responder de inmediato para no bloquear 360dialog

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return;

    // FIX #3: Paralelizar contact + inbox link
    const contact = await findOrCreateContact(phone, name);
    if (!contact) return;

    // Ejecutar en paralelo donde sea posible
    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return;

    const type = msg.type;

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);

    } else if (type === 'image') {
      // FIX #1: Intentar obtener URL pública; si no, enviar aviso
      const mediaId = msg.image?.id;
      const mediaUrl = mediaId ? await getMediaUrl(mediaId) : msg.image?.link;
      await sendToChatwoot(conversationId, 'image', mediaUrl || 'URL no disponible');

    } else if (type === 'document') {
      const mediaId = msg.document?.id;
      const mediaUrl = mediaId ? await getMediaUrl(mediaId) : msg.document?.link;
      await sendToChatwoot(conversationId, 'document', mediaUrl || 'URL no disponible');

    } else if (type === 'audio') {
      const mediaId = msg.audio?.id;
      const mediaUrl = mediaId ? await getMediaUrl(mediaId) : msg.audio?.link;
      await sendToChatwoot(conversationId, 'audio', mediaUrl || 'URL no disponible');

    } else if (type === 'video') {
      const mediaId = msg.video?.id;
      const mediaUrl = mediaId ? await getMediaUrl(mediaId) : msg.video?.link;
      await sendToChatwoot(conversationId, 'video', mediaUrl || 'URL no disponible');

    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `📍 Ubicación recibida:\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);

    } else {
      await sendToChatwoot(conversationId, 'text', '[Contenido no soportado]');
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// Saliente desde Chatwoot
app.post('/outbound', async (req, res) => {
  const msg = req.body;
  if (!msg?.message_type || msg.message_type !== 'outgoing') return res.sendStatus(200);
  const number = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content = msg.content;
  if (!number || !content) return res.sendStatus(200);

  const clave = `${number}:${content}`;
  if (mensajesMasivosEnviados.has(clave)) {
    mensajesMasivosEnviados.delete(clave);
    console.log(`⏭️ Mensaje masivo ignorado en outbound: ${number}`);
    return res.sendStatus(200);
  }

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
    console.error('❌ Error enviando a WhatsApp:', err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Registrar mensaje masivo saliente en Chatwoot
app.post('/send-chatwoot-message', async (req, res) => {
  const { phone, name, content } = req.body;
  if (!phone || !content) return res.status(400).json({ ok: false });
  try {
    const cleanPhone = phone.replace('+', '');

    const clave = `${cleanPhone}:${content}`;
    mensajesMasivosEnviados.add(clave);
    setTimeout(() => mensajesMasivosEnviados.delete(clave), 30000);

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

    // FIX #2: Abrir conversación Y luego desasignar para que quede sin agente
    await abrirConversacion(conversationId);
    await desasignarConversacion(conversationId);

    console.log(`✅ Mensaje masivo registrado en Chatwoot: ${phone}`);
    res.json({ ok: true, messageId: conversationId });
  } catch (err) {
    console.error('❌ Error send-chatwoot-message:', err.message);
    res.status(500).json({ ok: false });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Webhook corriendo en puerto ${PORT}`));
