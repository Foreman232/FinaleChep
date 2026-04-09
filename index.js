const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const FormData = require('form-data');
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
    const conversations = convRes.data.payload;
    const activeConv = conversations.find(c => c.status === 'open' || c.status === 'pending');
    if (activeConv) return activeConv.id;

    const newConv = await axios.post(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations`, {
      source_id: sourceId,
      inbox_id: CHATWOOT_INBOX_ID,
      assignee_id: null
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

async function sendToChatwoot(conversationId, type, content) {
  try {
    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      { content, message_type: 'incoming', private: false },
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
  } catch (err) {
    console.error('❌ Error enviando a Chatwoot:', err.message);
  }
}

// Descarga media entrante de WhatsApp y la sube a Chatwoot
async function downloadAndAttachMedia(conversationId, mediaUrl, mediaId, type) {
  try {
    console.log(`🔍 Descargando media tipo ${type}`);

    const parsedUrl = new URL(mediaUrl);
    const downloadUrl = `https://waba-v2.360dialog.io${parsedUrl.pathname}${parsedUrl.search}`;
    console.log(`🔍 URL convertida: ${downloadUrl}`);

    const mediaResp = await axios.get(downloadUrl, {
      headers: { 'D360-API-KEY': D360_API_KEY },
      responseType: 'arraybuffer',
      maxRedirects: 5
    });

    const contentType = mediaResp.headers['content-type'] || 'application/octet-stream';
    const extensions = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
      'application/pdf': 'pdf', 'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
    };
    const ext = extensions[contentType] || 'bin';
    const filename = `media_${mediaId || Date.now()}.${ext}`;

    const form = new FormData();
    form.append('attachments[]', Buffer.from(mediaResp.data), { filename, contentType });
    form.append('message_type', 'incoming');
    form.append('private', 'false');
    form.append('content', '');

    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/conversations/${conversationId}/messages`,
      form,
      { headers: { api_access_token: CHATWOOT_API_TOKEN, ...form.getHeaders() } }
    );
    console.log(`✅ Media subida a Chatwoot: ${filename}`);
  } catch (err) {
    console.error('❌ Error media status:', err.response?.status);
    console.error('❌ Error media mensaje:', err.message);
    const labels = { image: '🖼️ Imagen', document: '📄 Documento', audio: '🎤 Audio', video: '🎥 Video', sticker: '🎨 Sticker' };
    await sendToChatwoot(conversationId, 'text', `${labels[type] || '📎 Archivo'} recibido (no se pudo cargar)`);
  }
}

// Sube archivo de Chatwoot a 360dialog y devuelve el media_id
async function uploadMediaTo360(dataUrl, fileType) {
  try {
    console.log(`📤 Descargando adjunto de Chatwoot: ${dataUrl}`);

    const fileResp = await axios.get(dataUrl, {
      responseType: 'arraybuffer',
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    const contentType = fileResp.headers['content-type'] || 'application/octet-stream';
    const extensions = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
      'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'video/mp4': 'mp4',
      'application/pdf': 'pdf', 'application/msword': 'doc',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
      'application/vnd.ms-excel': 'xls',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx'
    };
    const ext = extensions[contentType] || 'bin';
    const filename = `outbound_${Date.now()}.${ext}`;

    const form = new FormData();
    form.append('file', Buffer.from(fileResp.data), { filename, contentType });
    form.append('messaging_product', 'whatsapp');

    const uploadResp = await axios.post('https://waba-v2.360dialog.io/media', form, {
      headers: { 'D360-API-KEY': D360_API_KEY, ...form.getHeaders() }
    });

    const mediaId = uploadResp.data?.id;
    console.log(`✅ Media subida a 360dialog, id: ${mediaId}`);
    return { mediaId, contentType };
  } catch (err) {
    console.error('❌ Error subiendo media a 360dialog:', err.response?.data || err.message);
    return null;
  }
}

// Envía media desde 360dialog a WhatsApp
async function sendMediaToWhatsApp(number, mediaId, contentType, fileType, caption = '') {
  try {
    // Determinar tipo de mensaje
    let msgType = 'document';
    if (fileType === 'sticker' || contentType === 'image/webp') {
      msgType = 'sticker';
    } else if (contentType.startsWith('image/')) {
      msgType = 'image';
    } else if (contentType.startsWith('video/')) {
      msgType = 'video';
    } else if (contentType.startsWith('audio/')) {
      msgType = 'audio';
    }

    const mediaPayload = { id: mediaId };
    // Los stickers no soportan caption
    if (caption && msgType !== 'sticker') {
      mediaPayload.caption = caption;
    }

    await axios.post(D360_API_URL, {
      recipient_type: 'individual',
      to: number,
      type: msgType,
      messaging_product: 'whatsapp',
      [msgType]: mediaPayload
    }, {
      headers: { 'D360-API-KEY': D360_API_KEY, 'Content-Type': 'application/json' }
    });

    console.log(`✅ Media enviada a WhatsApp (${msgType}): ${number}`);
  } catch (err) {
    console.error('❌ Error enviando media a WhatsApp:', err.response?.data || err.message);
  }
}

// Entrante desde WhatsApp (360dialog)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0]?.value;
    const phone = changes?.contacts?.[0]?.wa_id;
    const name = changes?.contacts?.[0]?.profile?.name;
    const msg = changes?.messages?.[0];
    if (!phone || !msg || msg.from_me) return;

    const contact = await findOrCreateContact(phone, name);
    if (!contact) return;

    await linkContactToInbox(contact.id, phone);
    const conversationId = await getOrCreateConversation(contact.id, contact.identifier);
    if (!conversationId) return;

    const type = msg.type;

    if (type === 'text') {
      await sendToChatwoot(conversationId, 'text', msg.text.body);

    } else if (type === 'image') {
      const mediaUrl = msg.image?.url;
      const mediaId  = msg.image?.id;
      console.log('🔍 image url:', mediaUrl, '| id:', mediaId);
      if (mediaUrl) {
        await downloadAndAttachMedia(conversationId, mediaUrl, mediaId, 'image');
      } else {
        await sendToChatwoot(conversationId, 'text', '🖼️ Imagen recibida (sin URL)');
      }

    } else if (type === 'document') {
      const mediaUrl = msg.document?.url;
      const mediaId  = msg.document?.id;
      if (mediaUrl) {
        await downloadAndAttachMedia(conversationId, mediaUrl, mediaId, 'document');
      } else {
        await sendToChatwoot(conversationId, 'text', '📄 Documento recibido (sin URL)');
      }

    } else if (type === 'audio') {
      const mediaUrl = msg.audio?.url;
      const mediaId  = msg.audio?.id;
      if (mediaUrl) {
        await downloadAndAttachMedia(conversationId, mediaUrl, mediaId, 'audio');
      } else {
        await sendToChatwoot(conversationId, 'text', '🎤 Audio recibido (sin URL)');
      }

    } else if (type === 'video') {
      const mediaUrl = msg.video?.url;
      const mediaId  = msg.video?.id;
      if (mediaUrl) {
        await downloadAndAttachMedia(conversationId, mediaUrl, mediaId, 'video');
      } else {
        await sendToChatwoot(conversationId, 'text', '🎥 Video recibido (sin URL)');
      }

    } else if (type === 'sticker') {
      const mediaUrl = msg.sticker?.url;
      const mediaId  = msg.sticker?.id;
      if (mediaUrl) {
        await downloadAndAttachMedia(conversationId, mediaUrl, mediaId, 'sticker');
      } else {
        await sendToChatwoot(conversationId, 'text', '🎨 Sticker recibido');
      }

    } else if (type === 'location') {
      const loc = msg.location;
      const locStr = `📍 Ubicación recibida:\nhttps://maps.google.com/?q=${loc.latitude},${loc.longitude}`;
      await sendToChatwoot(conversationId, 'text', locStr);

    } else if (type === 'contacts') {
      const contactos = msg.contacts || [];
      const textos = contactos.map(c => {
        const nombre   = c.name?.formatted_name || 'Sin nombre';
        const telefono = c.phones?.[0]?.phone   || 'Sin teléfono';
        return `👤 Contacto compartido:\nNombre: ${nombre}\nTeléfono: ${telefono}`;
      });
      await sendToChatwoot(conversationId, 'text', textos.join('\n\n'));

    } else if (type === 'reaction') {
      const emoji = msg.reaction?.emoji || '👍';
      await sendToChatwoot(conversationId, 'text', `Reacción: ${emoji}`);

    } else if (type === 'button') {
      await sendToChatwoot(conversationId, 'text', msg.button?.text || '[Botón presionado]');

    } else if (type === 'interactive') {
      const interactive = msg.interactive;
      let respuesta = '[Respuesta interactiva]';
      if (interactive?.button_reply) {
        respuesta = `Botón: ${interactive.button_reply.title}`;
      } else if (interactive?.list_reply) {
        respuesta = `Lista: ${interactive.list_reply.title}`;
      }
      await sendToChatwoot(conversationId, 'text', respuesta);

    } else {
      console.log(`⚠️ Tipo no manejado: ${type}`, JSON.stringify(msg));
      await sendToChatwoot(conversationId, 'text', `[Mensaje de tipo: ${type}]`);
    }

  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
});

