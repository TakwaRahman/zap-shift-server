const fs = require('fs');
const key = fs.readFileSync('./zap-shift-fa680-firebase-adminsdk-fbsvc-76807b1d7c.json', 'utf8')
const base64 = Buffer.from(key).toString('base64')
console.log(base64)