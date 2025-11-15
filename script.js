// script.js
// Move your inline JS here. Make sure analysis.html includes: <script src="script.js"></script>

// ---- CONFIG ----
// Replace with your Render backend URL (no trailing slash)
const serverUrl = "https://pdf-summarize-3go5.onrender.com"; // <- CHANGE this to your Render URL

const OAUTH_CLIENT_ID = '365509237422-i3lq53klim7uk6ub0ndh1vag17078lkm.apps.googleusercontent.com';
const API_KEY = 'AIzaSyCQMc9sbjDLsYsSzrpdGyyXUH4q0uCb5UE';
const TARGET_FOLDER_ID = '1uheM2o-LZsoslFv59ccQox4PUjAL0PjS';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

// pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://unpkg.com/pdfjs-dist@3.6.172/build/pdf.worker.min.js';

// UI elements (assumes these IDs exist in analysis.html)
const authBtn = document.getElementById('authBtn');
const signoutBtn = document.getElementById('signoutBtn');
const statusEl = document.getElementById('status');
const filesList = document.getElementById('filesList');
const combinedTextEl = document.getElementById('combinedText');
const imagesDiv = document.getElementById('images');

// result UI
const resultBtn = document.createElement('button');
resultBtn.id = 'resultBtn';
resultBtn.textContent = 'Get Result (ChatGPT)';
resultBtn.style.marginTop = '10px';

const resultOut = document.createElement('textarea');
resultOut.id = 'resultOut';
resultOut.placeholder = 'Summary will appear here...';
resultOut.style.width = '100%';
resultOut.style.height = '220px';
resultOut.style.marginTop = '8px';

// Insert the result UI just after the combinedText textarea
combinedTextEl.parentNode.insertBefore(resultBtn, combinedTextEl.nextSibling);
combinedTextEl.parentNode.insertBefore(resultOut, resultBtn.nextSibling);

let gapiInited = false;
let tokenClient;
let accessToken = null;

// gapi load helper
function gapiLoaded() {
  gapi.load('client', initializeGapiClient);
}

async function initializeGapiClient() {
  try {
    await gapi.client.init({
      apiKey: API_KEY || undefined,
      discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"]
    });
    gapiInited = true;
    statusEl.textContent = 'Google API client initialized.';
  } catch (err) {
    console.error('gapi client init error', err);
    statusEl.textContent = 'Error initializing Google API client: ' + err.message;
  }
}

function waitForGoogleThenInitTokenClient() {
  return new Promise((resolve, reject) => {
    const maxWaitMs = 5000;
    const start = Date.now();
    (function check() {
      if (window.google && google.accounts && google.accounts.oauth2 && google.accounts.oauth2.initTokenClient) {
        initTokenClient();
        resolve();
      } else if (Date.now() - start > maxWaitMs) {
        reject(new Error('Google Identity Services did not load in time.'));
      } else {
        setTimeout(check, 100);
      }
    })();
  });
}

function initTokenClient() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: OAUTH_CLIENT_ID,
    scope: SCOPES,
    callback: (resp) => {
      if (resp.error) {
        console.error('Token error', resp);
        statusEl.textContent = 'Auth error: ' + resp.error;
        return;
      }
      accessToken = resp.access_token;
      statusEl.textContent = 'Signed in. Access token ready.';
      signoutBtn.style.display = 'inline-block';
      authBtn.style.display = 'none';
      listPdfFilesInFolder();
    }
  });
}

