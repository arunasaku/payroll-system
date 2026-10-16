// auth.js – Client-side authentication for PayFlow demo
// Users are stored in Firestore under "payflow_users" collection.
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

async function ensureUsersLoaded() {
    if (usersLoaded) return;
    if (initPromise) { await initPromise; return; }

    initPromise = (async () => {
        try {
            const { getDocs, collection } = window.firebaseFirestore;
            const querySnapshot = await getDocs(collection(window.db, "payflow_users"));
            usersCache = [];
            querySnapshot.forEach((doc) => {
                usersCache.push({ id: doc.id, ...doc.data() });
            });
        } catch (e) {
            console.error("Error loading users from Firestore:", e);
            usersCache = [];
        }

        if (usersCache.length === 0) {
            // Seed defaults
            for (const u of DEFAULT_USERS) {
                const userCopy = { ...u };
                try {
                    const { setDoc, doc } = window.firebaseFirestore;
                    await setDoc(doc(window.db, "payflow_users", userCopy.username), {
                        username: userCopy.username,
                        password: userCopy.password,
                        role: userCopy.role,
                        department: userCopy.department,
                        active: userCopy.active,
                        permissions: userCopy.permissions
                    });
                } catch (e) {
                    console.error("Error seeding user:", e);
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
            await saveUsersToFirestore(usersCache);
        }

        usersLoaded = true;
    })();

    await initPromise;
    initPromise = null;
}

async function saveUsersToFirestore(users) {
    try {
        const { setDoc, doc, deleteDoc } = window.firebaseFirestore;
        // Get existing docs to find ones to delete
        const existing = await loadUsersRaw();
        const currentUsernames = new Set(users.map(u => u.username));
        for (const existingUser of existing) {
            if (!currentUsernames.has(existingUser.username)) {
                await deleteDoc(doc(window.db, "payflow_users", existingUser.username));
            }
        }
        for (const user of users) {
            await setDoc(doc(window.db, "payflow_users", user.username), {
                username: user.username,
                password: user.password,
                role: user.role,
                department: user.department,
                active: user.active,
                permissions: user.permissions
            });
        }
    } catch (e) {
        console.error("Error saving users to Firestore:", e);
    }
}

async function loadUsersRaw() {
    try {
        const { getDocs, collection } = window.firebaseFirestore;
        const querySnapshot = await getDocs(collection(window.db, "payflow_users"));
        const result = [];
        querySnapshot.forEach((doc) => {
            result.push({ id: doc.id, ...doc.data() });
        });
        return result;
    } catch (e) {
        console.error("Error loading users raw:", e);
        return [];
    }
}

/** Get all registered users */
async function getUsers() {
    await ensureUsersLoaded();
    return [...usersCache];
}

/** Save users list */
async function saveUsers(users) {
    usersCache = [...users];
    await saveUsersToFirestore(users);
}

/** Attempt login */
async function login(username, password) {
    await ensureUsersLoaded();
    const user = usersCache.find(u => u.username === username && u.password === password);
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
    await saveUsersToFirestore(usersCache);
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
    await saveUsersToFirestore(usersCache);
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
    await saveUsersToFirestore(usersCache);
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
    const before = usersCache.length;
    usersCache = usersCache.filter(u => u.username !== username);
    if (usersCache.length === before) return { success: false, message: "User not found." };

    await saveUsersToFirestore(usersCache);
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
    await saveUsersToFirestore(usersCache);
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
    await saveUsersToFirestore(usersCache);

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
    getUsers, createUser, toggleUserAccess, updateUser, deleteUser, resetPassword, updateUserPermissions
};
