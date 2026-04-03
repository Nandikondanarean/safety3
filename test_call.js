require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const targetNumber = '+919441568939';
const locationLink = 'https://maps.google.com/?q=7GJQ+P44,+Saroornagar+Mandal,+Badangpet+-+Nadargul+Main+Rd,+Hyderabad,+Telangana+500112';

async function sendCallAndSMS() {
    console.log(`Sending from Twilio Number: ${process.env.TWILIO_PHONE_NUMBER} to ${targetNumber}`);

    console.log(`\nInitiating SMS and Call simultaneously...`);

    const smsPromise = client.messages.create({
        body: `Hello from Safety Shield! Your requested location is here: ${locationLink}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: targetNumber
    }).then(msg => console.log(`✅ SMS successfully sent! SID: ${msg.sid}`))
      .catch(err => console.error(`❌ FAILED to send SMS. Error: ${err.message}`));

    const callPromise = client.calls.create({
        twiml: '<Response><Say voice="alice">Emergency Alert. This is a test call from Safety Shield. Please check your SMS for the latest live location. Stay alert.</Say></Response>',
        to: targetNumber,
        from: process.env.TWILIO_PHONE_NUMBER
    }).then(call => console.log(`✅ Voice call successfully initiated! SID: ${call.sid}`))
      .catch(err => console.error(`❌ FAILED to initiate call. Error: ${err.message}`));

    await Promise.all([smsPromise, callPromise]);
}

sendCallAndSMS();
