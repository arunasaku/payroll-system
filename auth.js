// auth.js – Client-side authentication for PayFlow demo
// -----------------------------------------------------
// Users are stored in localStorage under "payflow_users".
// Default demo users are seeded on first load.
// Only admin can create/manage users via the User Management panel.

const DEFAULT_USERS = [
    { username: "admin", password: "admin123", role: "admin", department: "All", active: true, permissions: ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings', 'users'] },
    { username: "manager", password: "manager123", role: "manager", department: "Sales", active: true, permissions: ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings'] },
    { username: "employee", password: "emp123", role: "employee", department: "Sales", active: true, permissions: ['dashboard', 'attendance', 'reports'] }
];

/** Seed default users if none exist (also self-heals corrupted/locked-out data) */
function seedUsers() {
    let users = [];
    try {
        users = JSON.parse(localStorage.getItem('payflow_users') || '[]');
    } catch (e) {
        users = [];
    }

    if (!Array.isArray(users) || users.length === 0) {
        // Missing or corrupted storage — restore defaults
        localStorage.setItem('payflow_users', JSON.stringify(DEFAULT_USERS));
        return;
    }

    let changed = false;
    // Migrate old users that don't have 'active' field
    users.forEach(u => {
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
    });

    // Self-heal: if no admin account exists (e.g. deleted via User Management),
    // restore the default admin so the system can never be locked out
    if (!users.some(u => u.role === 'admin')) {
        users.push({ ...DEFAULT_USERS[0] });
        changed = true;
    }

    if (changed) localStorage.setItem('payflow_users', JSON.stringify(users));
}
seedUsers();

/** Get all registered users */
function getUsers() {
    try {
        return JSON.parse(localStorage.getItem('payflow_users')) || [];
    } catch (e) {
        return [];
    }
}

/** Save users list */
function saveUsers(users) {
    localStorage.setItem('payflow_users', JSON.stringify(users));
}

/** Attempt login */
async function login(username, password) {
    const users = getUsers();
    const user = users.find(u => u.username === username && u.password === password);
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
function createUser(username, password, role, department) {
    // Check caller is admin
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

    const users = getUsers();
    const exists = users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (exists) {
        return { success: false, message: "Username already exists." };
    }

    users.push({
        username: username,
        password: password,
        role: role || "employee",
        department: department || "General",
        active: true,
        permissions: role === 'admin' ? ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings', 'users'] : (role === 'manager' ? ['dashboard', 'employees', 'attendance', 'payroll', 'reports', 'settings'] : ['dashboard', 'attendance', 'reports'])
    });
    saveUsers(users);
    return { success: true, message: "User created successfully!" };
}

/** Admin-only: Toggle user active status */
function toggleUserAccess(username) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can manage users." };
    }
    if (username === current.username) {
        return { success: false, message: "You cannot deactivate your own account." };
    }

    const users = getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    user.active = !user.active;
    saveUsers(users);
    return { success: true, message: `User "${username}" is now ${user.active ? 'active' : 'deactivated'}.` };
}

/** Admin-only: Update user role and department */
function updateUser(username, newRole, newDepartment) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can manage users." };
    }

    const users = getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    if (newRole) user.role = newRole;
    if (newDepartment) user.department = newDepartment;
    saveUsers(users);
    return { success: true, message: `User "${username}" updated.` };
}

/** Admin-only: Delete a user */
function deleteUser(username) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can delete users." };
    }
    if (username === current.username) {
        return { success: false, message: "You cannot delete your own account." };
    }

    let users = getUsers();
    const before = users.length;
    users = users.filter(u => u.username !== username);
    if (users.length === before) return { success: false, message: "User not found." };

    saveUsers(users);
    return { success: true, message: `User "${username}" deleted.` };
}

/** Admin-only: Reset a user's password */
function resetPassword(username, newPassword) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can reset passwords." };
    }
    if (!newPassword || newPassword.length < 4) {
        return { success: false, message: "Password must be at least 4 characters." };
    }

    const users = getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    user.password = newPassword;
    saveUsers(users);
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
function updateUserPermissions(username, permissionsArray) {
    const current = getCurrentUser();
    if (!current || current.role !== 'admin') {
        return { success: false, message: "Only admin can manage permissions." };
    }

    const users = getUsers();
    const user = users.find(u => u.username === username);
    if (!user) return { success: false, message: "User not found." };

    user.permissions = permissionsArray;
    saveUsers(users);

    // If updating own permissions, update token
    if (username === current.username) {
        current.permissions = permissionsArray;
        localStorage.setItem('payflowToken', JSON.stringify(current));
    }

    return { success: true, message: `Permissions for "${username}" updated.` };
}

// Export for use in other scripts (browser globals)
window.auth = {
    login, logout, getCurrentUser, requireAuth,
    getUsers, createUser, toggleUserAccess, updateUser, deleteUser, resetPassword, updateUserPermissions
};
