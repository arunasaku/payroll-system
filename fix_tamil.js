const fs = require('fs');

let content = fs.readFileSync('D:/Projects/payroll-system/app.js', 'utf8');

const regex = /([\u0B80-\u0BFF]+(?:[\s\.,\-]+[\u0B80-\u0BFF]+)*)/g;

content = content.replace(regex, '<span style="font-size: 7px;">$1</span>');

fs.writeFileSync('D:/Projects/payroll-system/app.js', content, 'utf8');
console.log('Done');
