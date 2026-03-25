/**
 * process.js - SS.LV scraper + Pipedrive logic
 *
 * Usage: node process.js <conversationUrl> <emailSender> <contactPersonName>
 */

require('dotenv').config({ override: false });

const conversationUrl = process.argv[2];
const emailSender = (process.argv[3] || '').trim().toLowerCase();
const contactPersonName = (process.argv[4] || 'Unknown').trim();
const contactPersonFirstName =
  contactPersonName.split(' ')[0] || contactPersonName;

if (!conversationUrl || !emailSender) {
  console.error(
    '❌ Usage: node process.js <conversationUrl> <emailSender> <contactPersonName>'
  );
  process.exit(1);
}

// === CONFIG ===
const PIPEDRIVE_DOMAIN = 'https://cartom.pipedrive.com';
const API_TOKEN = process.env.PIPEDRIVE_API_TOKEN;
const JSONBIN_BIN_ID = process.env.JSONBIN_BIN_ID;
const JSONBIN_API_KEY = process.env.JSONBIN_API_KEY;

if (!API_TOKEN) {
  console.error('❌ Missing PIPEDRIVE_API_TOKEN');
  process.exit(1);
}
if (!JSONBIN_BIN_ID || !JSONBIN_API_KEY) {
  console.error('❌ Missing JSONBIN_BIN_ID or JSONBIN_API_KEY');
  process.exit(1);
}

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

// === JSONBIN HELPERS ===
async function jsonbinGet() {
  const res = await fetch(
    `https://api.jsonbin.io/v3/b/${JSONBIN_BIN_ID}/latest`,
    {
      headers: { 'X-Master-Key': JSONBIN_API_KEY },
    }
  );
  if (!res.ok) throw new Error(`JSONBin GET failed: HTTP ${res.status}`);
  const json = await res.json();
  return json.record;
}

// === LOAD COOKIES FROM JSONBIN ===
async function loadCookies() {
  console.log('🔑 Loading cookies from JSONBin...');
  const record = await jsonbinGet();
  if (!record?.cookieString) {
    throw new Error(
      'No cookieString found in JSONBin. Run authenticate.js first.'
    );
  }
  console.log('   ✓ Cookies loaded');
  return record.cookieString;
}

// === SCRAPE SS.LV — ALL MESSAGES ===
async function fetchAllMessages(cookieString, url) {
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

  const dateMatches = [
    ...chatContent.matchAll(/<div class="td15"[^>]*>\s*([^<]+)\s*<\/div>/g),
  ];

  const scriptRegex =
    /<script>_out_text\("([^"]*)",\s*"mail_content_(\d+)"\);<\/script>/g;
  const messageTexts = new Map();
  let scriptMatch;
  while ((scriptMatch = scriptRegex.exec(chatContent)) !== null) {
    messageTexts.set(scriptMatch[2], scriptMatch[1]);
  }

  const messageRegex =
    /<a name="(\d+)"><\/a>\s*<div[^>]*>([\s\S]*?)<td class="?td15"?[^>]*>([^<]+)<\/td>/g;

  const messages = [];
  let match;
  let dateIndex = 0;
  let currentDate = null;

  while ((match = messageRegex.exec(chatContent)) !== null) {
    const messageId = match[1];
    const messageBlock = match[2];
    const time = match[3].trim();

    while (dateIndex < dateMatches.length) {
      const datePos = chatContent.indexOf(dateMatches[dateIndex][0]);
      if (datePos < match.index) {
        currentDate = dateMatches[dateIndex][1].trim();
        dateIndex++;
      } else {
        break;
      }
    }

    const text = messageTexts.get(messageId) || '';
    if (!text) {
      console.log(`   ⚠️  No text for message ID ${messageId}, skipping`);
      continue;
    }

    const isSent = messageBlock.includes('#d3f0f8');

    messages.push({
      id: messageId,
      text,
      time,
      date: currentDate || 'Unknown date',
      direction: isSent ? 'sent' : 'received',
    });
  }

  messages.sort((a, b) => parseInt(a.id) - parseInt(b.id));

  console.log(`   ✓ Found ${messages.length} message(s)`);
  return messages;
}

