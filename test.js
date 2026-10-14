const fs = require('fs');
const html = fs.readFileSync('D:/Projects/payroll-system/temp_index.html', 'utf8');
const js = fs.readFileSync('D:/Projects/payroll-system/temp_app.js', 'utf8');
const setupFuncMatch = js.match(/function setupEventListeners\(\) \{([\s\S]*?)\n\}/);
if (setupFuncMatch) {
    const code = setupFuncMatch[1];
    const regex = /getElementById\(['"](.*?)['"]\)/g;
    let match;
    let missing = [];
    while ((match = regex.exec(code)) !== null) {
        const id = match[1];
        if (!html.includes('id=\"' + id + '\"')) {
            missing.push(id);
        }
    }
    console.log('Missing IDs:', missing);
}
