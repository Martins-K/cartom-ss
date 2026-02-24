/**
 * process.js - SS.LV scraper + Pipedrive logic
 *
 * Usage: node process.js <conversationUrl> <emailSender>
 */

require('dotenv').config({ override: false });

const fs = require('fs');

const conversationUrl = process.argv[2];
const emailSender = (process.argv[3] || '').trim().toLowerCase();

if (!conversationUrl || !emailSender) {
  console.error('❌ Usage: node process.js <conversationUrl> <emailSender>');
  process.exit(1);
}

// === CONFIG ===
const PIPEDRIVE_DOMAIN = 'https://cartom.pipedrive.com';
const API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const DEAL_OWNER_USER_ID = 24734804;
const SOURCE_CHANNEL_FIELD_ID = 36;
const SOURCE_COMPANY_FIELD_ID = 49;

const SENDER_CONFIG = {
  'info@cartom.lv': {
    sourceChannelOptionId: 70,
    sourceCompanyOptionId: 47,
    dealTitlePrefix: 'SS Cartom',
  },
  'autoplacis@autotev.lv': {
    sourceChannelOptionId: 68,
    sourceCompanyOptionId: 50,
    dealTitlePrefix: 'SS AutoTev',
  },
  'sales@cartom.lv': {
    sourceChannelOptionId: 69,
    sourceCompanyOptionId: 54,
    dealTitlePrefix: 'SS Current',
  },
};

const cfg = SENDER_CONFIG[emailSender];
if (!cfg) {
  console.error(`❌ Unsupported sender: ${emailSender}`);
  process.exit(1);
}

// === LOAD COOKIES ===
function loadCookies() {
  if (!fs.existsSync('./ss-lv-cookies.json')) {
    throw new Error('No cookies found. authenticate.js must run first.');
  }
  const data = JSON.parse(fs.readFileSync('./ss-lv-cookies.json', 'utf8'));
  return data.cookieString;
}

// === SCRAPE SS.LV ===
async function fetchFirstMessage(cookieString, url) {
  console.log(`🌐 Fetching SS.LV conversation: ${url}`);

  const response = await fetch(url, {
    headers: {
      Cookie: cookieString,
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (response.url && response.url.includes('/login/')) {
    throw new Error('SS.LV session expired - cookies are stale');
  }

  const html = await response.text();
  console.log(`   ✓ Page loaded (${html.length} bytes)`);

  const chatDivMatch = html.match(
    /<div id="chat_dv"[^>]*>([\s\S]*?)<\/div>\s*<div style="margin-top: 20px;">/
  );
  if (!chatDivMatch) throw new Error('Could not find chat div in HTML');

  const chatContent = chatDivMatch[1];
  if (chatContent.length < 50) throw new Error('Chat div is empty');

  const scriptRegex =
    /<script>_out_text\("([^"]*)",\s*"mail_content_(\d+)"\);<\/script>/g;
  const messageTexts = new Map();
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(chatContent)) !== null) {
    messageTexts.set(scriptMatch[2], scriptMatch[1]);
  }

  const messageRegex =
    /<a name="(\d+)"><\/a>\s*<div[^>]*>([\s\S]*?)<td class="?td15"?[^>]*>([^<]+)<\/td>/g;
  const match = messageRegex.exec(chatContent);
  if (!match) throw new Error('Could not parse any messages');

  const firstMessage = messageTexts.get(match[1]) || '';
  if (!firstMessage) throw new Error('First message text is empty');

  console.log(`   ✓ First message: "${firstMessage.substring(0, 60)}..."`);
  return firstMessage;
}

