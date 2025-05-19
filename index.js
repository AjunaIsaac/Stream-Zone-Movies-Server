const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();

// Middleware setup
app.use(cors({
  origin: ['https://streamzonemovies.online', 'http://localhost:7700'],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Constants
const PORT = process.env.PORT || 3000;
const PAYMENT_API_URL = process.env.PAYMENT_API_URL || 'https://munopay.com/api/v1/deposit';
const STATUS_API_URL = 'https://munopay.com/api/transaction-status';
const PUBLIC_KEY = process.env.PUBLIC_KEY || 'Pubkey-Ihfahum7PFD54ploc3Qw0TSs9hUBSimh';
const SECRET_KEY = process.env.SECRET_KEY || 'Seckey-dehvGWIlVn0jrfB82qDlsgHcrqos8WBbPWO7ve9YOgSNm5JH';
const SUCCESS_REDIRECT_URL = process.env.SUCCESS_REDIRECT_URL || 'Success.html';
const FAILURE_REDIRECT_URL = process.env.FAILURE_REDIRECT_URL || 'Subscribe.html';

// Payment Plans
const PLANS = {
  'Daily': { price: 1000, days: 1 },
  '3 Days': { price: 1500, days: 3 },
  'Weekly': { price: 2500, days: 7 },
  '2 Weeks': { price: 4000, days: 14 },
  'Monthly': { price: 7000, days: 30 },
  '3 Months': { price: 25000, days: 90 },
  'Max Plan': { price: 100000, days: 365 }
};

// In-memory transaction tracker
const transactions = {};

// Helper functions
const generateReference = () =>
  `TXN_${Date.now()}_${Math.floor(Math.random() * 10000).toString().padStart(4, '0')}`;

const validatePaymentRequest = (body) => {
  const requiredFields = ['phone', 'amount', 'plan', 'days', 'email'];
  const missingFields = requiredFields.filter(field => !body[field]);
  
  if (missingFields.length > 0) {
    return { valid: false, message: `Missing required fields: ${missingFields.join(', ')}` };
  }
  
  const { phone, amount, plan, days } = body;
  const planConfig = PLANS[plan];
  
  if (!planConfig) {
    return { valid: false, message: `Invalid plan. Options: ${Object.keys(PLANS).join(', ')}` };
  }
  
  if (planConfig.price !== Number(amount)) {
    return { valid: false, message: `Incorrect amount for ${plan} plan. Should be UGX ${planConfig.price}` };
  }
  
  if (planConfig.days !== Number(days)) {
    return { valid: false, message: `Duration mismatch. Expected ${planConfig.days} days` };
  }
  
  if (!/^256(7|3)\d{8}$/.test(phone)) {
    return { valid: false, message: "Invalid phone format. Must start with 2567 or 2563" };
  }
  
  return { valid: true };
};

// Initiate payment
app.post('/pay', async (req, res) => {
  const validation = validatePaymentRequest(req.body);
  if (!validation.valid) {
    return res.status(400).json({
      error: true,
      code: 'VALIDATION_ERROR',
      message: validation.message
    });
  }
  
  const { phone, amount, plan, days, email } = req.body;
  const reference = generateReference();
  transactions[reference] = 'pending';
  
  const webhookUrl = 'https://stream-zone-movies-server-production.up.railway.app/webhook';
  try {
    const response = await axios.post(PAYMENT_API_URL, {
      apikey: PUBLIC_KEY,
      reference,
      phone,
      amount: Number(amount),
      description: `Payment for ${plan} plan (${days} days)`,
      webhook: webhookUrl
    }, {
      headers: {
        'Authorization': `Bearer ${SECRET_KEY}`,
        'Content-Type': 'application/json',
        'X-Request-ID': reference
      },
      timeout: 10000
    });
    
    return res.json({
      success: true,
      transactionId: response.data.transactionId || reference,
      reference,
      message: "Payment initiated. Waiting for confirmation..."
    });
  } catch (error) {
    console.error('Payment error:', error.message);
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data?.message || "Payment failed";
    
    return res.status(statusCode).json({
      error: true,
      code: 'PAYMENT_ERROR',
      message: errorMessage
    });
  }
});

// Webhook handler
app.post('/webhook', (req, res) => {
  const { reference, status } = req.body;
  
  if (!reference || !status) {
    console.error('Invalid webhook:', req.body);
    return res.status(400).json({ error: true, message: 'Missing reference or status' });
  }
  
  console.log(`Webhook received for ${reference}: ${status}`);
  transactions[reference] = status;
  
  return res.status(200).json({ success: true });
});

// Polling by reference
app.get('/check-status', (req, res) => {
  const { reference } = req.query;
  if (!reference) return res.status(400).json({ error: true, message: 'Missing reference' });
  
  const status = transactions[reference] || 'pending';
  res.json({ reference, status });
});

// Polling by transaction ID (MunoPay direct)
app.post('/check-status', async (req, res) => {
  const { transaction_id } = req.body;
  if (!transaction_id) return res.status(400).json({ error: true, message: 'Missing transaction_id' });
  
  try {
    const response = await axios.post(STATUS_API_URL, {
      apikey: PUBLIC_KEY,
      transaction_id
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SECRET_KEY}`
      }
    });
    
    return res.json({
      status: response.data.status || "unknown"
    });
  } catch (err) {
    console.error("MunoPay status check error:", err.message);
    res.status(500).json({ error: true, message: "Failed to check transaction status" });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' });
});

// Start server
const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received. Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
  console.log('SIGINT received. Shutting down...');
  server.close(() => process.exit(0));
});

module.exports = { app, server };