// === FORMAT NOTE HTML ===
function formatNoteHtml(message) {
  const isSent = message.direction === 'sent';
  const borderColor = isSent ? '#2196F3' : '#4CAF50';
  const emoji = isSent ? '🔵' : '🟢';
  const label = isSent ? 'Sent' : 'Received';

  return `
<div style="border-left: 4px solid ${borderColor}; padding: 6px 12px; margin: 2px 0; font-family: Arial, sans-serif;">
  <div style="font-size: 11px; color: #555; margin-bottom: 4px;">
    ${emoji} <b>${label}</b> &nbsp;|&nbsp; <b>[${message.time} &nbsp; ${message.date}]</b>
  </div>
  <div style="font-size: 13px; color: #222;">
    ${message.text}
  </div>
</div>`.trim();
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

async function getNotesForDeal(dealId) {
  const resp = await pdFetch(`/notes?deal_id=${dealId}`);
  return resp.data || [];
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

  // 1. Load cookies from JSONBin
  const cookieString = await loadCookies();

  // 2. Fetch all messages from SS.LV thread
  const messages = await fetchAllMessages(cookieString, conversationUrl);
  if (messages.length === 0)
    throw new Error('No messages found in conversation');

  const firstMessage = messages[0];
  const dealTitle = `${cfg.dealTitlePrefix} - ${contactPersonFirstName} - "${firstMessage.text.slice(0, 10)}..."`;
  const noteLink = `<div style="font-size:11px; color:#999; margin-bottom:8px;"><b>SS thread:</b> <a href="${conversationUrl}">${conversationUrl}</a></div>`;

  console.log(`\n👤 Contact: ${contactPersonName}`);
  console.log(`📋 Deal title: ${dealTitle}`);

  // 3. Get Pipedrive field keys
  const { sourceChannelKey, sourceCompanyKey } = await getDealFieldKeys();
  if (!sourceChannelKey || !sourceCompanyKey) {
    throw new Error('Could not resolve custom deal field keys');
  }

  // 4. Duplicate check
  let dealId, personId;
  let notesAdded = 0;
  let resultAction = '';

  console.log('\n🔍 Checking for duplicates in Pipedrive...');
  const existingPerson = await findPersonByFirstName(contactPersonFirstName);

  if (existingPerson) {
    console.log(
      `   ✓ Found existing person: ${existingPerson.name} (ID: ${existingPerson.id})`
    );
    personId = existingPerson.id;
    const deals = await getDealsForPerson(personId);
    console.log(`   ✓ Found ${deals.length} deal(s) for this person`);

    for (const deal of deals) {
      const existingNotes = await getNotesForDeal(deal.id);
      const hasFirstMessage = existingNotes.some((n) =>
        (n.content || '').includes(firstMessage.text)
      );

      if (hasFirstMessage) {
        dealId = deal.id;
        console.log(
          `   ✓ Found matching deal (ID: ${dealId}) — checking for missing messages`
        );

        for (const message of messages) {
          const alreadyAdded = existingNotes.some((n) =>
            (n.content || '').includes(message.text)
          );

          if (!alreadyAdded) {
            const noteHtml = formatNoteHtml(message);
            await addNote(dealId, noteHtml);
            console.log(
              `   ✓ Added missing note: "${message.text.substring(0, 40)}..."`
            );
            notesAdded++;
          } else {
            console.log(
              `   ℹ️  Already exists: "${message.text.substring(0, 40)}..."`
            );
          }
        }

        resultAction = 'synced_notes_to_existing_deal';
        break;
      }
    }
  }

  // 5. No matching deal found — create new person + deal + all notes
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

    await addNote(dealId, noteLink);

    for (const message of messages) {
      const noteHtml = formatNoteHtml(message);
      await addNote(dealId, noteHtml);
      console.log(`   ✓ Added note: "${message.text.substring(0, 40)}..."`);
      notesAdded++;
    }

    resultAction = 'created_new_deal';
  }

  console.log(`\n✅ Done: ${resultAction}`);
  console.log(`   Person ID: ${personId}`);
  console.log(`   Deal ID: ${dealId}`);
  console.log(`   Notes added: ${notesAdded}`);
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});