// === PIPEDRIVE HELPERS ===
async function pdFetch(path, { method = 'GET', body } = {}) {
  const url = `${PIPEDRIVE_DOMAIN}/api/v1${path}${path.includes('?') ? '&' : '?'}api_token=${API_TOKEN}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    throw new Error(
      `Pipedrive API error (${method} ${path}): ${json?.error || `HTTP ${res.status}`}`
    );
  }
  return json;
}

async function getDealFieldKeys() {
  const resp = await pdFetch('/dealFields');
  const byId = new Map((resp.data || []).map((f) => [f.id, f.key]));
  return {
    sourceChannelKey: byId.get(SOURCE_CHANNEL_FIELD_ID),
    sourceCompanyKey: byId.get(SOURCE_COMPANY_FIELD_ID),
  };
}

async function findPersonByFirstName(firstName) {
  const resp = await pdFetch(
    `/persons/search?term=${encodeURIComponent(firstName)}&fields=name&exact_match=false`
  );
  const items = resp?.data?.items || [];
  return (
    items.find((i) => {
      const personFirstName = (i.item.name || '').split(' ')[0].toLowerCase();
      return personFirstName === firstName.toLowerCase();
    })?.item || null
  );
}

async function getDealsForPerson(personId) {
  const resp = await pdFetch(
    `/persons/${personId}/deals?status=all_not_deleted`
  );
  return resp.data || [];
}

async function dealHasFirstMessageNote(dealId, firstMessage) {
  const resp = await pdFetch(`/notes?deal_id=${dealId}`);
  const notes = resp.data || [];
  return notes.some((n) =>
    (n.content || '').includes(firstMessage.slice(0, 50))
  );
}

async function addNote(dealId, content) {
  const resp = await pdFetch('/notes', {
    method: 'POST',
    body: { deal_id: dealId, content },
  });
  return resp.data.id;
}

// === MAIN ===
async function main() {
  console.log('\n╔════════════════════════════════════════════╗');
  console.log('║   SS.LV Process                           ║');
  console.log('╚════════════════════════════════════════════╝\n');

  // 1. Load cookies
  const cookieString = loadCookies();
  console.log('✅ Cookies loaded\n');

  // 2. Scrape first message
  const firstMessage = await fetchFirstMessage(cookieString, conversationUrl);

  // 3. Parse contact name from URL (not available here — comes from email)
  //    Name is passed as optional 4th argument
  const contactPersonName = (process.argv[4] || 'Unknown').trim();
  const contactPersonFirstName =
    contactPersonName.split(' ')[0] || contactPersonName;

  const dealTitle = `${cfg.dealTitlePrefix} - ${contactPersonFirstName} - "${firstMessage.slice(0, 10)}..."`;
  const noteLink = `<div><b>SS message link:</b> <a href="${conversationUrl}">${conversationUrl}</a></div>`;
  const firstMessageNote = `${noteLink}<div><b>First SS message:</b> ${firstMessage}</div>`;

  console.log(`\n👤 Contact: ${contactPersonName}`);
  console.log(`📋 Deal title: ${dealTitle}`);

  // 4. Get Pipedrive field keys
  const { sourceChannelKey, sourceCompanyKey } = await getDealFieldKeys();
  if (!sourceChannelKey || !sourceCompanyKey) {
    throw new Error('Could not resolve custom deal field keys');
  }

  // 5. Duplicate check
  let resultAction = '';
  let dealId, personId, noteId;

  console.log('\n🔍 Checking for duplicates in Pipedrive...');
  const existingPerson = await findPersonByFirstName(contactPersonFirstName);

  if (existingPerson) {
    console.log(
      `   ✓ Found existing person: ${existingPerson.name} (ID: ${existingPerson.id})`
    );
    personId = existingPerson.id;
    const deals = await getDealsForPerson(personId);
    console.log(`   ✓ Found ${deals.length} deal(s) for this person`);

    if (deals.length > 0) {
      for (const deal of deals) {
        if (await dealHasFirstMessageNote(deal.id, firstMessage)) {
          dealId = deal.id;
          console.log(
            `   ✓ Found matching deal with first message note (ID: ${dealId})`
          );

          const latestNote = `${noteLink}<div><b>Latest SS message:</b> ${firstMessage}</div>`;
          noteId = await addNote(dealId, latestNote);
          resultAction = 'added_note_to_existing_deal';
          break;
        }
      }
    }
  }

  if (!resultAction) {
    console.log('   ℹ️  No duplicate found — creating new person + deal');

    if (!existingPerson) {
      const created = await pdFetch('/persons', {
        method: 'POST',
        body: { name: contactPersonName, owner_id: DEAL_OWNER_USER_ID },
      });
      personId = created.data.id;
      console.log(`   ✓ Created person (ID: ${personId})`);
    }

    const createdDeal = await pdFetch('/deals', {
      method: 'POST',
      body: {
        title: dealTitle,
        user_id: DEAL_OWNER_USER_ID,
        person_id: personId,
        [sourceChannelKey]: cfg.sourceChannelOptionId,
        [sourceCompanyKey]: cfg.sourceCompanyOptionId,
      },
    });
    dealId = createdDeal.data.id;
    console.log(`   ✓ Created deal (ID: ${dealId})`);

    noteId = await addNote(dealId, firstMessageNote);
    console.log(`   ✓ Created note (ID: ${noteId})`);
    resultAction = 'created_new_deal';
  }

  console.log(`\n✅ Done: ${resultAction}`);
  console.log(`   Person ID: ${personId}`);
  console.log(`   Deal ID: ${dealId}`);
  console.log(`   Note ID: ${noteId}`);
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
