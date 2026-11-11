// auth.js – Client-side authentication for PayFlow
// Users are stored in Supabase under "payflow_users" table (with localStorage fallback).
// Token is stored in localStorage (session-specific, per-browser).
// Only admin can create/manage users via the User Management panel.

const DEFAULT_USERS = [
    { username: "admin", password: "admin123", role: "admin", department: "All", active: true, permissions: ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings', 'users'] },
    { username: "manager", password: "manager123", role: "manager", department: "Sales", active: true, permissions: ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings'] },
    { username: "employee", password: "emp123", role: "employee", department: "Sales", active: true, permissions: ['dashboard', 'attendance', 'reports'] }
];

let usersCache = [];
let usersLoaded = false;
let initPromise = null;

function getSupabase() {
    if (window.supabaseClient) return window.supabaseClient;
    if (window.initSupabaseClient) window.initSupabaseClient();
    return window.supabaseClient || null;
}

async function ensureUsersLoaded() {
    if (usersLoaded) return;
    if (initPromise) { await initPromise; return; }

    const client = getSupabase();
    const isConfigured = window.isSupabaseConfigured ? window.isSupabaseConfigured() : !!client;

    if (!client || !isConfigured) {
        console.warn("Supabase not fully configured yet; loading users from localStorage fallback.");
        try { usersCache = JSON.parse(localStorage.getItem('payflowUsers') || '[]'); } catch(e){ usersCache=[]; }
        if (!usersCache || usersCache.length === 0) {
            usersCache = [...DEFAULT_USERS];
        }
        usersLoaded = true;
        return;
    }

    initPromise = (async () => {
        try {
            const rawUsers = await loadUsersRaw();
            if (Array.isArray(rawUsers) && rawUsers.length > 0) {
                usersCache = rawUsers;
            } else {
                usersCache = [];
            }
        } catch (e) {
            console.error("Error loading users from Supabase:", e);
            try {
                const local = JSON.parse(localStorage.getItem('payflowUsers') || '[]');
                if (Array.isArray(local) && local.length > 0) {
                    usersCache = local;
                } else {
                    usersCache = [];
                }
            } catch (_) {
                usersCache = [];
            }
        }

        if (usersCache.length === 0) {
            // Seed defaults into Supabase
            console.log("No users found in Supabase. Seeding default users...");
            for (const u of DEFAULT_USERS) {
                try {
                    await client.from('payflow_users').upsert({
                        username: u.username,
                        password: u.password,
                        role: u.role,
                        department: u.department,
                        active: u.active,
                        permissions: u.permissions
                    });
                } catch (e) {
                    console.error("Error seeding default user:", e);
                }
            }
            usersCache = [...DEFAULT_USERS];
        }

        let changed = false;
        usersCache.forEach(u => {
            if (typeof u.active === 'undefined') {
                u.active = true;
                changed = true;
            }
            if (typeof u.permissions === 'undefined') {
                if (u.role === 'admin') u.permissions = ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings', 'users'];
                else if (u.role === 'manager') u.permissions = ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings'];
                else u.permissions = ['dashboard', 'employees', 'attendance', 'reports'];
                changed = true;
            }
            if (Array.isArray(u.department)) {
                u.department = u.department.join(', ');
                changed = true;
            }
        });

        if (!usersCache.some(u => u.role === 'admin')) {
            const adminCopy = { ...DEFAULT_USERS[0] };
            usersCache.push(adminCopy);
            changed = true;
        }

        if (changed) {
            await saveUsersToSupabase(usersCache);
        }

        try { localStorage.setItem('payflowUsers', JSON.stringify(usersCache)); } catch(e){}
        usersLoaded = true;
    })();

    await initPromise;
    initPromise = null;
}

async function saveUsersToSupabase(users) {
    const client = getSupabase();
    if (!client || (window.isSupabaseConfigured && !window.isSupabaseConfigured())) {
        try { localStorage.setItem('payflowUsers', JSON.stringify(users)); } catch(e){}
        return;
    }

    try {
        const existing = await loadUsersRaw();
        const currentUsernames = new Set(users.map(u => u.username));
        const toDelete = existing.filter(e => !currentUsernames.has(e.username)).map(e => e.username);

        if (toDelete.length > 0) {
            await client.from('payflow_users').delete().in('username', toDelete);
        }

        const upsertPayload = users.map(user => ({
            username: user.username,
            password: user.password,
            role: user.role,
            department: Array.isArray(user.department) ? user.department.join(', ') : (user.department || 'General'),
            active: user.active !== false,
            permissions: user.permissions || [],
            updated_at: new Date().toISOString()
        }));

        const { error } = await client.from('payflow_users').upsert(upsertPayload);
        if (error) {
            console.error("Supabase error saving users:", error);
        }
    } catch (e) {
        console.error("Error saving users to Supabase:", e);
    }
    try { localStorage.setItem('payflowUsers', JSON.stringify(users)); } catch(e){}
}

async function loadUsersRaw() {
    const client = getSupabase();
    if (!client) return [];

    try {
        const { data, error } = await client
            .from('payflow_users')
            .select('*');

        if (error) {
            console.error("Supabase loadUsersRaw error:", error);
            return [];
        }

        return (data || []).map(row => ({
            id: row.username,
            username: row.username,
            password: row.password,
            role: row.role,
            department: row.department,
            active: row.active,
            permissions: row.permissions
        }));
    } catch (e) {
        console.error("Error in loadUsersRaw:", e);
        return [];
    }
}

/** Synchronous helper to get cached users array safely */
function getCachedUsers() {
    if (Array.isArray(usersCache) && usersCache.length > 0) {
        return [...usersCache];
    }
    try {
        const local = JSON.parse(localStorage.getItem('payflowUsers') || '[]');
        if (Array.isArray(local) && local.length > 0) {
            return local;
        }
    } catch (_) {}
    return Array.isArray(DEFAULT_USERS) ? [...DEFAULT_USERS] : [];
}

/** Get all registered users */
async function getUsers() {
    try {
        await ensureUsersLoaded();
    } catch (e) {
        console.error("Error ensuring users loaded in auth.getUsers:", e);
    }
    return getCachedUsers();
}

/** Save users list */
async function saveUsers(users) {
    usersCache = [...users];
    await saveUsersToSupabase(users);
}

/** Attempt login */
async function login(username, password) {
    await ensureUsersLoaded();
    const source = usersCache.length ? usersCache : DEFAULT_USERS;
    let user = source.find(u => u.username === username && u.password === password);
    if (!user) user = DEFAULT_USERS.find(u => u.username === username && u.password === password);
    if (!user) return { success: false, message: "Invalid username or password." };
    if (!user.active) return { success: false, message: "Your account has been deactivated. Contact admin." };

    const token = {
        username: user.username,
        role: user.role,
        department: user.department,
        permissions: user.permissions || []
    };
    localStorage.setItem('payflowToken', JSON.stringify(token));
    return { success: true };
}

/** Admin-only: Create a new user. Returns { success, message } */
async function createUser(username, password, role, department) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can create users." };
    }
    if (!username || !password) {
        return { success: false, message: "Username and password are required." };
    }
    if (username.length < 3) {
        return { success: false, message: "Username must be at least 3 characters." };
    }
    if (password.length < 4) {
        return { success: false, message: "Password must be at least 4 characters." };
    }

    await ensureUsersLoaded();
    const exists = usersCache.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (exists) {
        return { success: false, message: "Username already exists." };
    }

    const newUser = {
        username: username,
        password: password,
        role: role || "employee",
        department: Array.isArray(department) ? department.join(', ') : (department || "General"),
        active: true,
        permissions: role === 'admin' ? ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings', 'users'] : (role === 'manager' ? ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings'] : ['dashboard', 'attendance', 'reports'])
    };

    usersCache.push(newUser);
    await saveUsersToSupabase(usersCache);
    return { success: true, message: "User created successfully!" };
}