async function signOut() {
  if (!accessToken) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${accessToken}`, { method: 'POST' });
  } catch(e){ console.warn('revoke failed', e); }
  accessToken = null;
  statusEl.textContent = 'Signed out.';
  signoutBtn.style.display = 'none';
  authBtn.style.display = 'inline-block';
  filesList.innerHTML = '';
  combinedTextEl.value = '';
  imagesDiv.innerHTML = '';
  resultOut.value = '';
}

async function listPdfFilesInFolder() {
  if (!gapiInited) {
    statusEl.textContent = 'gapi not initialized yet.';
    return;
  }
  statusEl.textContent = 'Listing PDF files in folder...';
  filesList.innerHTML = '';
  combinedTextEl.value = '';
  imagesDiv.innerHTML = '';
  resultOut.value = '';

  const q = `'${TARGET_FOLDER_ID}' in parents and mimeType='application/pdf' and trashed=false`;
  try {
    const resp = await gapi.client.drive.files.list({
      q,
      fields: 'files(id,name,mimeType,size),nextPageToken',
      pageSize: 100
    });
    const files = resp.result.files || [];
    if (!files.length) {
      statusEl.textContent = 'No PDF files found in the folder.';
      return;
    }
    statusEl.textContent = `Found ${files.length} PDF(s). Downloading and parsing...`;
    let allText = '';
    for (const f of files) {
      const entry = document.createElement('div');
      entry.className = 'file-entry';
      entry.innerHTML = `<strong>${escapeHtml(f.name)}</strong> — ${f.size ? f.size + ' bytes' : ''}`;
      filesList.appendChild(entry);

      try {
        const arrayBuffer = await downloadFileAsArrayBuffer(f.id);
        const r = await extractPdfTextAndThumbnails(arrayBuffer, f.name);
        allText += r.text + '\n\n';
        r.thumbs.forEach(t => {
          const img = document.createElement('img');
          img.src = t.dataUrl;
          img.className = 'thumb';
          img.title = t.label;
          imagesDiv.appendChild(img);
        });
        entry.appendChild(document.createElement('div')).innerText = 'Parsed OK';
      } catch (err) {
        console.error('Error processing file', f.name, err);
        entry.appendChild(document.createElement('div')).innerText = 'Error: ' + (err.message || err);
      }
    }
    combinedTextEl.value = allText || '(no text extracted)';
    statusEl.textContent = 'All files processed.';
  } catch (err) {
    console.error('drive.files.list error', err);
    statusEl.textContent = 'Error listing files: ' + (err.result?.error?.message || err.message || err);
  }
}

async function downloadFileAsArrayBuffer(fileId) {
  if (!accessToken) throw new Error('No access token. Authorize first.');
  const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
  const resp = await fetch(url, {
    headers: { Authorization: 'Bearer ' + accessToken }
  });
  if (!resp.ok) throw new Error('Download failed: ' + resp.status + ' ' + resp.statusText);
  return await resp.arrayBuffer();
}

async function extractPdfTextAndThumbnails(arrayBuffer, label) {
  const loadingTask = pdfjsLib.getDocument({data: arrayBuffer});
  const pdf = await loadingTask.promise;
  let combinedText = '';
  const thumbs = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const txtContent = await page.getTextContent();
    const pageText = txtContent.items.map(i => i.str).join(' ');
    combinedText += `\n\n--- ${label} — Page ${p} ---\n` + pageText;

    const viewport = page.getViewport({scale: 1.2});
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({canvasContext: ctx, viewport}).promise;
    thumbs.push({dataUrl: canvas.toDataURL('image/jpeg', 0.8), label: `${label} - p${p}`});
  }
  return {text: combinedText, thumbs};
}

function escapeHtml(s) {
  return s ? s.replace(/[&<>"']/g, function(m){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]); }) : '';
}

// ---------- RESULT (ChatGPT) integration ----------
resultBtn.addEventListener('click', async () => {
  const text = combinedTextEl.value || '';
  if (!text || text.trim().length < 20) {
    alert('No extracted text available. Make sure PDFs are parsed first.');
    return;
  }

  resultBtn.disabled = true;
  resultBtn.textContent = 'Working...';
  resultOut.value = '';

  try {
    const resp = await fetch(serverUrl + '/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(err || resp.statusText);
    }

    const data = await resp.json();
    // server returns summary in data.summary (or data.result depending on your server)
    resultOut.value = data.summary || data.result || '(no result)';
  } catch (err) {
    console.error(err);
    resultOut.value = 'Error: ' + err.message;
  } finally {
    resultBtn.disabled = false;
    resultBtn.textContent = 'Get Result (ChatGPT)';
  }
});

// ---------- UI wiring for auth buttons ----------
authBtn.addEventListener('click', async () => {
  if (!gapiInited) {
    statusEl.textContent = 'Loading Google API...';
    try {
      await new Promise(resolve => { gapi.load('client', resolve); });
      await initializeGapiClient();
      statusEl.textContent = 'Google API loaded.';
    } catch(e) {
      console.error(e);
      statusEl.textContent = 'Failed to load Google API: ' + e.message;
      return;
    }
  }
  try {
    await waitForGoogleThenInitTokenClient();
  } catch (e) {
    statusEl.textContent = 'Google Identity Services not ready: ' + e.message;
    return;
  }
  tokenClient.requestAccessToken();
});

signoutBtn.addEventListener('click', signOut);

// Boot ready
window.onload = () => {
  if (typeof gapi === 'undefined') {
    statusEl.textContent = 'Google API script not loaded.';
  } else {
    gapiLoaded();
    statusEl.textContent = 'Ready. Click "Sign in & load PDFs".';
  }
};
