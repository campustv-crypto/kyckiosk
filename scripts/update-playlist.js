// scripts/update-playlist.js
const {google} = require('googleapis');
const fs = require('fs').promises;
const path = require('path');

function parseDate(s) { return new Date(s + 'T00:00:00'); }

async function pickFolderId(schedule, today) {
  const ymd = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  for (const rule of schedule) {
    const start = parseDate(rule.start);
    const end = parseDate(rule.end);
    if (ymd >= start && ymd <= end) {
      const wd = today.getDay(); // 0=Sun,1=Mon...
      const id = rule.by_weekday && rule.by_weekday[String(wd)];
      if (id) return id;
    }
  }
  return null;
}

async function listFilesInFolder(auth, folderId) {
  const drive = google.drive({version:'v3', auth});
  const q = `'${folderId}' in parents and mimeType contains 'video/' and trashed=false`;
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id,name,thumbnailLink,description,mimeType)',
      pageToken,
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    (res.data.files || []).forEach(f => files.push(f));
    pageToken = res.data.nextPageToken;
  } while(pageToken);
  return files;
}

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN in env');
  }

  const scheduleRaw = await fs.readFile(path.join(__dirname, '..', 'schedule.json'), 'utf8');
  const schedule = JSON.parse(scheduleRaw);

  // Use local timezone from workflow via TZ env var
  const today = new Date();
  const folderId = await pickFolderId(schedule, today);
  if (!folderId) {
    console.log('No folderId matched for today. Exiting without changes.');
    return;
  }

  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2.setCredentials({refresh_token: refreshToken});

  const files = await listFilesInFolder(oAuth2, folderId);
  const playlist = files.map(f => ({
    id: f.id,
    title: f.name,
    description: f.description || '',
    thumbnail: f.thumbnailLink || ''
  }));

  await fs.writeFile(path.join(__dirname, '..', 'playlist.json'), JSON.stringify(playlist, null, 2), 'utf8');
  console.log(`Wrote playlist.json with ${playlist.length} items from folder ${folderId}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
