require('dotenv').config();
const twilio = require('twilio');

const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
);

const numbers = ['+919441568939'];
const locationLink = 'https://maps.google.com/?q=7GJQ+P44,+Saroornagar+Mandal,+Badangpet+-+Nadargul+Main+Rd,+Hyderabad,+Telangana+500112'; // Live target location

async function sendDirectSMS() {
    console.log(`Sending from Twilio Number: ${process.env.TWILIO_PHONE_NUMBER}`);

    const smsPromises = numbers.map(async (num) => {
        try {
            console.log(`\nAttempting to send SMS to ${num}...`);
            const msg = await client.messages.create({
                body: `Hello from Safety Shield! Your requested location is here: ${locationLink}`,
                from: process.env.TWILIO_PHONE_NUMBER,
                to: num
            });
            console.log(`✅ SMS successfully sent to ${num}! SID: ${msg.sid}`);
        } catch (err) {
            console.error(`❌ FAILED to send to ${num}. Error: ${err.message}`);
        }
    });

    await Promise.all(smsPromises);
}

sendDirectSMS();
