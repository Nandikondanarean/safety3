require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const TEST_FAMILY_NUMBER = '+919441568939';
const LIVE_TRACK_URL = 'https://safeher-1fb18.web.app/track.html?id=dfa7e3'; // Sample tracking ID

const smsBody = `🚨 SOS EMERGENCY - SafeHer! 🚨\n\n` +
  `PLEASE TRACK MY LIVE LOCATION NOW:\n${LIVE_TRACK_URL}\n\n` +
  `⏰ Time: ${new Date().toLocaleString()}\n\n` +
  `I am in danger. Please respond immediately!`;

console.log('📡 Sending Test Production SMS to +919441568939...');

client.messages.create({
    body: smsBody,
    from: process.env.TWILIO_PHONE_NUMBER,
    to: TEST_FAMILY_NUMBER
})
.then(message => {
    console.log('✅ SMS Sent! SID:', message.sid);
    console.log('📞 Triggering Voice Call...');
    
    return client.calls.create({
        twiml: `<Response><Say voice="alice">Emergency! I need help immediately. A live tracking link has been sent to you by SMS. Please open it now.</Say></Response>`,
        to: TEST_FAMILY_NUMBER,
        from: process.env.TWILIO_PHONE_NUMBER
    });
})
.then(call => {
    console.log('✅ Voice Call Triggered! SID:', call.sid);
    console.log('\n🛡️ TRIPLE SHIELD TEST COMPLETED! 🛡️');
})
.catch(err => {
    console.error('❌ Error sending alert:', err.message);
});
