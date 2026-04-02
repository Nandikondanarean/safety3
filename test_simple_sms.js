require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

async function testSms() {
  console.log('🚀 Starting Test SMS...');
  console.log('Using Twilio Number:', process.env.TWILIO_PHONE_NUMBER);
  
  try {
    const message = await client.messages.create({
      body: '🚨 TEST SOS: This is a test from the SafeHer app. If you received this, SMS alerts are WORKING!',
      from: process.env.TWILIO_PHONE_NUMBER,
      to: '+919441568939' // Testing with your saved contact: ram
    });

    console.log('✅ Test SMS Sent Successfully!');
    console.log('Message SID:', message.sid);
    console.log('Status:', message.status);
  } catch (err) {
    console.error('❌ SMS FAILED:', err.message);
    if (err.code === 21608) {
      console.log('\n💡 TIP: Since you are using a Twilio Trial account, you must verify the recipient number (+919441568939) in your Twilio Console first.');
    }
  }
}

testSms();
