'use strict';
/**
 * saves.js - Save file upload/download routes.
 * Mirrors the Python saves.py + auth.py endpoints.
 */

const fs     = require('fs');
const path   = require('path');
const express = require('express');
const multer  = require('multer');

const SAVES_DIR = 'saves';
if (!fs.existsSync(SAVES_DIR)) fs.mkdirSync(SAVES_DIR, { recursive: true });

const router = express.Router();

// multer stores the upload in memory so we can write it ourselves
const upload = multer({ storage: multer.memoryStorage() });

/** GET /token/get?id=xxx  - returns a fake premium profile */
router.get('/token/get', (req, res) => {
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id required' });
  res.json({ token: id, premium: true, email: 'local@user' });
});

/** POST /saves/upload  (multipart: token, fileName, file) */
router.post('/saves/upload', upload.single('file'), (req, res) => {
  const { token, fileName } = req.body;
  if (!token || !fileName || !req.file) {
    return res.status(400).json({ error: 'token, fileName and file are required' });
  }

  const safeFilename = path.basename(fileName);
  const savePath = path.join(SAVES_DIR, `${token}_${safeFilename}`);

  fs.writeFile(savePath, req.file.buffer, (err) => {
    if (err) return res.status(500).json({ error: 'Failed to save file' });
    res.json({ success: true });
  });
});

/** GET /saves/download/:token/:fileName */
router.get('/saves/download/:token/:fileName', (req, res) => {
  const { token, fileName } = req.params;
  const safeFilename = path.basename(fileName);
  const savePath = path.join(SAVES_DIR, `${token}_${safeFilename}`);

  if (!fs.existsSync(savePath)) {
    return res.status(404).json({ error: 'File not found' });
  }
  res.download(savePath, safeFilename);
});

module.exports = router;