/** Admin-only: Toggle user active status */
async function toggleUserAccess(username) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can manage users." };
    }
    if (username === current.username) {
        return { success: false, message: "You cannot deactivate your own account." };
    }

    await ensureUsersLoaded();
    const user = usersCache.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    user.active = !user.active;
    await saveUsersToSupabase(usersCache);
    return { success: true, message: `User "${username}" is now ${user.active ? 'active' : 'deactivated'}.` };
}

/** Admin-only: Update user role and department */
async function updateUser(username, newRole, newDepartment) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can manage users." };
    }

    await ensureUsersLoaded();
    const user = usersCache.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    if (newRole) user.role = newRole;
    if (newDepartment) user.department = newDepartment;
    await saveUsersToSupabase(usersCache);
    return { success: true, message: `User "${username}" updated.` };
}

/** Admin-only: Delete a user */
async function deleteUser(username) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can delete users." };
    }
    if (username === current.username) {
        return { success: false, message: "You cannot delete your own account." };
    }

    await ensureUsersLoaded();
    if (!Array.isArray(usersCache)) usersCache = [];
    const before = usersCache.length;
    usersCache = usersCache.filter(u => u && u.username !== username);
    if (usersCache.length === before) return { success: false, message: "User not found." };

    await saveUsersToSupabase(usersCache);
    return { success: true, message: `User "${username}" deleted.` };
}

/** Admin-only: Reset a user's password */
async function resetPassword(username, newPassword) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can reset passwords." };
    }
    if (!newPassword || newPassword.length < 4) {
        return { success: false, message: "Password must be at least 4 characters." };
    }

    await ensureUsersLoaded();
    const user = usersCache.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    user.password = newPassword;
    await saveUsersToSupabase(usersCache);
    return { success: true, message: `Password for "${username}" has been reset.` };
}

/** Logout – clear token */
function logout() {
    localStorage.removeItem('payflowToken');
    window.location.href = 'login.html';
}

/** Get the current logged-in user */
function getCurrentUser() {
    const txt = localStorage.getItem('payflowToken');
    return txt ? JSON.parse(txt) : null;
}

/** Guard pages – redirect to login if no token */
function requireAuth() {
    if (!getCurrentUser()) {
        window.location.href = 'login.html';
    }
}

/** Admin-only: Update user permissions */
async function updateUserPermissions(username, permissionsArray) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can manage permissions." };
    }

    await ensureUsersLoaded();
    const user = usersCache.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    user.permissions = permissionsArray;
    await saveUsersToSupabase(usersCache);

    // If updating own permissions, update token
    if (username === current.username) {
        current.permissions = permissionsArray;
        localStorage.setItem('payflowToken', JSON.stringify(current));
    }

    return { success: true, message: `Permissions for "${username}" updated.` };
}

// Initialize users on load
ensureUsersLoaded();

// Export for use in other scripts (browser globals)
window.auth = {
    login, logout, getCurrentUser, requireAuth,
    getUsers, getCachedUsers, createUser, toggleUserAccess, updateUser, deleteUser, resetPassword, updateUserPermissions,
    initAuth: ensureUsersLoaded
};
