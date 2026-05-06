const axios = require('axios');

const CHATWOOT_API_TOKEN  = process.env.CHATWOOT_API_TOKEN;
const CHATWOOT_ACCOUNT_ID = process.env.CHATWOOT_ACCOUNT_ID;
const BASE_URL            = 'https://srv904439.hstgr.cloud/api/v1/accounts';

async function getAllContacts() {
  let contacts = [];
  let page = 1;

  while (true) {
    const resp = await axios.get(`${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts?page=${page}`, {
      headers: { api_access_token: CHATWOOT_API_TOKEN }
    });

    const payload = resp.data.payload;
    if (!payload || payload.length === 0) break;
    contacts = contacts.concat(payload);
    console.log(`📄 Página ${page}: ${payload.length} contactos`);
    page++;
    if (payload.length < 15) break;
  }

  return contacts;
}

async function mergeContacts(baseId, childId) {
  try {
    await axios.post(
      `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/merge`,
      {
        base_contact_id: baseId,
        child_contact_id: childId
      },
      { headers: { api_access_token: CHATWOOT_API_TOKEN } }
    );
    console.log(`✅ Fusionados: base=${baseId} <- child=${childId}`);
  } catch (err) {
    console.error(`❌ Error fusionando ${baseId} <- ${childId}:`, err.response?.data || err.message);
  }
}

async function main() {
  console.log('🔍 Obteniendo todos los contactos...');
  const contacts = await getAllContacts();
  console.log(`📊 Total contactos: ${contacts.length}`);

  const contactos52  = contacts.filter(c => c.phone_number?.startsWith('+52') && !c.phone_number?.startsWith('+521'));
  const contactos521 = contacts.filter(c => c.phone_number?.startsWith('+521'));

  console.log(`📱 Contactos con +52 (incorrectos): ${contactos52.length}`);
  console.log(`📱 Contactos con +521 (correctos): ${contactos521.length}`);

  const mapa521 = {};
  for (const c of contactos521) {
    const numBase = c.phone_number.replace('+521', '');
    mapa521[numBase] = c;
  }

  let fusionados = 0;
  let corregidos = 0;

  for (const c52 of contactos52) {
    const numBase = c52.phone_number.replace('+52', '');
    const par521  = mapa521[numBase];

    if (par521) {
      console.log(`🔗 Par encontrado: ${c52.phone_number} (id:${c52.id}) <-> ${par521.phone_number} (id:${par521.id})`);
      await mergeContacts(par521.id, c52.id);
      fusionados++;
    } else {
      console.log(`✏️ Sin par, corrigiendo número: ${c52.phone_number} -> +521${numBase}`);
      try {
        await axios.patch(
          `${BASE_URL}/${CHATWOOT_ACCOUNT_ID}/contacts/${c52.id}`,
          {
            phone_number: `+521${numBase}`,
            identifier:   `+521${numBase}`
          },
          { headers: { api_access_token: CHATWOOT_API_TOKEN } }
        );
        console.log(`✅ Número corregido: +521${numBase}`);
        corregidos++;
      } catch (err) {
        console.error(`❌ Error corrigiendo número:`, err.response?.data || err.message);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }

  console.log('\n🎉 Proceso completado:');
  console.log(`✅ Fusionados: ${fusionados}`);
  console.log(`✏️ Solo corregidos (sin par): ${corregidos}`);
}

main().catch(console.error);
