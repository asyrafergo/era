// server.js
require('dotenv').config();
const express = require('express');
const MarkdownIt = require('markdown-it');
const htmlDocx = require('html-docx-js'); // converts HTML -> .docx (buffer)
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json({ limit: '25mb' }));

// CORS - restrict in production to your GitHub Pages origin
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const MAX_TEXT_LENGTH = Number(process.env.MAX_TEXT_LENGTH) || 250_000;
const PORT = process.env.PORT || 10000;

const md = new MarkdownIt({ html: true, linkify: true });

// Simple CSS for nice table rendering in PDF/Word
const TABLE_CSS = `
  <style>
    body { font-family: "Helvetica", Arial, sans-serif; margin: 24px; color: #222; }
    h1 { text-align: center; font-size: 18px; margin-bottom: 12px; }
    table { border-collapse: collapse; width: 100%; font-size: 12px; }
    table, th, td { border: 1px solid #444; }
    th, td { padding: 8px 10px; vertical-align: top; }
    th { background: #f2f2f2; text-align: left; }
    td pre { margin: 0; white-space: pre-wrap; font-family: inherit; }
    ul { margin: 0; padding-left: 18px; }
  </style>
`;

/**
 * Convert Markdown to full HTML with CSS wrapper (title + content).
 * Expects the markdown input to contain the table (pipe format)
 */
function markdownToFullHtml(markdown, title = "Merged Task Table Summary") {
  const htmlTable = md.render(markdown); // this will render the markdown table into <table>...</table>
  // Wrap and include CSS
  return `<!doctype html><html><head><meta charset="utf-8" />${TABLE_CSS}</head><body><h1>${escapeHtml(title)}</h1>${htmlTable}</body></html>`;
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, m =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

app.get('/', (req, res) => res.send('Backend is working - PDF/Doc generator'));

/**
 * POST /summarize
 * Body: { instruction?: string, text: string }
 * Response: { summary: string, pdfBase64: string, docxBase64: string, raw: any }
 */
app.post('/summarize', async (req, res) => {
  try {
    const { instruction, text } = req.body || {};
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Missing "text" in body' });
    }

    // Truncate if extremely large
    let userText = text;
    if (userText.length > MAX_TEXT_LENGTH) {
      console.warn('Truncating input text: length', userText.length);
      userText = userText.slice(0, MAX_TEXT_LENGTH);
    }

    // Build messages for OpenAI
    const systemContent = (instruction && instruction.trim().length) ? instruction : `You are an expert ergonomics assessor. Produce ONE combined and harmonized task table in Markdown format with headers: "No" | "Tasks and Description" | "Workers/Activities". Output only the Markdown table.`;
    const messages = [
      { role: 'system', content: systemContent },
      { role: 'user', content: userText }
    ];

    // Call OpenAI Chat Completions
    const payload = {
      model: MODEL,
      messages,
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
    const summaryMarkdown = assistantMsg.trim();

    // Convert markdown -> HTML (with CSS)
    const html = markdownToFullHtml(summaryMarkdown);

    // === Create PDF using Puppeteer ===
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      headless: 'new'
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    // A4 format
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '20mm', bottom: '20mm', left: '12mm', right: '12mm' }
    });
    await browser.close();

    // === Create docx (Word) from HTML (html-docx-js) ===
    // html-docx-js expects HTML string; it returns a Buffer when using asBuffer
    const docxBuffer = htmlDocx.asBuffer(html);

    // Return base64 encoded files + summary
    const pdfBase64 = pdfBuffer.toString('base64');
    const docxBase64 = docxBuffer.toString('base64');

    return res.json({
      summary: summaryMarkdown,
      pdfBase64,
      docxBase64,
      raw: openaiData
    });

  } catch (err) {
    console.error('Server error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
