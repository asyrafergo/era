require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY');
  process.exit(1);
}

const PORT = process.env.PORT || 10000;

app.get('/', (req, res) => res.send('Backend is working'));

app.post('/summarize', async (req, res) => {
  try {
    const text = req.body.text || '';

    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Summarize and compare reports." },
          { role: "user", content: text }
        ]
      })
    });

    const data = await resp.json();
    res.json({ summary: data.choices?.[0]?.message?.content || "No output" });
  } catch (err) {
    res.status(500).json({ error: err.toString() });
  }
});

app.listen(PORT, () => console.log("Server started on port " + PORT));
