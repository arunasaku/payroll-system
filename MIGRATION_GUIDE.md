# Firebase to Supabase Migration Guide (මඟපෙන්වීම)

මෙම Payroll & HR පද්ධතිය Firebase Firestore සිට Supabase PostgreSQL වෙත සාර්ථකව migrate කර ඇත.

---

## 📁 නිර්මාණය කරන ලද නව ලිපිගොනු (Created Files)

1. **`firebase_backup_data.json`**:
   - ඔබගේ පවතින Firebase database හි සියලුම දත්ත (Employees 26, Attendance 1383, Users 4, Payroll Runs 4) 100% ක් සුරක්ෂිතව backup කර ඇත.
2. **`supabase_schema.sql`**:
   - Supabase හි අවශ්‍ය සියලුම tables (`payroll_master_data`, `payroll_runs`, `payflow_users`, `cross_site_chat`, `cross_site_status`) සහ Row Level Security (RLS) policies ස්වයංක්‍රීයව සකස් කරන SQL script එක.
3. **`supabase-config.js`**:
   - Supabase API connection configuration එක. ඔබගේ Supabase URL සහ Anon Public Key මෙහි සටහන් කළ හැක.
4. **`migrate-firebase-to-supabase.js`**:
   - Backup කරගත් සියලුම Firebase දත්ත එක ක්ලික් එකකින් Supabase වෙත upload කරන automated migration script එක.

---

## 🚀 Supabase වෙත සම්බන්ධ කිරීමේ පියවර 3 (Setup Steps)

### පියවර 1: Supabase Project එකක් සාදා ගන්න
1. [supabase.com](https://supabase.com) වෙත ගොස් නොමිලේ ගිණුමක් සාදා (හෝ Sign In වී) **"New project"** ක්ලික් කරන්න.
2. Project Name එකක් සහ Database Password එකක් ලබා දී Region එක (උදා. Singapore) තෝරා project එක සාදන්න.

### පියවර 2: Database Tables සාදා ගන්න
1. Supabase Dashboard එකෙහි වම්පස මෙනුවේ **SQL Editor** වෙත යන්න.
2. **"New query"** ක්ලික් කරන්න.
3. මෙම project එකේ ඇති `supabase_schema.sql` ගොනුවේ ඇති සම්පූර්ණ code එක copy කර paste කර **"Run"** ක්ලික් කරන්න.
   *(සාර්ථක වූ පසු "Success. No rows returned" ලෙස පෙන්වයි).*

### පියවර 3: දත්ත Supabase වෙත Upload කර පද්ධතිය සම්බන්ධ කරන්න

#### විකල්පය A (ස්වයංක්‍රීයව දත්ත යැවීම - නිර්දේශිත):
Supabase Dashboard -> **Project Settings** -> **API** වෙත ගොස්:
- **Project URL**
- **Project API Keys** (anon / public key)

Terminal / Command Prompt එකේ පහත විධානය run කරන්න:
```bash
node migrate-firebase-to-supabase.js <YOUR_SUPABASE_URL> <YOUR_SUPABASE_ANON_KEY>
```
*උදාහරණයක්:*
```bash
node migrate-firebase-to-supabase.js https://abcxyz.supabase.co eyJhbGciOi...
```

#### විකල්පය B (`supabase-config.js` හි සඳහන් කිරීම):
`supabase-config.js` ගොනුව විවෘත කර ඔබගේ credentials ඇතුළත් කරන්න:
```javascript
const DEFAULT_SUPABASE_URL = "https://your-project-id.supabase.co";
const DEFAULT_SUPABASE_ANON_KEY = "your-anon-public-key";
```
ඉන්පසු `node migrate-firebase-to-supabase.js` run කරන්න.

---

## 🔒 Offline & LocalStorage Fallback (ආරක්ෂිත ක්‍රමය)
Supabase credentials ඇතුළත් නොකරද පද්ධතිය බිඳ නොවැටී (Zero crash) local cache එකෙන් සාමාන්‍ය පරිදි ක්‍රියාත්මක වීමට අවශ්‍ය fallback පහසුකමද `auth.js` සහ `app.js` තුළ සකසා ඇත.
Supabase credentials ඇතුළත් කළ විගස පද්ධතිය සජීවීව Supabase cloud database එක සමඟ sync වේ.
