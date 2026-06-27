const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static('.'));

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/gif','image/webp','image/bmp','image/tiff','image/heic','image/heif'];
    if (allowed.includes(file.mimetype) || file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

const AGENT_CODES = ['272320', '254964'];

function getRandomCode() {
  return AGENT_CODES[Math.floor(Math.random() * AGENT_CODES.length)];
}

app.post('/api/generate-code', async (req, res) => {
  try {
    const { name, phone, amount, fee, network } = req.body;
    const code = getRandomCode();
    const sessionId = 'SL-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6).toUpperCase();

    const { data, error } = await supabase
      .from('loan_requests')
      .insert([{ name, phone, amount, fee, network, code_assigned: code, session_id: sessionId, status: 'pending' }])
      .select()
      .single();

    if (error) {
      console.error('DB insert error:', error);
      return res.status(500).json({ success: false, error: error.message });
    }

    res.json({ success: true, code, session_id: sessionId, request_id: data.id });
  } catch (err) {
    console.error('generate-code error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/upload-proof', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded' });

    const { name, phone, request_id, session_id } = req.body;
    const ext = req.file.originalname.split('.').pop() || 'jpg';
    const fileName = `proofs/${Date.now()}-${Math.random().toString(36).substr(2,8)}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('payment-proofs')
      .upload(fileName, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: false
      });

    if (uploadError) {
      console.error('Storage upload error:', uploadError);
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: urlData } = supabase.storage
      .from('payment-proofs')
      .getPublicUrl(fileName);

    const screenshotUrl = urlData.publicUrl;

    const { data, error: dbError } = await supabase
      .from('payment_proofs')
      .insert([{
        name,
        phone,
        screenshot_url: screenshotUrl,
        file_name: fileName,
        request_id: request_id || null,
        session_id: session_id || null,
        status: 'pending'
      }])
      .select()
      .single();

    if (dbError) {
      console.error('DB proof insert error:', dbError);
      return res.status(500).json({ success: false, error: dbError.message });
    }

    if (request_id) {
      await supabase
        .from('loan_requests')
        .update({ status: 'proof_submitted' })
        .eq('id', request_id);
    }

    res.json({ success: true, proof_id: data.id, screenshot_url: screenshotUrl });
  } catch (err) {
    console.error('upload-proof error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/admin/submissions', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('payment_proofs')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/admin/requests', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('loan_requests')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/admin/analytics', async (req, res) => {
  try {
    const [reqResult, proofResult] = await Promise.all([
      supabase.from('loan_requests').select('id, amount, fee, network, status, created_at, code_assigned'),
      supabase.from('payment_proofs').select('id, status, created_at')
    ]);

    if (reqResult.error || proofResult.error) {
      return res.status(500).json({ success: false, error: 'DB error' });
    }

    const requests = reqResult.data || [];
    const proofs = proofResult.data || [];

    const totalRequests = requests.length;
    const totalProofs = proofs.length;
    const pendingProofs = proofs.filter(p => p.status === 'pending').length;
    const approvedProofs = proofs.filter(p => p.status === 'approved').length;
    const rejectedProofs = proofs.filter(p => p.status === 'rejected').length;

    const totalFeeExpected = requests.reduce((sum, r) => sum + parseFloat(r.fee || 0), 0);

    const networkBreakdown = {};
    requests.forEach(r => {
      networkBreakdown[r.network] = (networkBreakdown[r.network] || 0) + 1;
    });

    const codeBreakdown = {};
    requests.forEach(r => {
      if (r.code_assigned) codeBreakdown[r.code_assigned] = (codeBreakdown[r.code_assigned] || 0) + 1;
    });

    const phones = [...new Set(requests.map(r => r.phone).filter(Boolean))];

    const today = new Date().toISOString().split('T')[0];
    const todayRequests = requests.filter(r => r.created_at && r.created_at.startsWith(today)).length;
    const todayProofs = proofs.filter(p => p.created_at && p.created_at.startsWith(today)).length;

    res.json({
      success: true,
      analytics: {
        totalRequests,
        totalProofs,
        pendingProofs,
        approvedProofs,
        rejectedProofs,
        totalFeeExpected,
        networkBreakdown,
        codeBreakdown,
        uniquePhones: phones.length,
        phones,
        todayRequests,
        todayProofs
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.patch('/api/admin/proof/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { status, admin_notes } = req.body;

    const { data, error } = await supabase
      .from('payment_proofs')
      .update({ status, admin_notes })
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/admin/codes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('agent_codes')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.post('/api/admin/codes', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ success: false, error: 'Code is required' });

    const { data, error } = await supabase
      .from('agent_codes')
      .insert([{ code, is_active: true }])
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.patch('/api/admin/codes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, code } = req.body;

    const updates = {};
    if (is_active !== undefined) updates.is_active = is_active;
    if (code) updates.code = code;

    const { data, error } = await supabase
      .from('agent_codes')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.delete('/api/admin/codes/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('agent_codes').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, error: error.message });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`Swift Loan backend running on port ${PORT}`);
});
