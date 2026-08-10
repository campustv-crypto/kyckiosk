// scripts/update-playlist.js
const {google} = require('googleapis');
const fs = require('fs').promises;
const path = require('path');

function parseDate(s) { return new Date(s + 'T00:00:00'); }

function tryParseWeekdayFromName(name) {
  // Try several patterns to extract weekday (1..5)
  // Examples of folder names supported:
  // "1.星期一_宗教", "1 星期一", "星期一", "Mon", "Monday", "1"
  if (!name) return null;
  const lower = name.trim().toLowerCase();

  // Chinese weekdays
  if (/星期.?一/.test(lower) || /星期一/.test(lower) || /周.?一/.test(lower)) return 1;
  if (/星期.?二/.test(lower) || /星期二/.test(lower) || /周.?二/.test(lower)) return 2;
  if (/星期.?三/.test(lower) || /星期三/.test(lower) || /周.?三/.test(lower)) return 3;
  if (/星期.?四/.test(lower) || /星期四/.test(lower) || /周.?四/.test(lower)) return 4;
  if (/星期.?五/.test(lower) || /星期五/.test(lower) || /周.?五/.test(lower)) return 5;

  // Leading number (e.g. "1.", "1 ", "1_")
  const m = lower.match(/^\s*(\d)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >=1 && n <=5) return n;
  }

  // English weekdays
  if (/\bmonday\b/.test(lower) || /\bmon\b/.test(lower)) return 1;
  if (/\btuesday\b/.test(lower) || /\btue\b/.test(lower)) return 2;
  if (/\bwednesday\b/.test(lower) || /\bwed\b/.test(lower)) return 3;
  if (/\bthursday\b/.test(lower) || /\bthu\b/.test(lower)) return 4;
  if (/\bfriday\b/.test(lower) || /\bfri\b/.test(lower)) return 5;

  return null;
}

async function detectWeekdayFolders(auth, parentFolderId) {
  const drive = google.drive({version:'v3', auth});
  const q = `'${parentFolderId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed=false`;
  const folders = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id,name)',
      pageToken,
      pageSize: 100,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    (res.data.files || []).forEach(f => folders.push(f));
    pageToken = res.data.nextPageToken;
  } while(pageToken);

  // Map weekday -> folderId
  const mapping = {};
  for (const f of folders) {
    const wd = tryParseWeekdayFromName(f.name);
    if (wd && !mapping[String(wd)]) {
      mapping[String(wd)] = f.id;
    }
  }
  return { mapping, folders };
}

async function listFilesInFolder(auth, folderId) {
  const drive = google.drive({version:'v3', auth});
  const q = `'${folderId}' in parents and trashed=false`;
  const files = [];
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q,
      fields: 'nextPageToken, files(id,name,thumbnailLink,description,mimeType)',
      pageToken,
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });
    (res.data.files || []).forEach(f => files.push(f));
    pageToken = res.data.nextPageToken;
  } while(pageToken);
  return files;
}

async function pickFolderId(schedule, today) {
  // If schedule.json exists and contains explicit mapping, prefer that
  if (Array.isArray(schedule) && schedule.length) {
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
  }
  return null;
}

async function main() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const parentFolderId = process.env.DRIVE_PARENT_FOLDER_ID || process.env.DRIVE_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REFRESH_TOKEN in env');
  }

  // Load schedule.json if present
  let schedule = null;
  try {
    const scheduleRaw = await fs.readFile(path.join(__dirname, '..', 'schedule.json'), 'utf8');
    schedule = JSON.parse(scheduleRaw);
  } catch (e) {
    // not present or invalid -> continue
    schedule = null;
  }

  const today = new Date();

  // First, try explicit schedule.json
  let folderId = await pickFolderId(schedule, today);

  const oAuth2 = new google.auth.OAuth2(clientId, clientSecret);
  oAuth2.setCredentials({refresh_token: refreshToken});

  if (!folderId && parentFolderId) {
    console.log('No explicit schedule match; detecting child folders under parent', parentFolderId);
    const { mapping, folders } = await detectWeekdayFolders(oAuth2, parentFolderId);
    console.log('Detected weekday folder mapping:', mapping);
    const wd = today.getDay();
    folderId = mapping[String(wd)] || null;

    if (!folderId) {
      console.log('No child folder matched today by weekday naming. Available child folders:');
      folders.forEach(f => console.log(` - ${f.name} -> ${f.id}`));
    }
  }

  if (!folderId) {
    console.log('No folderId matched for today. Exiting without changes.');
    return;
  }

  console.log('Using folderId:', folderId);
  const files = await listFilesInFolder(oAuth2, folderId);

  // Filter to video-like files if mimeType available, else include common video extensions
  const playlist = files
    .filter(f => {
      if (f.mimeType) return f.mimeType.startsWith('video/');
      // fallback: include (will be handled by Drive preview as well)
      return true;
    })
    .map(f => ({
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
