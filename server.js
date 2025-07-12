const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs-extra');
const csv = require('csv-parser');
const OpenAI = require('openai');
const { Resend } = require('resend');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Resend
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

if (!resend) {
  console.warn('WARNING: RESEND_API_KEY not found. Email features will not work.');
}

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

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Serve logo file specifically
app.get('/sap_logo.jpg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sap_logo.jpg'));
});

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
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that analyzes meeting transcripts and creates concise summaries and action items. Always respond with valid JSON."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    const result = JSON.parse(completion.choices[0].message.content);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Summary generation error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Send email endpoint using Resend
app.post('/send-emails', async (req, res) => {
  try {
    if (!resend) {
      return res.status(500).json({ 
        success: false, 
        error: 'Resend API key not configured. Please add RESEND_API_KEY to environment variables.' 
      });
    }

    const { recipients, summary, actionItems } = req.body;
    
    // Generate HTML email content with recipients list
    const emailContent = formatEmailContent(summary, actionItems, recipients);
    
    // Always send to markgleasonwork@gmail.com for testing
    const testEmail = 'markgleasonwork@gmail.com';
    
    const { data, error } = await resend.emails.send({
      from: 'Meeting Transcript Utility <markgleasonwork@gmail.com>',
      to: testEmail,
      subject: 'Meeting Summary and Action Items',
      html: emailContent
    });
    
    if (error) {
      console.error('Resend error:', error);
      return res.status(400).json({ success: false, error: error.message });
    }
    
    console.log('Email sent successfully to test address:', data);
    res.json({ 
      success: true, 
      message: `Email sent to ${testEmail} with intended recipients listed in the email body`, 
      data 
    });
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

function formatEmailContent(summary, actionItems, recipients = []) {
  // Format recipients list
  const recipientsList = recipients.length > 0 
    ? recipients.map(r => typeof r === 'string' ? r : r.email || r).join(', ')
    : 'No recipients selected';

  let html = `
    <html>
      <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="background-color: #fffbcc; padding: 15px; border-radius: 5px; margin-bottom: 20px; border: 1px solid #f5e642;">
          <strong>📧 Intended Recipients:</strong> ${recipientsList}<br>
          <em style="color: #666; font-size: 14px;">Note: This test email was sent only to markgleasonwork@gmail.com</em>
        </div>
        
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