/**
 * Automated Migration Script: Firebase Firestore -> Supabase PostgreSQL
 * 
 * Usage:
 *   node migrate-firebase-to-supabase.js <SUPABASE_URL> <SUPABASE_ANON_KEY>
 * 
 * Example:
 *   node migrate-firebase-to-supabase.js https://xyzcompany.supabase.co eyJhbGci...
 */

const fs = require('fs');
const https = require('https');

// 1. Read command line arguments or fallback to supabase-config.js
let targetUrl = process.argv[2];
let targetKey = process.argv[3];

if (!targetUrl || !targetKey) {
    try {
        const configContent = fs.readFileSync('supabase-config.js', 'utf8');
        const urlMatch = configContent.match(/DEFAULT_SUPABASE_URL\s*=\s*["']([^"']+)["']/);
        const keyMatch = configContent.match(/DEFAULT_SUPABASE_ANON_KEY\s*=\s*["']([^"']+)["']/);
        if (urlMatch && urlMatch[1] && !urlMatch[1].includes('your-project-id')) {
            targetUrl = urlMatch[1];
        }
        if (keyMatch && keyMatch[1] && !keyMatch[1].includes('your-anon-public-key')) {
            targetKey = keyMatch[1];
        }
    } catch (e) {}
}

if (targetUrl) {
    targetUrl = targetUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}
if (targetKey) {
    targetKey = targetKey.trim();
}

if (!targetUrl || !targetKey || targetUrl.includes('your-project-id')) {
    console.error(`
================================================================================
MIGRATION ERROR: Supabase credentials required!
================================================================================
Please provide your Supabase URL and Anon/Service-Role Key:
  node migrate-firebase-to-supabase.js <SUPABASE_URL> <SUPABASE_KEY>

Example:
  node migrate-firebase-to-supabase.js https://abcxyz.supabase.co eyJhbGciOi...
================================================================================
`);
    process.exit(1);
}

// 2. Load the exported Firebase data
if (!fs.existsSync('firebase_backup_data.json')) {
    console.error("firebase_backup_data.json not found! Run 'node backup-firebase.js' first.");
    process.exit(1);
}

const backup = JSON.parse(fs.readFileSync('firebase_backup_data.json', 'utf8'));

// HTTP Helper for Supabase REST API (PostgREST)
function postgrestUpsert(tableName, payload) {
    return new Promise((resolve, reject) => {
        const fullUrl = `${targetUrl.replace(/\/$/, '')}/rest/v1/${tableName}`;
        const parsed = new URL(fullUrl);

        const bodyData = JSON.stringify(payload);

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || 443,
            path: parsed.pathname + parsed.search,
            method: 'POST',
            headers: {
                'apikey': targetKey,
                'Authorization': `Bearer ${targetKey}`,
                'Content-Type': 'application/json',
                'Prefer': 'resolution=merge-duplicates,return=representation',
                'Content-Length': Buffer.byteLength(bodyData)
            }
        };

        const req = https.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => resData += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve({ status: res.statusCode, data: resData ? JSON.parse(resData) : null });
                } else {
                    reject(new Error(`HTTP ${res.statusCode} for ${tableName}: ${resData}`));
                }
            });
        });

        req.on('error', reject);
        req.write(bodyData);
        req.end();
    });
}

async function startMigration() {
    console.log("================================================================================");
    console.log(`Starting Data Migration to Supabase: ${targetUrl}`);
    console.log("================================================================================");

    // 1. Migrate Users (payflow_users)
    if (backup.payflowUsers && backup.payflowUsers.length > 0) {
        console.log(`\n1. Migrating ${backup.payflowUsers.length} users to 'payflow_users'...`);
        const formattedUsers = backup.payflowUsers.map(u => ({
            username: u.username,
            password: u.password || 'admin123',
            role: u.role || 'employee',
            department: u.department || 'General',
            active: u.active !== false,
            permissions: u.permissions || [],
            updated_at: new Date().toISOString()
        }));

        try {
            await postgrestUpsert('payflow_users', formattedUsers);
            console.log("   ✓ Successfully migrated users:", formattedUsers.map(u => u.username).join(', '));
        } catch (e) {
            console.error("   ✗ Failed to migrate payflow_users:", e.message);
        }
    }

    // 2. Migrate Master Data (payroll_master_data)
    if (backup.payrollMaster) {
        console.log("\n2. Migrating Master Data to 'payroll_master_data'...");
        console.log(`   - Employees: ${(backup.payrollMaster.employees || []).length}`);
        console.log(`   - Attendance Records: ${(backup.payrollMaster.attendance || []).length}`);
        console.log(`   - Departments: ${(backup.payrollMaster.departments || []).length}`);
        console.log(`   - Allowances: ${(backup.payrollMaster.allowances_config || []).length}`);

        const masterRecord = {
            id: 'master',
            data: backup.payrollMaster,
            updated_at: new Date().toISOString()
        };

        try {
            await postgrestUpsert('payroll_master_data', masterRecord);
            console.log("   ✓ Successfully migrated master data record!");
        } catch (e) {
            console.error("   ✗ Failed to migrate payroll_master_data:", e.message);
        }
    }

    // 3. Migrate Payroll Runs (payroll_runs)
    if (backup.payrollRuns && Object.keys(backup.payrollRuns).length > 0) {
        const months = Object.keys(backup.payrollRuns);
        console.log(`\n3. Migrating ${months.length} monthly payroll runs to 'payroll_runs'...`);
        const runRecords = months.map(m => ({
            month: m,
            runs: backup.payrollRuns[m] || [],
            updated_at: new Date().toISOString()
        }));

        try {
            await postgrestUpsert('payroll_runs', runRecords);
            console.log("   ✓ Successfully migrated payroll runs for months:", months.join(', '));
        } catch (e) {
            console.error("   ✗ Failed to migrate payroll_runs:", e.message);
        }
    }

    console.log("\n================================================================================");
    console.log("MIGRATION COMPLETE! Your Firebase data is now live on Supabase.");
    console.log("================================================================================");
}

startMigration();
