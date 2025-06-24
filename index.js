const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PESAPAL_URL = "https://pay.pesapal.com/v3/api";
let token = null;

// Get Token
async function getToken() {
  const res = await axios.post(`${PESAPAL_URL}/Auth/RequestToken`, {
    consumer_key: process.env.PESAPAL_KEY,
    consumer_secret: process.env.PESAPAL_SECRET
  });
  token = res.data.token;
  return token;
}

// Payment Endpoint
app.post('/pay', async (req, res) => {
  try {
    if (!token) await getToken();

    const order = {
      id: `txn_${Date.now()}`,
      currency: "UGX",
      amount: req.body.amount || 1000,
      description: "Movie subscription",
      callback_url: "https://yourdomain.com/payment-success",
      billing_address: {
        email_address: req.body.email || "test@example.com",
        phone_number: req.body.phone || "256700000000",
        first_name: req.body.firstName || "John",
        last_name: req.body.lastName || "Doe"
      }
    };

    const response = await axios.post(`${PESAPAL_URL}/Transactions/SubmitOrderRequest`, order, {
      headers: { Authorization: `Bearer ${token}` }
    });

    res.json({ redirect_url: response.data.redirect_url });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send("Payment failed");
  }
});

app.get('/', (req, res) => res.send("Pesapal API running"));
app.listen(process.env.PORT || 3000, () => console.log("Server running"));
