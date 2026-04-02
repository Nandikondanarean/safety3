require('dotenv').config();
const twilio = require('twilio');

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

console.log('📡 Fetching LATEST 3 SMS records for 9441568939...');

client.messages.list({ limit: 3 })
.then(messages => {
    messages.forEach(m => {
        console.log(`\nSMS LOG [${m.sid.slice(0, 10)}]`);
        console.log(`   To:       ${m.to}`);
        console.log(`   Status:   ${m.status}`);
        console.log(`   Time:     ${m.dateCreated}`);
        console.log(`   Error:    ${m.errorCode || 'None'}`);
        console.log(`   Message:  ${m.body.slice(0, 60)}...`);
    });
})
.catch(err => {
    console.error('❌ Error:', err.message);
});
