// server.js
require('dotenv').config();
const express = require('express');
const PDFDocument = require('pdfkit');
const stream = require('stream');

// If you use Node <18 uncomment node-fetch import:
// const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json({ limit: '20mb' })); // large payloads for long text

// CORS (allow your GitHub Pages origin or * for testing)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // restrict this in production
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY in environment');
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TEXT_LENGTH = Number(process.env.MAX_TEXT_LENGTH) || 250_000;
const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.send('Backend is working'));

/**
 * POST /summarize
 * Body: { instruction?: string, text: string }
 * Returns: {
 *   summary: string,
 *   pdfBase64: string,    // base64 encoding of the PDF bytes
 *   docBase64: string,    // base64 encoding of a .doc (HTML) file
 *   raw: object           // raw OpenAI response
 * }
 */
app.post('/summarize', async (req, res) => {
  try {
    const { instruction, text } = req.body || {};

    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Missing "text" in request body' });
    }

    // Truncate very long input to avoid huge token usage
    let userText = text;
    if (userText.length > MAX_TEXT_LENGTH) {
      console.warn(`Truncating input from ${userText.length} to ${MAX_TEXT_LENGTH} characters`);
      userText = userText.slice(0, MAX_TEXT_LENGTH);
    }

    const defaultInstruction = `You are an expert ergonomics assessor. Using the extracted content from two reports (Report 1 and Report 2), produce ONE combined and harmonized task table in Markdown format. Output only a pipe-separated Markdown table with headers: "No" | "Tasks and Description" | "Workers/Activities". Merge duplicated steps, bold critical actions, preserve numeric weights (e.g., "25 kg"), and harmonize wording. No extra commentary.`;

    const systemContent = (instruction && instruction.trim().length) ? instruction : defaultInstruction;

    const payload = {
      model: MODEL,
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: userText }
      ],
      temperature: 0.2,
      max_tokens: 2000
    };

    const openaiResp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!openaiResp.ok) {
      const txt = await openaiResp.text().catch(()=>null);
      console.error('OpenAI error', openaiResp.status, txt);
      return res.status(502).json({ error: 'OpenAI API error', status: openaiResp.status, detail: txt });
    }

    const openaiData = await openaiResp.json();
    const assistantMsg = openaiData.choices?.[0]?.message?.content ?? openaiData.choices?.[0]?.text ?? '';

    // === Create PDF from assistantMsg (simple text PDF) ===
    const pdfBuffer = await createPdfBufferFromText(assistantMsg);

    // === Create Word-compatible .doc (HTML-in-doc) ===
    const docHtml = createDocHtmlFromText(assistantMsg);
    const docBuffer = Buffer.from(docHtml, 'utf8'); // .doc file containing HTML is accepted by Word

    // Return base64s so frontend can download easily
    const pdfBase64 = pdfBuffer.toString('base64');
    const docBase64 = docBuffer.toString('base64');

    return res.json({
      summary: assistantMsg,
      pdfBase64,
      docBase64,
      raw: openaiData
    });

  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Server started on port ${PORT}`));

// ----------------- helpers -----------------

/**
 * Create a PDF (Buffer) from text using pdfkit.
 * The function writes the text and preserves newlines.
 */
function createPdfBufferFromText(text) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve(buf);
      });

      // Simple styling: title + monospace body
      doc.fontSize(14).text('Merged Task Table Summary', { align: 'center' });
      doc.moveDown(1);
      doc.font('Times-Roman');
      doc.fontSize(10);

      // We want to preserve Markdown table formatting; write as preformatted text
      const lines = text.split(/\r?\n/);
      const pageWidth = 72 * 8; // approx chars per line? pdfkit will wrap anyway
      for (const line of lines) {
        doc.text(line, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      }

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Create a simple HTML doc that Word can open.
 * We wrap the text (markdown) in a <pre> to preserve the table formatting.
 */
function createDocHtmlFromText(text) {
  // Minimal HTML wrapper
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Merged Task Table Summary</title>
</head>
<body>
  <h2>Merged Task Table Summary</h2>
  <pre style="font-family: Arial, sans-serif; white-space: pre-wrap;">${escapeHtml(text)}</pre>
</body>
</html>`;
  return html;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, (m) => {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]);
  });
}