// Saliente desde Chatwoot
app.post('/outbound', async (req, res) => {
  const msg = req.body;

  if (!msg?.message_type || msg.message_type !== 'outgoing') return res.sendStatus(200);

  const number      = msg.conversation?.meta?.sender?.phone_number?.replace('+', '');
  const content     = msg.content;
  const attachments = msg.attachments || [];

  if (!number) return res.sendStatus(200);

  const clave = `${number}:${content}`;
  if (content && mensajesMasivosEnviados.has(clave)) {
    mensajesMasivosEnviados.delete(clave);
    console.log(`⏭️ Mensaje masivo ignorado en outbound: ${number}`);
    return res.sendStatus(200);
  }

  try {
    // Enviar texto si hay contenido
    if (content) {
      await axios.post(D360_API_URL, {
        recipient_type: 'individual',
        to: number,
        type: 'text',
        messaging_product: 'whatsapp',
        text: { body: content }
      }, {
        headers: { 'D360-API-KEY': D360_API_KEY, 'Content-Type': 'application/json' }
      });
      console.log(`✅ Texto enviado a WhatsApp: ${content}`);
    }

    // Enviar adjuntos si los hay
    for (const attachment of attachments) {
      const dataUrl  = attachment.data_url;
      const fileType = attachment.file_type;
      if (!dataUrl) continue;

      console.log(`📎 Procesando adjunto tipo: ${fileType}`);
      const uploaded = await uploadMediaTo360(dataUrl, fileType);
      if (uploaded) {
        await sendMediaToWhatsApp(number, uploaded.mediaId, uploaded.contentType, fileType, content || '');
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error('❌ Error en outbound:', err.response?.data || err.message);
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
