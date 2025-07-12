const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const csv = require('csv-parser');
const OpenAI = require('openai');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    const uploadPath = path.join(__dirname, 'uploads');
    await fs.ensureDir(uploadPath);
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ storage });

// Configure nodemailer
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST,
  port: process.env.EMAIL_PORT,
  secure: false,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// File upload endpoint
app.post('/upload', upload.array('files', 10), async (req, res) => {
  try {
    const files = req.files;
    const processedFiles = [];

    for (const file of files) {
      const filePath = file.path;
      const fileType = path.extname(file.originalname).toLowerCase();
      
      if (fileType === '.txt') {
        const content = await fs.readFile(filePath, 'utf-8');
        processedFiles.push({
          name: file.originalname,
          type: 'transcript',
          content: content
        });
      } else if (fileType === '.csv') {
        const contacts = await parseCSV(filePath);
        processedFiles.push({
          name: file.originalname,
          type: 'contacts',
          content: contacts
        });
      }
    }

    res.json({ success: true, files: processedFiles });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Generate summary endpoint
app.post('/generate-summary', async (req, res) => {
  try {
    const { transcript } = req.body;
    
    const prompt = `Please analyze the following meeting transcript and provide:
    1. An executive summary (2-3 paragraphs)
    2. A list of action items with assigned owners
    
    Meeting Transcript:
    ${transcript}
    
    Format the response as JSON with the following structure:
    {
      "summary": "executive summary text",
      "actionItems": [
        {
          "item": "action item description",
          "owner": "person responsible",
          "timeline": "estimated timeline if mentioned"
        }
      ]
    }`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4-turbo",  // This supports JSON mode
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that analyzes meeting transcripts and creates concise summaries and action items."
        },
        {
          role: "user",
          content: prompt
        }
      ],
      response_format: { type: "json_object" }
    });

    const result = JSON.parse(completion.choices[0].message.content);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Summary generation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send email endpoint
app.post('/send-emails', async (req, res) => {
  try {
    const { recipients, summary, actionItems } = req.body;
    
    const emailContent = formatEmailContent(summary, actionItems);
    
    for (const recipient of recipients) {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM,
        to: recipient.email,
        subject: 'Meeting Summary and Action Items',
        html: emailContent
      });
    }
    
    res.json({ success: true, message: 'Emails sent successfully' });
  } catch (error) {
    console.error('Email error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Helper functions
function parseCSV(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
}

function formatEmailContent(summary, actionItems) {
  let html = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <h2>Meeting Summary</h2>
        <div style="background-color: #f4f4f4; padding: 15px; border-radius: 5px;">
          ${summary.replace(/\n/g, '<br>')}
        </div>
        
        <h2>Action Items</h2>
        <table style="width: 100%; border-collapse: collapse; margin-top: 10px;">
          <tr style="background-color: #e9e9e9;">
            <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Action Item</th>
            <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Owner</th>
            <th style="padding: 10px; text-align: left; border: 1px solid #ddd;">Timeline</th>
          </tr>`;
  
  actionItems.forEach(item => {
    html += `
          <tr>
            <td style="padding: 10px; border: 1px solid #ddd;">${item.item}</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${item.owner}</td>
            <td style="padding: 10px; border: 1px solid #ddd;">${item.timeline || 'Not specified'}</td>
          </tr>`;
  });
  
  html += `
        </table>
      </body>
    </html>`;
  
  return html;
}

// Start server
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});