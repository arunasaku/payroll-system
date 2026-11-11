// Backup Firebase Firestore data to local JSON
const https = require('https');
const fs = require('fs');

const PROJECT_ID = 'hr-management-system-2aa97';
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function parseFirestoreValue(val) {
    if (!val || typeof val !== 'object') return val;
    if ('stringValue' in val) return val.stringValue;
    if ('integerValue' in val) return parseInt(val.integerValue, 10);
    if ('doubleValue' in val) return parseFloat(val.doubleValue);
    if ('booleanValue' in val) return val.booleanValue;
    if ('nullValue' in val) return null;
    if ('arrayValue' in val) {
        return (val.arrayValue.values || []).map(parseFirestoreValue);
    }
    if ('mapValue' in val) {
        const result = {};
        const fields = val.mapValue.fields || {};
        for (const [k, v] of Object.entries(fields)) {
            result[k] = parseFirestoreValue(v);
        }
        return result;
    }
    return val;
}

function parseFirestoreFields(fields) {
    const res = {};
    for (const [k, v] of Object.entries(fields || {})) {
        res[k] = parseFirestoreValue(v);
    }
    return res;
}

async function run() {
    console.log("Fetching live Firebase Firestore data...");
    const backup = {
        exportedAt: new Date().toISOString(),
        projectId: PROJECT_ID,
        payrollMaster: null,
        payflowUsers: [],
        payrollRuns: {}
    };

    try {
        // 1. payroll_data/master
        console.log("- Fetching payroll_data/master...");
        const masterRaw = await fetchJson(`${BASE_URL}/payroll_data/master`);
        if (masterRaw.fields) {
            backup.payrollMaster = parseFirestoreFields(masterRaw.fields);
            console.log("  Successfully fetched master data:", {
                employees: (backup.payrollMaster.employees || []).length,
                attendance: (backup.payrollMaster.attendance || []).length,
                departments: (backup.payrollMaster.departments || []).length
            });
        }
    } catch (e) {
        console.error("  Error fetching master:", e.message);
    }

    try {
        // 2. payflow_users
        console.log("- Fetching payflow_users...");
        const usersRaw = await fetchJson(`${BASE_URL}/payflow_users`);
        if (usersRaw.documents) {
            backup.payflowUsers = usersRaw.documents.map(doc => {
                const username = doc.name.split('/').pop();
                return {
                    id: username,
                    ...parseFirestoreFields(doc.fields)
                };
            });
            console.log(`  Successfully fetched ${backup.payflowUsers.length} users:`, backup.payflowUsers.map(u => u.username));
        }
    } catch (e) {
        console.error("  Error fetching users:", e.message);
    }

    try {
        // 3. payroll_runs
        console.log("- Fetching payroll_runs...");
        const runsRaw = await fetchJson(`${BASE_URL}/payroll_runs`);
        if (runsRaw.documents) {
            runsRaw.documents.forEach(doc => {
                const month = doc.name.split('/').pop();
                const fields = parseFirestoreFields(doc.fields);
                backup.payrollRuns[month] = fields.runs || [];
            });
            console.log("  Successfully fetched payroll runs for months:", Object.keys(backup.payrollRuns));
        }
    } catch (e) {
        console.error("  Error fetching payroll runs:", e.message);
    }

    fs.writeFileSync('firebase_backup_data.json', JSON.stringify(backup, null, 2), 'utf8');
    console.log("\nBackup saved successfully to firebase_backup_data.json!");
}

run();
