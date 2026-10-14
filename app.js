// Core State Management with localStorage fallback for Sri Lankan EPF/ETF Style Payroll
window.lucide = window.lucide || { createIcons: () => { console.warn("Lucide library not loaded."); } };

class DataStore {
    constructor() {
        this.settings = { stdWorkDays: 26, stdWorkHours: 9, normalOtRate: 1.5, specialOtRate: 2.0, taxRate: 0 };
        this.departments = ["Training", "Engineering", "Operations", "Marketing", "Sales", "HR & Admin"];
        this.designations = ["Lead Instructor", "Senior Instructor", "Instructor", "Senior Frontend Engineer", "Operations Lead", "Growth Marketer"];
        this.allowances_config = [
            { id: "col", name: "Cost of Living 2022/04", value: 5000 },
            { id: "veh", name: "Veh.Main.Incentive", value: 3000 },
            { id: "nocomplain", name: "No Complain", value: 2000 },
            { id: "male_inst", name: "Male Instructor Incentive", value: 2500 },
            { id: "female_inst", name: "Female Instructor Incentive", value: 2500 },
            { id: "inst_allow", name: "Instructor Allowance", value: 4000 },
            { id: "att_incentive", name: "Attendance Incentive", value: 1500 }
        ];
        this.employees = [];
        this.attendance = [];
        this.leaves = [];
        this.adjustments = {};
        this.runs = {};
        
        // Expose Firebase functions
        this.doc = window.doc;
        this.setDoc = window.setDoc;
        this.getDoc = window.getDoc;
    }

    async initFirebase() {
        if (!window.db || !window.firebaseFirestore) {
            console.error("Firebase not initialized yet!");
            return;
        }
        
        try {
            this.doc = window.firebaseFirestore.doc;
            this.setDoc = window.firebaseFirestore.setDoc;
            this.getDoc = window.firebaseFirestore.getDoc;
            const collection = window.firebaseFirestore.collection;
            const getDocs = window.firebaseFirestore.getDocs;
            
            const docRef = this.doc(window.db, "payroll_data", "master");
            
            // Add a timeout to prevent infinite loading screen
            const fetchPromise = this.getDoc(docRef);
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase timeout')), 5000));
            
            const docSnap = await Promise.race([fetchPromise, timeoutPromise]);

            if (docSnap.exists()) {
                const data = docSnap.data();
                
                // Check if we need to migrate old localStorage data
                let localEmployees = [];
                try { localEmployees = JSON.parse(localStorage.getItem('payroll_employees')) || []; } catch(e){}
                
                if (data.employees && data.employees.length === 0 && localEmployees.length > 0) {
                    console.log("Migrating old local data to Firebase...");
                    this.settings = JSON.parse(localStorage.getItem('payroll_settings')) || this.settings;
                    this.departments = JSON.parse(localStorage.getItem('payroll_departments')) || this.departments;
                    this.designations = JSON.parse(localStorage.getItem('payroll_designations')) || this.designations;
                    this.allowances_config = JSON.parse(localStorage.getItem('payroll_allowances_config')) || this.allowances_config;
                    this.employees = localEmployees;
                    this.attendance = JSON.parse(localStorage.getItem('payroll_attendance')) || this.attendance;
                    this.leaves = JSON.parse(localStorage.getItem('payroll_leaves')) || this.leaves;
                    this.adjustments = JSON.parse(localStorage.getItem('payroll_adjustments')) || this.adjustments;
                    this.syncToFirebase();
                } else {
                    this.settings = data.settings || this.settings;
                    this.departments = data.departments || this.departments;
                    this.designations = data.designations || this.designations;
                    this.allowances_config = data.allowances_config || this.allowances_config;
                    this.employees = data.employees || this.employees;
                    this.attendance = data.attendance || this.attendance;
                    this.leaves = data.leaves || this.leaves;
                    this.adjustments = data.adjustments || this.adjustments;
                    console.log("Loaded master data from Firebase!");
                }
            } else {
                console.log("No data found in Firebase, saving defaults.");
                
                // Try to grab local data first
                try {
                    if (localStorage.getItem('payroll_employees')) {
                        this.settings = JSON.parse(localStorage.getItem('payroll_settings')) || this.settings;
                        this.departments = JSON.parse(localStorage.getItem('payroll_departments')) || this.departments;
                        this.designations = JSON.parse(localStorage.getItem('payroll_designations')) || this.designations;
                        this.allowances_config = JSON.parse(localStorage.getItem('payroll_allowances_config')) || this.allowances_config;
                        this.employees = JSON.parse(localStorage.getItem('payroll_employees')) || this.employees;
                        this.attendance = JSON.parse(localStorage.getItem('payroll_attendance')) || this.attendance;
                        this.leaves = JSON.parse(localStorage.getItem('payroll_leaves')) || this.leaves;
                        this.adjustments = JSON.parse(localStorage.getItem('payroll_adjustments')) || this.adjustments;
                    }
                } catch(e) {}
                
                this.syncToFirebase();
            }

            // Fetch payroll runs in the background without blocking the UI

            // SELF-HEAL: Restore missing id fields in allowances_config (caused by edit bug)
            this.repairAllowancesConfig();
            getDocs(collection(window.db, "payroll_runs")).then(runsSnap => {
                runsSnap.forEach(doc => {
                    this.runs[doc.id] = doc.data().runs;
                });
                console.log("Loaded payroll runs from Firebase in the background!");
            }).catch(e => {
                console.error("Error loading payroll runs:", e);
            });

        } catch (e) {
            console.error("Error connecting to Firebase (or timeout):", e);
            alert("Database Error: Could not connect to Firebase! Ensure your Firestore Rules are set to 'allow read, write: if true;' and your internet is connected. Your changes will not be saved to the cloud.");
        }
    }

    async syncToFirebase() {
        if (!window.db || !this.setDoc) {
            console.error("Firebase not ready for sync.");
            return;
        }
        try {
            const dataToSave = {
                settings: this.settings,
                departments: this.departments,
                designations: this.designations,
                allowances_config: this.allowances_config,
                employees: this.employees,
                attendance: this.attendance,
                leaves: this.leaves,
                adjustments: this.adjustments
            };
            const docRef = this.doc(window.db, "payroll_data", "master");
            // Run asynchronously without awaiting so UI doesn't block
            this.setDoc(docRef, dataToSave).catch(e => {
                console.error("Firebase sync error", e);
                alert("Database Error: Failed to save data to the cloud! Check your Firebase Firestore Security Rules.");
            });
        } catch (e) {
            console.error("Firebase sync error", e);
        }
    }

    getPayrollRuns(month) {
        return this.runs[month] || [];
    }

    savePayrollRuns(month, runs) {
        this.runs[month] = runs;
        if (!window.db || !this.setDoc) return;
        const docRef = this.doc(window.db, "payroll_runs", month);
        this.setDoc(docRef, { runs: runs }).catch(e => console.error("Firebase sync error for runs", e));
    }

    getSettings() { return this.settings; }
    saveSettings(settings) { this.settings = settings; this.syncToFirebase(); }

    getDepartments() {
        return this.departments.map(d => {
            if (typeof d === 'string') return { name: d, address: '', epfNo: '', phone: '', fax: '', email: '', web: '' };
            return d;
        });
    }
    saveDepartments(depts) { this.departments = depts; this.syncToFirebase(); }

    getDesignations() { return this.designations; }
    saveDesignations(desigs) { this.designations = desigs; this.syncToFirebase(); }

    // Repair allowancesConfig entries that lost their id field (caused by a previous edit bug)
    repairAllowancesConfig() {
        const DEFAULT_IDS = {
            "cost of living": "col",
            "veh.main.incentive": "veh",
            "vehicle maintenance": "veh",
            "no complain": "nocomplain",
            "instructor incentive": "inst_allow",
            "instructor allowance": "inst_allow",
            "male instructor": "male_inst",
            "female instructor": "female_inst",
            "attendance incentive": "att_incentive",
            "attendance": "att_incentive",
        };
        let changed = false;
        this.allowances_config = this.allowances_config.map((allow, idx) => {
            if (!allow.id) {
                // Try to find a matching default ID by name
                const nameLower = (allow.name || "").toLowerCase();
                let foundId = null;
                for (const [key, val] of Object.entries(DEFAULT_IDS)) {
                    if (nameLower.includes(key)) { foundId = val; break; }
                }
                // If no match found, generate a stable id from name
                if (!foundId) {
                    foundId = (allow.name || `allow_${idx}`).toLowerCase().replace(/[^a-z0-9]/g, "_").substring(0, 20);
                }
                changed = true;
                return { ...allow, id: foundId };
            }
            return allow;
        });
        if (changed) {
            console.log("Repaired allowances_config - restored missing id fields");
            this.syncToFirebase();
        }
    }

    getAllowancesConfig() { return this.allowances_config; }
    saveAllowancesConfig(allowances) { this.allowances_config = allowances; this.syncToFirebase(); }

    getEmployees() { return this.employees; }
    saveEmployees(employees) { this.employees = employees; this.syncToFirebase(); }

    getAttendance() { return this.attendance; }
    saveAttendance(attendance) { this.attendance = attendance; this.syncToFirebase(); }

    getLeaves() { return this.leaves; }
    saveLeaves(leaves) { this.leaves = leaves; this.syncToFirebase(); }

    getAdjustments() { return this.adjustments; }
    saveAdjustments(adjustments) { this.adjustments = adjustments; this.syncToFirebase(); }
}

const store = new DataStore();

// UI Router & Controller
document.addEventListener("DOMContentLoaded", async () => {
    // Wait for Firebase to load data
    await store.initFirebase();
    
    // Hide the loading overlay
    const overlay = document.getElementById("firebase-loading-overlay");
    if (overlay) overlay.style.display = "none";

    if (window.auth) window.auth.requireAuth();
    try {
        if (typeof lucide !== 'undefined') {
            lucide.createIcons();
        }
    } catch(e) { console.error(e); }
    initRouter();
    setupEventListeners();
    applyRBAC();
    renderActiveView();
    updateDashboardStats();
});

function applyRBAC() {
    if (!window.auth) return;
    const user = window.auth.getCurrentUser();
    if (!user) return;
    
    // Update logo text with role
    const roleElem = document.getElementById("logo-userrole");
    if (roleElem) roleElem.textContent = user.role;

    document.querySelectorAll(".nav-item").forEach(item => {
        const view = item.getAttribute("data-view");
        
        if (user.role === "admin") {
            item.style.display = "flex";
        } else {
            if (user.permissions && user.permissions.includes(view)) {
                item.style.display = "flex";
            } else {
                item.style.display = "none";
            }
        }
    });
}

function initRouter() {
    window.addEventListener("hashchange", renderActiveView);
}

function getActiveView() {
    return window.location.hash.replace("#", "") || "dashboard";
}

function renderActiveView() {
    let view = getActiveView();
    
    if (window.auth) {
        const user = window.auth.getCurrentUser();
        if (user && user.role !== "admin") {
            if (!user.permissions || !user.permissions.includes(view)) {
                const fallback = user.permissions && user.permissions.length > 0 ? user.permissions[0] : "dashboard";
                // Prevent infinite loop if already on fallback
                if (view !== fallback) {
                    window.location.hash = "#" + fallback;
                    return;
                }
            }
        }
    }
    
    document.querySelectorAll(".nav-item").forEach(item => {
        item.classList.toggle("active", item.getAttribute("data-view") === view);
    });

    document.querySelectorAll(".app-view").forEach(section => {
        section.classList.remove("active-view");
    });
    
    const targetSection = document.getElementById(`view-${view}`);
    if (targetSection) targetSection.classList.add("active-view");

    const titleMap = {
        "dashboard": "Dashboard Overview",
        "employees": "Employee Management",
        "attendance": "Attendance & Overtime Tracker",
        "leaves": "Leave Request Panel",
        "payroll": "Monthly Payroll Processing",
        "reports": "EPF / ETF",
        "settings": "System Settings"
    };

    document.getElementById("view-title").textContent = titleMap[view] || "Payroll Portal";

    if (view === "employees") renderEmployees();
    if (view === "attendance") renderAttendance();
    if (view === "payroll") renderPayroll();
    if (view === "reports") initReportsView();
    if (view === "settings") loadSettingsForm();
    if (view === "dashboard") updateDashboardStats();
}

function setupEventListeners() {
    // Employee Form
    document.getElementById("btn-print-employees").addEventListener("click", () => window.print());
    document.getElementById("btn-add-employee-modal").addEventListener("click", () => openEmployeeModal());
    document.getElementById("btn-close-employee-modal").addEventListener("click", closeEmployeeModal);
    document.getElementById("btn-cancel-employee-modal").addEventListener("click", closeEmployeeModal);
    
    document.getElementById("btn-close-employee-view-modal").addEventListener("click", closeEmployeeViewModal);
    document.getElementById("btn-close-employee-view-footer").addEventListener("click", closeEmployeeViewModal);
    document.getElementById("form-employee").addEventListener("submit", handleSaveEmployee);
    document.getElementById("search-employees").addEventListener("input", renderEmployees);

    // Attendance
    document.getElementById("btn-log-attendance").addEventListener("click", () => openAttendanceModal());
    document.getElementById("btn-mark-leaves").addEventListener("click", () => openLeavesModal());
    document.getElementById("btn-close-leaves-modal").addEventListener("click", closeLeavesModal);
    document.getElementById("form-leaves").addEventListener("submit", handleSaveLeaves);
    document.getElementById("btn-close-attendance-modal").addEventListener("click", closeAttendanceModal);
    document.getElementById("btn-cancel-attendance-modal").addEventListener("click", closeAttendanceModal);
    document.getElementById("form-attendance").addEventListener("submit", handleSaveAttendance);
    document.getElementById("attendance-date-filter").addEventListener("change", renderAttendance);
    document.getElementById("attendance-search").addEventListener("input", renderAttendance);
    document.getElementById("btn-print-attendance").addEventListener("click", () => window.print());

    // Monthly Attendance Report
    document.getElementById("btn-monthly-attendance").addEventListener("click", () => openMonthlyAttendanceModal());
    document.getElementById("btn-close-monthly-attendance").addEventListener("click", () => {
        document.getElementById("modal-monthly-attendance").style.display = "none";
    });
    document.getElementById("monthly-attendance-month-select").addEventListener("change", renderMonthlyAttendanceReport);
    document.getElementById("monthly-attendance-emp-select").addEventListener("change", renderMonthlyAttendanceReport);
    document.getElementById("btn-print-monthly-attendance").addEventListener("click", () => {
        const styleEl = document.createElement("style");
        styleEl.id = "monthly-attendance-print-page-style";
        styleEl.innerHTML = '@page { size: A4 portrait; margin: 1cm; }';
        document.head.appendChild(styleEl);
        window.print();
        document.head.removeChild(styleEl);
    });

    // Dashboard
    const dashAbsentDate = document.getElementById("dash-absent-date");
    if (dashAbsentDate) {
        dashAbsentDate.addEventListener("change", renderDashboardAbsentees);
        dashAbsentDate.addEventListener("input", renderDashboardAbsentees);
    }

    const today = new Date();
    const curDate = today.toISOString().substring(0, 10);
    const curMonth = today.toISOString().substring(0, 7);
    document.getElementById("attendance-date-filter").value = curDate;
    document.getElementById("payroll-month-select").value = curMonth;

    const logTypeSelect = document.getElementById("att-log-type");
    if (logTypeSelect) {
        logTypeSelect.addEventListener("change", () => {
            const val = logTypeSelect.value;
            const inGrp = document.getElementById("group-att-checkin");
            const outGrp = document.getElementById("group-att-checkout");
            if (val === "in") {
                inGrp.style.display = "block";
                outGrp.style.display = "none";
            } else if (val === "out") {
                inGrp.style.display = "none";
                outGrp.style.display = "block";
            } else {
                inGrp.style.display = "block";
                outGrp.style.display = "block";
            }
        });
    }

    const leaveCheckbox = document.getElementById("att-is-leave");
    if (leaveCheckbox) {
        leaveCheckbox.addEventListener("change", (e) => {
            if (e.target.checked) {
                document.getElementById("att-checkin").value = "";
                document.getElementById("att-checkout").value = "";
            }
        });
    }


    // Payroll
    document.getElementById("btn-process-payroll").addEventListener("click", processPayrollRun);
    document.getElementById("btn-open-dept-print").addEventListener("click", openDeptPrintModal);
    document.getElementById("payroll-month-select").addEventListener("change", renderPayroll);
    const searchInputPayroll = document.getElementById("payroll-search-input");
    if (searchInputPayroll) searchInputPayroll.addEventListener("input", filterPayrollTable);

    // Reports Listeners
    document.getElementById("btn-gen-epf-c").addEventListener("click", generateEpfCForm);
    document.getElementById("btn-gen-etf-r4").addEventListener("click", generateEtfR4Form);

    // Settings
    document.getElementById("form-settings").addEventListener("submit", handleSaveSettings);
    document.getElementById("btn-reset-emp-ids").addEventListener("click", handleResetEmployeeIDs);
    document.getElementById("btn-clear-emp-data").addEventListener("click", handleClearEmployeeData);
    
    document.getElementById("btn-add-dept").addEventListener("click", handleAddDepartment);
    document.getElementById("btn-add-desig").addEventListener("click", handleAddDesignation);
    document.getElementById("btn-add-allowance").addEventListener("click", handleAddAllowanceType);

    // Payslip Close
    document.getElementById("btn-close-payslip-modal").addEventListener("click", () => {
        document.getElementById("modal-payslip").style.display = "none";
    });
}

// Stats & Graphs
let deptChart = null;
let expenseChart = null;

function updateDashboardStats() {
    try {
        const employees = store.getEmployees() || [];
        const attendance = store.getAttendance() || [];
        
        document.getElementById("stat-total-employees").textContent = employees.length;
        
        const totalOt = attendance.reduce((sum, item) => sum + (item.normalOt || 0) + (item.specialOt || 0), 0);
        document.getElementById("stat-ot-hours").textContent = `${totalOt.toFixed(2)}h`;

        const selectedMonth = document.getElementById("payroll-month-select").value;
        
        let runs = [];
        try {
            runs = store.getPayrollRuns(selectedMonth);
        } catch(e) { runs = []; }

        let totalNet = 0;
        if (runs && runs.length > 0) {
            totalNet = runs.reduce((sum, r) => sum + (r.roundedNetSalary || 0), 0);
        } else {
            totalNet = employees.reduce((sum, e) => sum + (e.baseSalary || 0), 0);
        }
        document.getElementById("stat-total-payroll").textContent = `LKR ${totalNet.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
    } catch(e) {
        console.error("Dashboard stats error:", e);
    }

    // Always render absentees even if stats above fail
    renderDashboardAbsentees();

    setTimeout(renderDashboardCharts, 100);
}

function renderDashboardAbsentees() {
    try {
        const employees = store.getEmployees() || [];
        const attendance = store.getAttendance() || [];
        
        let absentDateInput = document.getElementById("dash-absent-date");
        if (!absentDateInput) return;
        
        if (!absentDateInput.value) {
            absentDateInput.value = new Date().toISOString().substring(0, 10);
        }
        const absentDate = absentDateInput.value;
        const absenteesListDiv = document.getElementById("dash-absentees-list");
        if (!absenteesListDiv) return;
        
        // Find who is absent on this date (no attendance record at all)
        const todaysAttendance = attendance.filter(a => a.date === absentDate);
        const absentees = employees.filter(emp => !todaysAttendance.some(a => a.employeeId === emp.id));
        const onLeave = employees.filter(emp => todaysAttendance.some(a => a.employeeId === emp.id && a.isLeave));
        
        const totalAway = absentees.length + onLeave.length;
        
        if (totalAway === 0) {
            absenteesListDiv.innerHTML = `<div style="color: var(--text-secondary); font-style: italic; width: 100%; text-align: center; padding: 10px;">All employees are present on this date!</div>`;
        } else {
            let html = `<div style="margin-bottom: 8px; font-size: 13px; color: var(--text-secondary);">${totalAway} employee(s) away on ${absentDate}</div>`;
            
            html += onLeave.map(emp => `
                <div style="background-color: #3abff8; color: white; padding: 6px 14px; border-radius: 20px; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; margin: 3px;" title="On Leave">
                    <i data-lucide="calendar" style="width: 14px; height: 14px;"></i> ${emp.firstName} ${emp.lastName}
                </div>
            `).join("");
            
            html += absentees.map(emp => `
                <div style="background-color: var(--danger); color: white; padding: 6px 14px; border-radius: 20px; font-size: 13px; display: inline-flex; align-items: center; gap: 6px; margin: 3px;" title="Absent">
                    <i data-lucide="user-x" style="width: 14px; height: 14px;"></i> ${emp.firstName} ${emp.lastName}
                </div>
            `).join("");
            
            absenteesListDiv.innerHTML = html;
        }
        
        if (typeof lucide !== 'undefined') lucide.createIcons();
    } catch(e) {
        console.error("Dashboard absentees error:", e);
    }
}

function renderDashboardCharts() {
    if (typeof Chart === 'undefined') {
        console.warn("Chart.js not loaded.");
        return;
    }
    const employees = store.getEmployees();
    const attendance = store.getAttendance();

    const deptCounts = {};
    employees.forEach(emp => {
        deptCounts[emp.department] = (deptCounts[emp.department] || 0) + 1;
    });

    const deptCtx = document.getElementById('chart-departments');
    if (deptCtx) {
        if (deptChart) deptChart.destroy();
        deptChart = new Chart(deptCtx, {
            type: 'doughnut',
            data: {
                labels: Object.keys(deptCounts),
                datasets: [{
                    data: Object.values(deptCounts),
                    backgroundColor: ['#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { position: 'bottom' } }
            }
        });
    }

    const empNames = [];
    const empOtHours = [];
    employees.forEach(emp => {
        empNames.push(`${emp.firstName} ${emp.lastName}`);
        const empAttendance = attendance.filter(a => a.employeeId === emp.id);
        const normalOt = empAttendance.reduce((sum, a) => sum + (a.normalOt || 0), 0);
        const specialOt = empAttendance.reduce((sum, a) => sum + (a.specialOt || 0), 0);
        empOtHours.push(normalOt + specialOt);
    });

    const expCtx = document.getElementById('chart-expenses');
    if (expCtx) {
        if (expenseChart) expenseChart.destroy();
        expenseChart = new Chart(expCtx, {
            type: 'bar',
            data: {
                labels: empNames,
                datasets: [{
                    label: 'OT Hours logged',
                    data: empOtHours,
                    backgroundColor: '#6366f1',
                    borderRadius: 6
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } }
            }
        });
    }
}

// Employee List Render
function renderEmployees() {
    const tbody = document.querySelector("#table-employees tbody");
    tbody.innerHTML = "";
    
    const employees = store.getEmployees();
    const query = (document.getElementById("search-employees").value || "").toLowerCase().trim();

    const filtered = employees.filter(emp => {
        if (!query) return true;
        return (
            (emp.firstName || "").toLowerCase().includes(query) ||
            (emp.lastName || "").toLowerCase().includes(query) ||
            ((emp.firstName || "") + " " + (emp.lastName || "")).toLowerCase().includes(query) ||
            (emp.id || "").toLowerCase().includes(query) ||
            (emp.epfNo || "").toLowerCase().includes(query) ||
            (emp.department || "").toLowerCase().includes(query) ||
            (emp.designation || "").toLowerCase().includes(query)
        );
    });

    const user = window.auth ? window.auth.getCurrentUser() : null;
    const isEmployee = user && user.role === "employee";

    filtered.forEach(emp => {
        let totAllowance = 0;
        if (emp.allowances) {
            Object.values(emp.allowances).forEach(val => { totAllowance += val; });
        }

        const actionHtml = isEmployee ? '-' : `
            <button class="btn btn-outline btn-icon" onclick="openEmployeeViewModal('${emp.id}')" style="padding: 6px 12px; margin-right: 4px;">
                <i data-lucide="eye" style="width:14px; height:14px"></i> View
            </button>
            <button class="btn btn-secondary btn-icon" onclick="openEmployeeModal('${emp.id}')" style="padding: 6px 12px">
                <i data-lucide="edit-3" style="width:14px; height:14px"></i> Edit
            </button>
            <button class="btn btn-danger btn-icon" onclick="handleDeleteEmployee('${emp.id}')" style="padding: 6px 12px">
                <i data-lucide="trash-2" style="width:14px; height:14px"></i> Delete
            </button>
        `;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${emp.id}</strong></td>
            <td>${emp.firstName} ${emp.lastName}</td>
            <td>
                <div style="font-weight:600">${emp.designation}</div>
                <div class="text-muted" style="font-size:12px">${emp.department}</div>
            </td>
            <td>${emp.joinDate || '-'}</td>
            <td>
                <div>${emp.nic || '-'}</div>
                <div class="text-muted" style="font-size:12px">${emp.dlNumber || '-'}</div>
            </td>
            <td>${emp.mobileNo || '-'}</td>
            <td>${emp.address || '-'}</td>
            <td>${actionHtml}</td>
        `;
        tbody.appendChild(tr);
    });
    
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

function openEmployeeViewModal(empId) {
    const employees = store.getEmployees();
    const emp = employees.find(e => e.id === empId);
    if (!emp) return;

    const modal = document.getElementById("modal-employee-view");
    const content = document.getElementById("employee-view-content");
    
    let allowancesHtml = "";
    if (emp.allowances) {
        allowancesHtml = Object.entries(emp.allowances)
            .map(([key, val]) => {
                const config = store.getAllowancesConfig().find(c => c.id === key);
                const name = config ? config.name : key;
                return `<tr><td>${name}</td><td style="text-align: right">LKR ${parseFloat(val||0).toFixed(2)}</td></tr>`;
            }).join("");
    }
    if (!allowancesHtml) {
        allowancesHtml = `<tr><td colspan="2" class="text-muted">No allowances configured.</td></tr>`;
    }

    content.innerHTML = `
        <div style="margin-bottom: 24px;">
            <h4 style="margin-bottom: 15px; color: var(--primary); border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">Basic Information</h4>
            <div style="display: flex; gap: 20px; flex-wrap: wrap;">
                <div style="flex: 1; min-width: 200px;">
                    <table class="data-table" style="box-shadow: none; border: 1px solid var(--border-color);">
                        <tbody>
                            <tr><th style="width: 120px">Employee ID</th><td><strong>${emp.id}</strong></td></tr>
                            <tr><th>Name</th><td>${emp.firstName} ${emp.lastName}</td></tr>
                            <tr><th>Department</th><td>${emp.department || '-'}</td></tr>
                            <tr><th>Designation</th><td>${emp.designation || '-'}</td></tr>
                        </tbody>
                    </table>
                </div>
                <div style="flex: 1; min-width: 200px;">
                    <table class="data-table" style="box-shadow: none; border: 1px solid var(--border-color);">
                        <tbody>
                            <tr><th style="width: 120px">Gender</th><td>${emp.gender || '-'}</td></tr>
                            <tr><th>NIC</th><td>${emp.nic || '-'}</td></tr>
                            <tr><th>Mobile</th><td>${emp.mobileNo || '-'}</td></tr>
                            <tr><th>Join Date</th><td>${emp.joinDate || '-'}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
        
        <div style="display: flex; gap: 20px; align-items: flex-start; flex-wrap: wrap;">
            <div style="flex: 1; min-width: 250px;">
                <h4 style="margin-bottom: 15px; color: var(--primary); border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">Payroll Information</h4>
                <table class="data-table" style="box-shadow: none; border: 1px solid var(--border-color);">
                    <tbody>
                        <tr><th style="width: 120px">Base Salary</th><td><strong>LKR ${(parseFloat(emp.baseSalary)||0).toFixed(2)}</strong></td></tr>
                        <tr><th>Bank Account</th><td>${emp.bankAcc || '-'}</td></tr>
                        <tr><th>EPF No</th><td>${emp.epfNo || '-'}</td></tr>
                        <tr><th>Member No</th><td>${emp.memberNo || '-'}</td></tr>
                    </tbody>
                </table>
            </div>
            
            <div style="flex: 1; min-width: 250px;">
                <h4 style="margin-bottom: 15px; color: var(--primary); border-bottom: 1px solid var(--border-color); padding-bottom: 5px;">Allowances</h4>
                <table class="data-table" style="box-shadow: none; border: 1px solid var(--border-color);">
                    <tbody>
                        ${allowancesHtml}
                    </tbody>
                </table>
            </div>
        </div>
    `;

    modal.style.display = "flex";
}

function closeEmployeeViewModal() {
    document.getElementById("modal-employee-view").style.display = "none";
}

function openEmployeeModal(empId = "") {
    const modal = document.getElementById("modal-employee");
    
    const deptSelect = document.getElementById("emp-department");
    deptSelect.innerHTML = "";
    store.getDepartments().forEach(d => {
        const opt = document.createElement("option");
        opt.value = d.name;
        opt.textContent = d.name;
        deptSelect.appendChild(opt);
    });

    const desigSelect = document.getElementById("emp-designation");
    desigSelect.innerHTML = "";
    store.getDesignations().forEach(d => {
        const opt = document.createElement("option");
        opt.value = d;
        opt.textContent = d;
        desigSelect.appendChild(opt);
    });

    const oldContainer = document.getElementById("employee-extra-fields-container");
    if (oldContainer) oldContainer.remove();
    
    injectEmployeeExtraFields();

    if (empId) {
        document.getElementById("modal-employee-title").textContent = "Edit Employee Details";
        const employees = store.getEmployees();
        const emp = employees.find(e => e.id === empId);
        
        if (emp) {
            document.getElementById("emp-id").value = emp.id;
            document.getElementById("emp-first-name").value = emp.firstName;
            document.getElementById("emp-last-name").value = emp.lastName;
            document.getElementById("emp-department").value = emp.department;
            document.getElementById("emp-designation").value = emp.designation;
            document.getElementById("emp-base-salary").value = emp.baseSalary;
            document.getElementById("emp-join-date").value = emp.joinDate || "";
            document.getElementById("emp-end-date").value = emp.endDate || "";
            document.getElementById("emp-epf-eligible").checked = emp.epfEligible !== false;
            document.getElementById("emp-bank-acc").value = emp.bankAcc || "";
            document.getElementById("emp-epf-no").value = emp.epfNo || "";
            document.getElementById("emp-gender").value = emp.gender || "Male";
            document.getElementById("emp-nic").value = emp.nic || "";
            document.getElementById("emp-member-no").value = emp.memberNo || "";
            document.getElementById("emp-mobile").value = emp.mobileNo || "";
            if(document.getElementById("emp-address")) document.getElementById("emp-address").value = emp.address || "";
            document.getElementById("emp-dl-number").value = emp.dlNumber || "";

            const allowancesConfig = store.getAllowancesConfig();
            allowancesConfig.forEach(allow => {
                const input = document.getElementById(`emp-allow-${allow.id}`);
                if (input) {
                    input.value = (emp.allowances && emp.allowances[allow.id] !== undefined) ? emp.allowances[allow.id] : allow.value;
                }
            });
        }
    } else {
        document.getElementById("form-employee").reset();
        document.getElementById("modal-employee-title").textContent = "Add New Employee";
        document.getElementById("emp-id").value = "";
    }
    
    modal.style.display = "flex";
}

function injectEmployeeExtraFields() {
    const form = document.getElementById("form-employee");
    const modalFooter = form.querySelector(".modal-footer");
    
    const existing = document.getElementById("employee-extra-fields-container");
    if (existing) {
        existing.remove();
    }

    const allowancesConfig = store.getAllowancesConfig();

    let allowancesHTML = "";
    for (let i = 0; i < allowancesConfig.length; i += 2) {
        const item1 = allowancesConfig[i];
        const item2 = allowancesConfig[i+1];

        allowancesHTML += `
            <div class="form-row">
                <div class="form-group col-6">
                    <label for="emp-allow-${item1.id}">${item1.name} (LKR)</label>
                    <input type="number" id="emp-allow-${item1.id}" class="form-input" value="${item1.value}">
                </div>
                ${item2 ? `
                <div class="form-group col-6">
                    <label for="emp-allow-${item2.id}">${item2.name} (LKR)</label>
                    <input type="number" id="emp-allow-${item2.id}" class="form-input" value="${item2.value}">
                </div>
                ` : '<div class="form-group col-6"></div>'}
            </div>
        `;
    }
    
    const extraHTML = `
        <div id="employee-extra-fields-container">
            <div class="form-row">
                <div class="form-group col-6">
                    <label for="emp-epf-no">EPF No.</label>
                    <input type="text" id="emp-epf-no" class="form-input" placeholder="EPF-0512">
                </div>
                <div class="form-group col-6">
                    <label for="emp-member-no">Member No</label>
                    <input type="number" id="emp-member-no" class="form-input" placeholder="e.g. 5">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group col-6">
                    <label for="emp-nic">National ID (NIC)</label>
                    <input type="text" id="emp-nic" class="form-input" placeholder="e.g. 757891204V">
                </div>
                <div class="form-group col-6">
                    <label for="emp-mobile">Mobile Number</label>
                    <input type="text" id="emp-mobile" class="form-input" placeholder="e.g. 071 6768407">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group col-6">
                    <label for="emp-gender">Gender</label>
                    <select id="emp-gender" class="form-input" required>
                        <option value="Male">Male</option>
                        <option value="Female">Female</option>
                    </select>
                </div>
                <div class="form-group col-6"></div>
            </div>
            <div class="form-row">
                <div class="form-group col-12" style="width:100%">
                    <label for="emp-address">Address</label>
                    <textarea id="emp-address" class="form-input" rows="2" placeholder="e.g. 123 Main St..."></textarea>
                </div>
            </div>
            <h4 style="margin: 16px 0 8px; border-bottom: 1px solid var(--border-color); padding-bottom: 4px;">Dynamic Monthly Allowances</h4>
            ${allowancesHTML}
        </div>
    `;
    
    modalFooter.insertAdjacentHTML('beforebegin', extraHTML);
}

function closeEmployeeModal() {
    document.getElementById("modal-employee").style.display = "none";
}

function handleSaveEmployee(e) {
    e.preventDefault();
    
    const empId = document.getElementById("emp-id").value;
    const employees = store.getEmployees();
    const allowancesConfig = store.getAllowancesConfig();

    const allowancesValues = {};
    allowancesConfig.forEach(allow => {
        const input = document.getElementById(`emp-allow-${allow.id}`);
        allowancesValues[allow.id] = input ? parseFloat(input.value) || 0 : allow.value;
    });
    
    let generatedId = empId;
    if (!generatedId) {
        let maxNum = 100;
        employees.forEach(e => {
            if (e.id && e.id.toUpperCase().startsWith("EMP")) {
                const num = parseInt(e.id.substring(3));
                if (!isNaN(num) && num > maxNum) {
                    maxNum = num;
                }
            }
        });
        generatedId = "EMP" + (maxNum + 1);
    }
    
    const employeeData = {
        id: generatedId,
        firstName: document.getElementById("emp-first-name").value,
        lastName: document.getElementById("emp-last-name").value,
        department: document.getElementById("emp-department").value,
        designation: document.getElementById("emp-designation").value,
        baseSalary: parseFloat(document.getElementById("emp-base-salary").value) || 0,
        joinDate: document.getElementById("emp-join-date").value,
        endDate: document.getElementById("emp-end-date").value,
        epfEligible: document.getElementById("emp-epf-eligible").checked,
        bankAcc: document.getElementById("emp-bank-acc").value,
        epfNo: document.getElementById("emp-epf-no").value,
        memberNo: document.getElementById("emp-member-no").value,
        nic: document.getElementById("emp-nic").value,
        dlNumber: document.getElementById("emp-dl-number").value,
        mobileNo: document.getElementById("emp-mobile").value,
        gender: document.getElementById("emp-gender").value,
        address: document.getElementById("emp-address") ? document.getElementById("emp-address").value.trim() : "",
        allowances: allowancesValues
    };

    if (empId) {
        const index = employees.findIndex(e => e.id === empId);
        if (index !== -1) employees[index] = employeeData;
    } else {
        employees.push(employeeData);
    }

    store.saveEmployees(employees);
    closeEmployeeModal();
    renderEmployees();
    updateDashboardStats();
}

function handleDeleteEmployee(empId) {
    if (confirm(`Are you sure you want to delete employee ${empId}?`)) {
        let employees = store.getEmployees();
        employees = employees.filter(e => e.id !== empId);
        store.saveEmployees(employees);
        
        // Clean up attendance
        let attendance = store.getAttendance() || [];
        const originalAttLength = attendance.length;
        attendance = attendance.filter(a => a.employeeId !== empId);
        if (attendance.length !== originalAttLength) store.saveAttendance(attendance);
        
        // Clean up leaves
        let leaves = store.getLeaves() || [];
        const originalLeavesLength = leaves.length;
        leaves = leaves.filter(l => l.employeeId !== empId);
        if (leaves.length !== originalLeavesLength) store.saveLeaves(leaves);
        
        renderEmployees();
        updateDashboardStats();
    }
}

// Attendance Modules
function renderAttendance() {
    const tbody = document.querySelector("#table-attendance tbody");
    tbody.innerHTML = "";
    
    const attendance = store.getAttendance();
    const employees = store.getEmployees();
    const filterDate = document.getElementById("attendance-date-filter").value;
    
    const searchTerm = document.getElementById('attendance-search')?.value.toLowerCase().trim() || '';

    // Sort employees alphabetically
    const sortedEmployees = [...employees].sort((a, b) => a.firstName.localeCompare(b.firstName));

    sortedEmployees.forEach(emp => {
        const name = `${emp.firstName} ${emp.lastName}`;
        if (searchTerm && !name.toLowerCase().includes(searchTerm) && !emp.id.toLowerCase().includes(searchTerm)) {
            return;
        }

        // Hide inactive employees if filterDate is after their end date
        if (emp.endDate && filterDate > emp.endDate) {
            return;
        }

        // Find attendance record for this date
        const item = attendance.find(a => a.employeeId === emp.id && a.date === filterDate);
        
        const tr = document.createElement("tr");
        
        if (item) {
            // Employee checked in / has an attendance record
            tr.innerHTML = `
                <td>
                    <div style="font-weight:600">${name}</div>
                    <div class="text-muted" style="font-size:12px">${emp.id}</div>
                </td>
                <td>${item.date}</td>
                <td>${item.checkIn || '-'}</td>
                <td>${item.checkOut || '-'}</td>
                <td>${item.isLeave ? '<strong>On Leave</strong>' : (item.workHours > 0 ? `${item.workHours.toFixed(2)} hrs` : 'In Progress')}</td>
                <td>${item.normalOt > 0 ? `<span class="badge badge-warning">${item.normalOt.toFixed(2)} hrs</span>` : '-'}</td>
                <td>${item.specialOt > 0 ? `<span class="badge badge-danger">${item.specialOt.toFixed(2)} hrs</span>` : '-'}</td>
                <td>
                    <button class="btn btn-danger btn-icon" onclick="handleDeleteAttendance('${emp.id}', '${item.date}')" style="padding: 6px 12px">
                        <i data-lucide="trash-2" style="width:14px; height:14px"></i>
                    </button>
                </td>
            `;
        } else {
            // Employee has no attendance record for this date - defaults to On Leave
            tr.innerHTML = `
                <td>
                    <div style="font-weight:600">${name}</div>
                    <div class="text-muted" style="font-size:12px">${emp.id}</div>
                </td>
                <td>${filterDate}</td>
                <td colspan="5" class="text-muted" style="text-align:center; font-style:italic;">
                    <span class="badge badge-danger" style="background-color: var(--danger-color); color: white;">On Leave / Absent</span>
                </td>
                <td>
                    <button class="btn btn-primary btn-icon" onclick="openAttendanceModalFor('${emp.id}', '${filterDate}')" style="padding: 6px 12px">
                        <i data-lucide="log-in" style="width:14px; height:14px"></i> Check In
                    </button>
                </td>
            `;
        }
        
        tbody.appendChild(tr);
    });

    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}
window.openAttendanceModalFor = function(empId, date) {
    openAttendanceModal();
    document.getElementById("att-employee").value = empId;
    document.getElementById("att-date").value = date;
};

function openAttendanceModal() {
    const modal = document.getElementById("modal-attendance");
    const select = document.getElementById("att-employee");
    select.innerHTML = "";
    
    const employees = store.getEmployees();
    employees.forEach(emp => {
        const opt = document.createElement("option");
        opt.value = emp.id;
        opt.textContent = `${emp.firstName} ${emp.lastName} (${emp.id})`;
        select.appendChild(opt);
    });

    document.getElementById("att-date").value = new Date().toISOString().substring(0, 10);
    document.getElementById("att-checkin").value = "08:00";
    document.getElementById("att-checkout").value = "17:00";
    document.getElementById("att-log-type").value = "both";
    
    document.getElementById("group-att-checkin").style.display = "block";
    document.getElementById("group-att-checkout").style.display = "block";

    if (!document.getElementById("att-extra-days")) {
        const footer = modal.querySelector(".modal-footer");
        const extraHTML = `
            <div class="form-row">
                <div class="form-group col-6">
                    <label for="att-extra-days">Extra Working Days</label>
                    <input type="number" id="att-extra-days" class="form-input" value="0" min="0">
                </div>
                <div class="form-group col-6">
                    <label for="att-meal-allowance">Early/Night/Meal Cost</label>
                    <input type="number" id="att-meal-allowance" class="form-input" value="0">
                </div>
            </div>
        `;
        footer.insertAdjacentHTML('beforebegin', extraHTML);
    }
    
    modal.style.display = "flex";
}

function closeAttendanceModal() {
    document.getElementById("modal-attendance").style.display = "none";
}

function handleSaveAttendance(e) {
    e.preventDefault();
    
    const empId = document.getElementById("att-employee").value;
    const dateStr = document.getElementById("att-date").value;
    const logType = document.getElementById("att-log-type").value;
    const extraDays = parseInt(document.getElementById("att-extra-days").value) || 0;
    const mealCost = parseFloat(document.getElementById("att-meal-allowance").value) || 0;
    const isHoliday = document.getElementById("att-is-holiday") ? document.getElementById("att-is-holiday").checked : false;
    const isLeave = document.getElementById("att-is-leave") ? document.getElementById("att-is-leave").checked : false;
    
    const attendanceList = store.getAttendance();
    const existingIndex = attendanceList.findIndex(a => a.employeeId === empId && a.date === dateStr);
    
    let checkInVal = "";
    let checkOutVal = "";
    
    if (logType === "both") {
        checkInVal = document.getElementById("att-checkin").value;
        checkOutVal = document.getElementById("att-checkout").value;
    } else if (logType === "in") {
        checkInVal = document.getElementById("att-checkin").value;
        checkOutVal = (existingIndex !== -1) ? attendanceList[existingIndex].checkOut : "";
    } else if (logType === "out") {
        checkInVal = (existingIndex !== -1) ? attendanceList[existingIndex].checkIn : "08:00";
        checkOutVal = document.getElementById("att-checkout").value;
    }

    // Calculate times and OT
    let hours = 0;
    let normalOt = 0;
    let specialOt = 0;

    if (checkInVal && checkOutVal) {
        const [inH, inM] = checkInVal.split(":").map(Number);
        const [outH, outM] = checkOutVal.split(":").map(Number);
        
        const inDecimal = inH + inM/60;
        const outDecimal = outH + outM/60;
        
        // Punch before 8:00 AM counts as 8:00 AM. Punch after 8:00 AM counts as actual punch time.
        const effectiveInDecimal = Math.max(8.00, inDecimal);
        
        hours = outDecimal - effectiveInDecimal;
        if (hours < 0) hours += 24;

        const dateObj = new Date(dateStr);
        const day = dateObj.getDay();

        if (isHoliday || day === 0) {
            // Sundays and Public Holidays: Special OT for the whole period
            specialOt = hours;
        } else if (day === 6) {
            // Saturday: Normal OT for first 9 hours, Special OT thereafter
            if (hours <= 9) {
                normalOt = hours;
            } else {
                normalOt = 9.00;
                specialOt = hours - 9;
            }
        } else {
            // Weekdays: First 9 standard working hours. Special OT starts after 9 hours of work.
            if (hours > 9) {
                specialOt = hours - 9;
            }
            normalOt = 0;
        }
    }

    if (isLeave) {
        checkInVal = "";
        checkOutVal = "";
        hours = 0;
        normalOt = 0;
        specialOt = 0;
    }

    // OT Decimals to 2 places
    normalOt = parseFloat(normalOt.toFixed(2));
    specialOt = parseFloat(specialOt.toFixed(2));

    const record = {
        employeeId: empId,
        date: dateStr,
        checkIn: checkInVal,
        checkOut: checkOutVal,
        workHours: hours,
        normalOt: normalOt,
        specialOt: specialOt,
        extraWorkingDays: extraDays,
        earlyNightMeal: mealCost,
        isHoliday: isHoliday,
        isLeave: isLeave
    };

    if (existingIndex !== -1) {
        attendanceList[existingIndex] = record;
    } else {
        attendanceList.push(record);
    }

    store.saveAttendance(attendanceList);
    
    // Reset Leave Checkbox
    const leaveCheckbox = document.getElementById("att-is-leave");
    if (leaveCheckbox) {
        leaveCheckbox.checked = false;
    }
    
    closeAttendanceModal();
    renderAttendance();
    updateDashboardStats();
}

function handleDeleteAttendance(empId, date) {
    if (confirm(`Delete attendance record for ${empId} on ${date}?`)) {
        let attendance = store.getAttendance();
        attendance = attendance.filter(a => !(a.employeeId === empId && a.date === date));
        store.saveAttendance(attendance);
        renderAttendance();
        updateDashboardStats();
    }
}

function openLeavesModal() {
    const modal = document.getElementById("modal-leaves");
    const datalist = document.getElementById("leave-employees-list");
    datalist.innerHTML = "";
    
    // Clear input
    document.getElementById("leave-employee-input").value = "";
    
    const employees = store.getEmployees() || [];
    employees.forEach(emp => {
        const option = document.createElement("option");
        option.value = `${emp.id} - ${emp.firstName} ${emp.lastName}`;
        datalist.appendChild(option);
    });
    
    // Set default dates to today
    const today = new Date().toISOString().substring(0, 10);
    document.getElementById("leave-start-date").value = today;
    document.getElementById("leave-end-date").value = today;
    
    modal.style.display = "flex";
}

function closeLeavesModal() {
    document.getElementById("modal-leaves").style.display = "none";
}

function handleSaveLeaves(e) {
    e.preventDefault();
    const empInputVal = document.getElementById("leave-employee-input").value;
    const empId = empInputVal.split(" - ")[0]; // Extract the EMP ID
    const startDateStr = document.getElementById("leave-start-date").value;
    const endDateStr = document.getElementById("leave-end-date").value;
    
    if (!empId || !startDateStr || !endDateStr) {
        alert("Please fill in all fields with valid information.");
        return;
    }
    
    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);
    
    if (endDate < startDate) {
        alert("End Date cannot be before Start Date.");
        return;
    }

    const attendanceList = store.getAttendance();
    
    // Loop through each day from start to end
    let currentDate = new Date(startDate);
    while (currentDate <= endDate) {
        const dateStr = currentDate.toISOString().substring(0, 10);
        
        const record = {
            employeeId: empId,
            date: dateStr,
            checkIn: "",
            checkOut: "",
            isLeave: true,
            workHours: 0,
            normalOt: 0,
            specialOt: 0,
            lateMins: 0,
            extraWorkingDays: 0,
            earlyNightMeal: 0
        };

        const existingIndex = attendanceList.findIndex(a => a.employeeId === empId && a.date === dateStr);
        if (existingIndex !== -1) {
            attendanceList[existingIndex] = record;
        } else {
            attendanceList.push(record);
        }
        
        // Go to next day
        currentDate.setDate(currentDate.getDate() + 1);
    }
    
    store.saveAttendance(attendanceList);
    closeLeavesModal();
    renderAttendance();
    updateDashboardStats();
    alert("Leaves marked successfully!");
}

function openMonthlyAttendanceModal() {
    document.getElementById("modal-monthly-attendance").style.display = "flex";
    const monthSelect = document.getElementById("monthly-attendance-month-select");
    if (!monthSelect.value) {
        monthSelect.value = new Date().toISOString().substring(0, 7);
    }
    
    // Populate employee select
    const empSelect = document.getElementById("monthly-attendance-emp-select");
    const employees = store.getEmployees() || [];
    const currentVal = empSelect.value;
    empSelect.innerHTML = `<option value="ALL">All Employees (Summary)</option>`;
    employees.forEach(emp => {
        empSelect.innerHTML += `<option value="${emp.id}">${emp.firstName} ${emp.lastName} (${emp.id})</option>`;
    });
    if (currentVal && currentVal !== "ALL" && employees.some(e => e.id === currentVal)) {
        empSelect.value = currentVal;
    }
    
    renderMonthlyAttendanceReport();
}

function renderMonthlyAttendanceReport() {
    const month = document.getElementById("monthly-attendance-month-select").value;
    const empId = document.getElementById("monthly-attendance-emp-select") ? document.getElementById("monthly-attendance-emp-select").value : "ALL";
    const container = document.getElementById("monthly-attendance-report-container");
    
    if (!month) {
        container.innerHTML = "<p>Please select a month.</p>";
        return;
    }
    
    const employees = store.getEmployees() || [];
    const attendance = store.getAttendance() || [];
    const settings = store.getSettings() || { stdWorkDays: 26 };
    
    if (empId === "ALL" || !empId) {
        let html = `
            <h3 style="margin-bottom:15px; text-align:center;">Monthly Attendance Summary - ${month}</h3>
            <table class="data-table" style="width:100%">
                <thead>
                    <tr>
                        <th>Employee Name</th>
                        <th>Days Present</th>
                        <th>Days Absent (Based on ${settings.stdWorkDays} std. days)</th>
                        <th>Normal OT (hrs)</th>
                        <th>Special OT (hrs)</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        let totalPresent = 0;
        
        employees.forEach(emp => {
            if (emp.endDate && emp.endDate < `${month}-01`) return;

            const empAtt = attendance.filter(a => a.employeeId === emp.id && a.date && a.date.startsWith(month));
            
            const daysPresent = empAtt.filter(a => a.checkIn || (!a.checkIn && !a.isLeave)).length;
            
            let daysAbsent = settings.stdWorkDays - daysPresent;
            if (daysAbsent < 0) daysAbsent = 0;
            
            const normalOt = empAtt.reduce((sum, a) => sum + (a.normalOt || 0), 0);
            const specialOt = empAtt.reduce((sum, a) => sum + (a.specialOt || 0), 0);
            
            totalPresent += daysPresent;
            
            html += `
                <tr>
                    <td><strong>${emp.firstName} ${emp.lastName}</strong> <span class="text-muted" style="font-size:12px;">(${emp.id})</span></td>
                    <td>${daysPresent}</td>
                    <td>${daysAbsent}</td>
                    <td>${normalOt.toFixed(2)}</td>
                    <td>${specialOt.toFixed(2)}</td>
                </tr>
            `;
        });
        
        if (employees.length === 0) {
            html += `<tr><td colspan="5" style="text-align:center;">No employees found</td></tr>`;
        }
        
        html += `
                </tbody>
            </table>
        `;
        
        container.innerHTML = html;
    } else {
        const emp = employees.find(e => e.id === empId);
        if (!emp) {
            container.innerHTML = "<p>Employee not found.</p>";
            return;
        }
        
        const empAtt = attendance.filter(a => a.employeeId === emp.id && a.date && a.date.startsWith(month));
        empAtt.sort((a, b) => a.date.localeCompare(b.date));
        
        const daysPresent = empAtt.filter(a => a.checkIn || (!a.checkIn && !a.isLeave)).length;
        let daysAbsent = settings.stdWorkDays - daysPresent;
        if (daysAbsent < 0) daysAbsent = 0;
        
        const normalOt = empAtt.reduce((sum, a) => sum + (a.normalOt || 0), 0);
        const specialOt = empAtt.reduce((sum, a) => sum + (a.specialOt || 0), 0);
        
        let html = `
            <div style="text-align:center; margin-bottom: 20px;">
                <h3 style="margin-bottom:5px;">Monthly Attendance - ${month}</h3>
                <p style="font-size: 16px;"><strong>${emp.firstName} ${emp.lastName}</strong> (${emp.id})</p>
                <div style="display:flex; justify-content:center; gap:20px; margin-top: 10px; font-size: 14px;">
                    <div>Present: <strong>${daysPresent}</strong></div>
                    <div>Absent (Std): <strong>${daysAbsent}</strong></div>
                    <div>Normal OT: <strong>${normalOt.toFixed(2)}h</strong></div>
                    <div>Special OT: <strong>${specialOt.toFixed(2)}h</strong></div>
                </div>
            </div>
            
            <table class="data-table" style="width:100%">
                <thead>
                    <tr>
                        <th>Date</th>
                        <th>In Time</th>
                        <th>Out Time</th>
                        <th>Work Hours</th>
                        <th>Normal OT</th>
                        <th>Special OT</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
        `;
        
        const [year, monthNum] = month.split('-');
        const daysInMonth = new Date(year, monthNum, 0).getDate();
        const allDays = [];
        for (let i = 1; i <= daysInMonth; i++) {
            const dayStr = String(i).padStart(2, '0');
            allDays.push(`${month}-${dayStr}`);
        }
        
        allDays.forEach(dateStr => {
            const a = empAtt.find(att => att.date === dateStr);
            if (a) {
                let statusHtml = '';
                if (a.isLeave) {
                    statusHtml = `<span class="badge" style="background-color: var(--warning); color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Leave</span>`;
                } else if (a.checkIn) {
                    statusHtml = `<span class="badge" style="background-color: var(--success); color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Present</span>`;
                } else {
                    statusHtml = `<span class="badge" style="background-color: var(--danger); color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Manual/Absent</span>`;
                }
                
                html += `
                    <tr>
                        <td>${a.date}</td>
                        <td>${a.checkIn || '-'}</td>
                        <td>${a.checkOut || '-'}</td>
                        <td>${a.workHours ? a.workHours.toFixed(2) : '-'}</td>
                        <td>${a.normalOt ? a.normalOt.toFixed(2) : '-'}</td>
                        <td>${a.specialOt ? a.specialOt.toFixed(2) : '-'}</td>
                        <td>${statusHtml}</td>
                    </tr>
                `;
            } else {
                html += `
                    <tr>
                        <td>${dateStr}</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td>-</td>
                        <td><span class="badge" style="background-color: var(--danger); color: white; padding: 2px 6px; border-radius: 4px; font-size: 11px;">Absent</span></td>
                    </tr>
                `;
            }
        });
        
        html += `
                </tbody>
            </table>
        `;
        
        container.innerHTML = html;
    }
}

// Sri Lankan EPF/ETF Style Payroll Processing Module
function processPayrollRun() {
    try {
    const round2 = (num) => Math.round((num + Number.EPSILON) * 100) / 100;
    const selectedMonth = document.getElementById("payroll-month-select").value;
    if (!selectedMonth) {
        alert("Please select a Pay Cycle (month) before processing.");
        return;
    }
    const employees = store.getEmployees() || [];
    const attendance = store.getAttendance() || [];
    const leaves = store.getLeaves() || [];
    const settings = store.getSettings() || { stdWorkDays: 26, stdWorkHours: 8, normalOtRate: 1.5, specialOtRate: 2.0, taxRate: 0 };
    const allowancesConfig = store.getAllowancesConfig() || [];
    const adjustments = (store.getAdjustments() || {})[selectedMonth] || {};

    const runs = [];

    employees.forEach(emp => {
        // Skip inactive employees if their end date is before the start of the selected month
        if (emp.endDate && emp.endDate < `${selectedMonth}-01`) return;

        const empAdjust = adjustments[emp.id] || {
            salaryArrears: 0,
            salesIncentive: 0,
            nitSalesIncentive: 0,
            vgdSalesIncentive: 0,
            welfare: 0,
            salaryAdvance: 0,
            cashLosses: 0,
            festivalAdvance: 0,
            loanInstalment: 0,
            pvtPhoneUsage: 0,
            deduRedDots: 0,
            allowanceDeductions: {},
            manualDaysWorked: "",
            manualLeaveTaken: "",
            manualNoPayDays: "",
            manualNormalOtHours: "",
            manualSpecialOtHours: ""
        };

        const empAttendance = attendance.filter(a => a.employeeId === emp.id && a.date && a.date.startsWith(selectedMonth));
        const calcNormalOtHours = empAttendance.reduce((sum, a) => sum + (a.normalOt || 0), 0);
        const normalOtHours = (empAdjust.manualNormalOtHours !== undefined && empAdjust.manualNormalOtHours !== "") ? parseFloat(empAdjust.manualNormalOtHours) : calcNormalOtHours;
        
        const calcSpecialOtHours = empAttendance.reduce((sum, a) => sum + (a.specialOt || 0), 0);
        const specialOtHours = (empAdjust.manualSpecialOtHours !== undefined && empAdjust.manualSpecialOtHours !== "") ? parseFloat(empAdjust.manualSpecialOtHours) : calcSpecialOtHours;
        
        const extraWorkingDays = empAttendance.reduce((sum, a) => sum + (a.extraWorkingDays || 0), 0);
        const loggedMealAllowance = empAttendance.reduce((sum, a) => sum + (a.earlyNightMeal || 0), 0);
        
        const [yearPart, monthPart] = selectedMonth.split("-");
        const daysInMonth = new Date(parseInt(yearPart), parseInt(monthPart), 0).getDate(); // actual days in month
        const stdWorkHours = settings.stdWorkHours || 8;

        // Auto leave calculation: any day without a check-in is considered a leave
        const checkedInDays = empAttendance.filter(a => !a.isLeave).length;
        let leaveTaken = Math.max(0, daysInMonth - checkedInDays);
        if (empAdjust.manualLeaveTaken !== undefined && empAdjust.manualLeaveTaken !== "") leaveTaken = parseFloat(empAdjust.manualLeaveTaken);
        
        // Paid leaves allowed (customizable in settings, defaults to 4)
        const allowedPaidDays = settings.paidLeaves !== undefined ? settings.paidLeaves : 4;
        let noPayDays = Math.max(0, leaveTaken - allowedPaidDays);
        if (empAdjust.manualNoPayDays !== undefined && empAdjust.manualNoPayDays !== "") noPayDays = parseFloat(empAdjust.manualNoPayDays);
        
        let daysWorked = Math.max(0, daysInMonth - noPayDays + extraWorkingDays);
        if (empAdjust.manualDaysWorked !== undefined && empAdjust.manualDaysWorked !== "") daysWorked = parseFloat(empAdjust.manualDaysWorked);

        const empBaseSalary = emp.baseSalary || 0;
        const baseHourlyRate = empBaseSalary / 240;
const otRate = Math.ceil(baseHourlyRate * 1.5);
const specialOtRateVal = Math.ceil(baseHourlyRate * 2.0);

        const normalOtPay = round2(normalOtHours * otRate);
        const specialOtPay = round2(specialOtHours * specialOtRateVal);
        
        const noPayDeductions = round2(noPayDays * (empBaseSalary / 30));
        const totalEarnings = round2(empBaseSalary + (empAdjust.salaryArrears || 0));
        const totalForEpf = round2(Math.max(0, totalEarnings - noPayDeductions));

        const allowancesData = [];
        let totalDynamicAllowances = 0;
        let totalDynamicDeductions = 0;

        allowancesConfig.forEach(allow => {
            // Safely look up allowance value - allow.id may be undefined if config was saved without it
            let val = (allow.value || 0);
            if (emp.allowances) {
                if (allow.id && emp.allowances[allow.id] !== undefined) {
                    val = emp.allowances[allow.id];
                } else {
                    // Fallback: search emp.allowances for any key that matches this allowance
                    const keys = Object.keys(emp.allowances);
                    const matchingKey = keys.find(k => k === allow.id);
                    if (matchingKey !== undefined) val = emp.allowances[matchingKey];
                }
            }
            
            let autoNoPayAllowDeduct = 0;
            const isAttendance = (allow.id === "att_incentive" || allow.name.toLowerCase().includes("attendance"));

            if (noPayDays > 0) {
                if (isAttendance) {
                    autoNoPayAllowDeduct = val;
                } else {
                    autoNoPayAllowDeduct = round2((val / 30) * noPayDays);
                }
            }

            const manualDed = (empAdjust.allowanceDeductions && empAdjust.allowanceDeductions[allow.id] !== undefined) ? empAdjust.allowanceDeductions[allow.id] : 0;
            const ded = round2(Math.min(val, autoNoPayAllowDeduct + manualDed));
            
            allowancesData.push({
                id: allow.id,
                name: allow.name,
                value: val,
                deduction: ded
            });

            totalDynamicAllowances = round2(totalDynamicAllowances + val);
            totalDynamicDeductions = round2(totalDynamicDeductions + ded);
        });

        const earlyNightMeal = loggedMealAllowance;

        // Gross Salary = Full Basic + All Allowances (full, before deductions) + OT + Meal + Arrears + Sales Incentive
        const grossSalary = round2(empBaseSalary + (empAdjust.salaryArrears || 0) + (empAdjust.salesIncentive || 0) + (empAdjust.nitSalesIncentive || 0) + (empAdjust.vgdSalesIncentive || 0) + totalDynamicAllowances + earlyNightMeal + normalOtPay + specialOtPay);

        // EPF/ETF calculated on (Basic - No-Pay), i.e. totalForEpf
        const isEpfEligible = emp.epfEligible !== false;
        const epfEmployeeCont = round2(isEpfEligible ? (totalForEpf * 0.08) : 0);

        // Net Salary = Gross - No-Pay Deduction - Allowance Deductions - EPF(emp) - Other Deductions
        const totalDeductions = round2(noPayDeductions +
                                totalDynamicDeductions +
                                epfEmployeeCont +
                                (empAdjust.welfare || 0) +
                                (empAdjust.salaryAdvance || 0) +
                                (empAdjust.cashLosses || 0) +
                                (empAdjust.festivalAdvance || 0) +
                                (empAdjust.loanInstalment || 0) +
                                (empAdjust.pvtPhoneUsage || 0) +
                                (empAdjust.deduRedDots || 0));

        const netSalary = round2(Math.max(0, grossSalary - totalDeductions));
        const roundedNetSalary = netSalary;

        const epfEmployerCont = round2(isEpfEligible ? (totalForEpf * 0.12) : 0);
        const totalEpf = round2(epfEmployeeCont + epfEmployerCont);
        const etfEmployerCont = round2(isEpfEligible ? (totalForEpf * 0.03) : 0);

        runs.push({
            employeeId: emp.id,
            epfNo: emp.epfNo || "",
            memberNo: emp.memberNo || "",
            nic: emp.nic || "",
            mobileNo: emp.mobileNo || "",
            name: `${emp.firstName || ''} ${emp.lastName || ''}`,
            designation: emp.designation || "",
            department: emp.department || "",
            bankAcc: emp.bankAcc || "",
            
            basicSalary: empBaseSalary,
            daysWorked,
            leaveTaken,
            noPayDays,
            normalOtHours,
            specialOtHours,
            extraWorkingDays,
            otRate,
            specialOtRateVal,
            
            salaryArrears: empAdjust.salaryArrears || 0,
            salesIncentive: empAdjust.salesIncentive || 0,
            nitSalesIncentive: empAdjust.nitSalesIncentive || 0,
            vgdSalesIncentive: empAdjust.vgdSalesIncentive || 0,
            totalEarnings,
            noPayDeductions,
            totalForEpf,
            
            allowancesData,
            earlyNightMeal,
            normalOtPay,
            specialOtPay,
            grossSalary,
            
            welfare: empAdjust.welfare || 0,
            salaryAdvance: empAdjust.salaryAdvance || 0,
            cashLosses: empAdjust.cashLosses || 0,
            festivalAdvance: empAdjust.festivalAdvance || 0,
            loanInstalment: empAdjust.loanInstalment || 0,
            pvtPhoneUsage: empAdjust.pvtPhoneUsage || 0,
            deduRedDots: empAdjust.deduRedDots || 0,
            totalDynamicDeductions,
            epfEmployeeCont,
            totalDeductions,
            
            netSalary,
            roundedNetSalary,
            
            epfEmployerCont,
            totalEpf,
            etfEmployerCont,
            status: "Processed"
        });
    });

    try {
        store.savePayrollRuns(selectedMonth, runs);
    } catch(e) { console.error("Error saving payroll runs", e); }
    
    renderPayroll();
    updateDashboardStats();
    alert(`Successfully processed payroll details for ${selectedMonth}`);
    } catch(err) {
        console.error("Payroll processing error:", err);
        alert("Error processing payroll: " + err.message);
    }
}

function filterPayrollTable() {
    const input = document.getElementById('payroll-search-input');
    if (!input) return;
    const searchTerm = input.value.toLowerCase().trim();
    const tbody = document.querySelector('#table-payroll tbody');
    const rows = tbody.querySelectorAll('tr:not(.search-empty-row)');
    
    let visibleCount = 0;
    rows.forEach(row => {
        if (row.children.length > 1) {
            const id = row.children[0].textContent.toLowerCase();
            const name = row.children[1].textContent.toLowerCase();
            if (id.includes(searchTerm) || name.includes(searchTerm)) {
                row.style.display = '';
                visibleCount++;
            } else {
                row.style.display = 'none';
            }
        }
    });

    // Remove existing empty state if any
    const existingEmpty = tbody.querySelector('.search-empty-row');
    if (existingEmpty) existingEmpty.remove();

    // Show empty state if no matches
    if (rows.length === 0) {
        const tr = document.createElement('tr');
        tr.className = 'search-empty-row';
        tr.innerHTML = `<td colspan="8" style="text-align: center; padding: 24px; color: var(--text-secondary)">Please click "Process & Recalculate" first to generate the payroll for this month.</td>`;
        tbody.appendChild(tr);
    } else if (visibleCount === 0) {
        const tr = document.createElement('tr');
        tr.className = 'search-empty-row';
        tr.innerHTML = `<td colspan="8" style="text-align: center; padding: 24px; color: var(--text-secondary)">No employee found matching "${input.value}" in this pay cycle.</td>`;
        tbody.appendChild(tr);
    }
}

function renderPayroll() {
    const tbody = document.querySelector("#table-payroll tbody");
    tbody.innerHTML = "";
    
    const selectedMonth = document.getElementById("payroll-month-select").value;
    
    let runs = [];
    try {
        runs = store.getPayrollRuns(selectedMonth);
    } catch(e) { runs = []; }

    if (runs.length === 0) {
        tbody.innerHTML = "";
        return;
    }

    runs.forEach(run => {
        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>${run.employeeId}</strong><br><small class="text-muted">${run.epfNo || 'No EPF'}</small></td>
            <td>${run.name}</td>
            <td>LKR ${run.basicSalary.toFixed(2)}</td>
            <td>LKR ${(run.normalOtPay + run.specialOtPay).toFixed(2)}</td>
            <td>${run.noPayDeductions > 0 ? `<span class="badge badge-danger">-LKR ${run.noPayDeductions.toFixed(2)}</span>` : 'LKR 0.00'}</td>
            <td><strong>LKR ${run.roundedNetSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</strong></td>
            <td>
                <button class="btn btn-secondary btn-icon" onclick="openAdjustmentModal('${selectedMonth}', '${run.employeeId}')" style="padding: 6px 12px">
                    <i data-lucide="sliders" style="width:14px; height:14px"></i> Adjust
                </button>
            </td>
            <td>
                <button class="btn btn-success btn-icon" onclick="viewPayslip('${selectedMonth}', '${run.employeeId}')" style="padding: 6px 12px">
                    <i data-lucide="eye" style="width:14px; height:14px"></i> Payslip
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
    
    // Apply search filter if any
    filterPayrollTable();
}

function openAdjustmentModal(month, empId) {
    const adjustments = store.getAdjustments();
    const allowancesConfig = store.getAllowancesConfig();
    const attendance = store.getAttendance() || [];
    const settings = store.getSettings() || {};

    if (!adjustments[month]) adjustments[month] = {};
    if (!adjustments[month][empId]) {
        adjustments[month][empId] = {
            salaryArrears: 0,
            salesIncentive: 0,
            nitSalesIncentive: 0,
            vgdSalesIncentive: 0,
            welfare: 0,
            salaryAdvance: 0,
            cashLosses: 0,
            festivalAdvance: 0,
            loanInstalment: 0,
            pvtPhoneUsage: 0,
            deduRedDots: 0,
            allowanceDeductions: {}
        };
    }

    const val = adjustments[month][empId];
    if (!val.allowanceDeductions) val.allowanceDeductions = {};

    // Calculate auto attendance values
    const empAttendance = attendance.filter(a => a.employeeId === empId && a.date && a.date.startsWith(month));
    const calcNormalOtHours = empAttendance.reduce((sum, a) => sum + (a.normalOt || 0), 0);
    const calcSpecialOtHours = empAttendance.reduce((sum, a) => sum + (a.specialOt || 0), 0);
    const extraWorkingDays = empAttendance.reduce((sum, a) => sum + (a.extraWorkingDays || 0), 0);
    
    const [yearPart, monthPart] = month.split("-");
    const daysInMonth = new Date(parseInt(yearPart), parseInt(monthPart), 0).getDate();
    const checkedInDays = empAttendance.filter(a => !a.isLeave).length;
    const calcLeaveTaken = Math.max(0, daysInMonth - checkedInDays);
    const allowedPaidDays = settings.paidLeaves !== undefined ? settings.paidLeaves : 4;
    const calcNoPayDays = Math.max(0, calcLeaveTaken - allowedPaidDays);
    const calcDaysWorked = Math.max(0, daysInMonth - calcNoPayDays + extraWorkingDays);

    let modal = document.getElementById("modal-adjustment");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "modal-adjustment";
        modal.className = "modal-overlay";
        document.body.appendChild(modal);
    }

    let deductionsHTML = "";
    for (let i = 0; i < allowancesConfig.length; i += 2) {
        const item1 = allowancesConfig[i];
        const item2 = allowancesConfig[i+1];
        
        const ded1 = val.allowanceDeductions[item1.id] || 0;
        const ded2 = item2 ? (val.allowanceDeductions[item2.id] || 0) : 0;

        deductionsHTML += `
            <div class="form-row">
                <div class="form-group col-6">
                    <label for="adj-dedu-${item1.id}">${item1.name} Recovery / Penalty (LKR)</label>
                    <input type="number" id="adj-dedu-${item1.id}" class="form-input" value="${ded1}">
                </div>
                ${item2 ? `
                <div class="form-group col-6">
                    <label for="adj-dedu-${item2.id}">${item2.name} Recovery / Penalty (LKR)</label>
                    <input type="number" id="adj-dedu-${item2.id}" class="form-input" value="${ded2}">
                </div>
                ` : '<div class="form-group col-6"></div>'}
            </div>
        `;
    }

    modal.innerHTML = `
        <div class="modal-container" style="max-width: 700px;">
            <div class="modal-header">
                <h3>Monthly Adjustments for Employee ${empId} (${month})</h3>
                <button class="modal-close" onclick="document.getElementById('modal-adjustment').style.display='none'">&times;</button>
            </div>
            <div class="modal-body" style="max-height: 70vh;">
                <form id="form-adjustment">
                    <h4 style="margin-bottom:12px; border-bottom:1px solid var(--border-color)">Manual Attendance Overrides</h4>
                    <p style="font-size: 0.85rem; color: #666; margin-bottom: 12px;">Leave empty to use system-calculated values from attendance.</p>
                    <div class="form-row">
                        <div class="form-group col-4">
                            <label for="adj-days-worked">Days Worked</label>
                            <input type="number" step="0.5" id="adj-days-worked" class="form-input" value="${val.manualDaysWorked !== undefined ? val.manualDaysWorked : ''}" placeholder="${calcDaysWorked}">
                            <small style="color:#666; font-size:0.75rem;">System: ${calcDaysWorked}</small>
                        </div>
                        <div class="form-group col-4">
                            <label for="adj-leave-taken">Leave Taken</label>
                            <input type="number" step="0.5" id="adj-leave-taken" class="form-input" value="${val.manualLeaveTaken !== undefined ? val.manualLeaveTaken : ''}" placeholder="${calcLeaveTaken}">
                            <small style="color:#666; font-size:0.75rem;">System: ${calcLeaveTaken}</small>
                        </div>
                        <div class="form-group col-4">
                            <label for="adj-no-pay">No Pay Days</label>
                            <input type="number" step="0.5" id="adj-no-pay" class="form-input" value="${val.manualNoPayDays !== undefined ? val.manualNoPayDays : ''}" placeholder="${calcNoPayDays}">
                            <small style="color:#666; font-size:0.75rem;">System: ${calcNoPayDays}</small>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-normal-ot">Normal OT (Hours)</label>
                            <input type="number" step="0.5" id="adj-normal-ot" class="form-input" value="${val.manualNormalOtHours !== undefined ? val.manualNormalOtHours : ''}" placeholder="${calcNormalOtHours}">
                            <small style="color:#666; font-size:0.75rem;">System: ${calcNormalOtHours}</small>
                        </div>
                        <div class="form-group col-6">
                            <label for="adj-special-ot">Special OT (Hours)</label>
                            <input type="number" step="0.5" id="adj-special-ot" class="form-input" value="${val.manualSpecialOtHours !== undefined ? val.manualSpecialOtHours : ''}" placeholder="${calcSpecialOtHours}">
                            <small style="color:#666; font-size:0.75rem;">System: ${calcSpecialOtHours}</small>
                        </div>
                    </div>

                    <h4 style="margin:16px 0 12px; border-bottom:1px solid var(--border-color)">Earnings Adjustment</h4>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-arrears">Salary Arrears (LKR)</label>
                            <input type="number" id="adj-arrears" class="form-input" value="${val.salaryArrears || 0}">
                        </div>
                        <div class="form-group col-6">
                            <label for="adj-sales-incentive">Sales Incentive (LKR)</label>
                            <input type="number" id="adj-sales-incentive" class="form-input" value="${val.salesIncentive || 0}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-nit-sales-incentive">NIT. Sales Incentive (LKR)</label>
                            <input type="number" id="adj-nit-sales-incentive" class="form-input" value="${val.nitSalesIncentive || 0}">
                        </div>
                        <div class="form-group col-6">
                            <label for="adj-vgd-sales-incentive">VGD. Sales Incentive (LKR)</label>
                            <input type="number" id="adj-vgd-sales-incentive" class="form-input" value="${val.vgdSalesIncentive || 0}">
                        </div>
                    </div>
                    
                    <h4 style="margin:16px 0 12px; border-bottom:1px solid var(--border-color)">Deductions / Recovery</h4>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-welfare">Welfare (LKR)</label>
                            <input type="number" id="adj-welfare" class="form-input" value="${val.welfare || 0}">
                        </div>
                        <div class="form-group col-6">
                            <label for="adj-advance">Salary Advance (LKR)</label>
                            <input type="number" id="adj-advance" class="form-input" value="${val.salaryAdvance || 0}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-losses">Cash Losses (LKR)</label>
                            <input type="number" id="adj-losses" class="form-input" value="${val.cashLosses || 0}">
                        </div>
                        <div class="form-group col-6">
                            <label for="adj-festival">Festival Advance (LKR)</label>
                            <input type="number" id="adj-festival" class="form-input" value="${val.festivalAdvance || 0}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-loan">Loan Instalment (LKR)</label>
                            <input type="number" id="adj-loan" class="form-input" value="${val.loanInstalment || 0}">
                        </div>
                        <div class="form-group col-6">
                            <label for="adj-phone">Pvt Office Phone Usage (LKR)</label>
                            <input type="number" id="adj-phone" class="form-input" value="${val.pvtPhoneUsage || 0}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="adj-reddots">Dedu. For Red Dots (LKR)</label>
                            <input type="number" id="adj-reddots" class="form-input" value="${val.deduRedDots || 0}">
                        </div>
                    </div>
                    
                    <h4 style="margin:16px 0 12px; border-bottom:1px solid var(--border-color)">Penalty Deductions (Allowance Recoveries)</h4>
                    ${deductionsHTML}
                    
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('modal-adjustment').style.display='none'">Cancel</button>
                        <button type="submit" class="btn btn-primary">Save Adjustments</button>
                    </div>
                </form>
            </div>
        </div>
    `;

    modal.style.display = "flex";

    document.getElementById("form-adjustment").addEventListener("submit", (e) => {
        e.preventDefault();

        const allowanceDeds = {};
        allowancesConfig.forEach(allow => {
            const input = document.getElementById(`adj-dedu-${allow.id}`);
            allowanceDeds[allow.id] = input ? parseFloat(input.value) || 0 : 0;
        });

        adjustments[month][empId] = {
            manualDaysWorked: document.getElementById("adj-days-worked").value,
            manualLeaveTaken: document.getElementById("adj-leave-taken").value,
            manualNoPayDays: document.getElementById("adj-no-pay").value,
            manualNormalOtHours: document.getElementById("adj-normal-ot").value,
            manualSpecialOtHours: document.getElementById("adj-special-ot").value,
            salaryArrears: parseFloat(document.getElementById("adj-arrears").value) || 0,
            salesIncentive: parseFloat(document.getElementById("adj-sales-incentive").value) || 0,
            nitSalesIncentive: parseFloat(document.getElementById("adj-nit-sales-incentive").value) || 0,
            vgdSalesIncentive: parseFloat(document.getElementById("adj-vgd-sales-incentive").value) || 0,
            welfare: parseFloat(document.getElementById("adj-welfare").value) || 0,
            salaryAdvance: parseFloat(document.getElementById("adj-advance").value) || 0,
            cashLosses: parseFloat(document.getElementById("adj-losses").value) || 0,
            festivalAdvance: parseFloat(document.getElementById("adj-festival").value) || 0,
            loanInstalment: parseFloat(document.getElementById("adj-loan").value) || 0,
            pvtPhoneUsage: parseFloat(document.getElementById("adj-phone").value) || 0,
            deduRedDots: parseFloat(document.getElementById("adj-reddots").value) || 0,
            allowanceDeductions: allowanceDeds
        };

        store.saveAdjustments(adjustments);
        modal.style.display = "none";
        processPayrollRun();
    });
}

function viewPayslip(month, empId) {
    let runs = [];
    try {
        runs = store.getPayrollRuns(month);
    } catch(e) { runs = []; }

    const run = runs.find(r => r.employeeId === empId);
    if (!run) return;

    const employees = store.getEmployees();
    const emp = employees.find(e => e.id === empId) || {};
    const departmentName = emp.department || 'N/A';

    const dateObj = new Date(month + "-01");
    const monthStr = dateObj.toLocaleString('default', { month: 'long', year: 'numeric' });

    const modal = document.getElementById("modal-payslip");
    const container = document.getElementById("payslip-print-content");
    
    let earningsRowsHTML = "";
    run.allowancesData.forEach(allow => {
        if (allow.value > 0) {
            earningsRowsHTML += `<div class="payslip-row"><div>${allow.name}</div><div>LKR ${allow.value.toFixed(2)}</div></div>`;
        }
    });

    let deductionsRowsHTML = "";
    run.allowancesData.forEach(allow => {
        if (allow.deduction > 0) {
            deductionsRowsHTML += `<div class="payslip-row"><div>${allow.name} (Penalty)</div><div>LKR ${allow.deduction.toFixed(2)}</div></div>`;
        }
    });

    container.innerHTML = `
        <div class="payslip-box" style="border: 2px solid #000; padding: 20px; box-sizing: border-box;">
            <div style="text-align: center; border-bottom: 2px dashed #1e293b; padding-bottom: 12px; margin-bottom: 16px;">
                <h3 style="font-weight: 700; font-size: 16px; margin: 0; text-transform: uppercase;">${departmentName} - Payslip for ${monthStr}</h3>
                <div style="font-size: 13px; font-weight: 600; margin-top: 4px;">EPF NO: ${run.epfNo || 'N/A'}</div>
                <div style="font-size: 14px; font-weight: 700; margin-top: 2px; text-transform: uppercase;">EMPLOYEE NAME: ${run.name}</div>
            </div>
            
            <div class="payslip-meta-grid" style="border-bottom: 1px solid var(--border-color); padding-bottom: 12px; margin-bottom: 12px;">
                <div class="payslip-meta-col">
                    <div><span>Basic Salary:</span> LKR ${run.basicSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                    <div><span>Days Worked:</span> ${run.daysWorked}</div>
                    ${run.leaveTaken > 0 ? `<div><span>Leave Taken:</span> ${run.leaveTaken}</div>` : ''}
                    ${run.noPayDays > 0 ? `<div><span>No Pay Days:</span> ${run.noPayDays}</div>` : ''}
                    ${run.normalOtHours > 0 ? `<div><span>Normal OT Hours:</span> ${run.normalOtHours.toFixed(2)} hrs</div>` : ''}
                    ${run.specialOtHours > 0 ? `<div><span>Special OT Hours:</span> ${run.specialOtHours.toFixed(2)} hrs</div>` : ''}
                    ${run.extraWorkingDays > 0 ? `<div><span>Extra Working Days:</span> ${run.extraWorkingDays}</div>` : ''}
                </div>
                <div class="payslip-meta-col" style="text-align: right">
                    ${run.otRate > 0 ? `<div><span>OT Rate:</span> LKR ${run.otRate.toFixed(2)}</div>` : ''}
                    ${run.specialOtRateVal > 0 ? `<div><span>Special OT Rate:</span> LKR ${run.specialOtRateVal.toFixed(2)}</div>` : ''}
                    ${run.salaryArrears > 0 ? `<div><span>Salary Arrears:</span> LKR ${run.salaryArrears.toFixed(2)}</div>` : ''}
                    ${run.salesIncentive > 0 ? `<div><span>Sales Incentive:</span> LKR ${run.salesIncentive.toFixed(2)}</div>` : ''}
                    ${run.nitSalesIncentive > 0 ? `<div><span>NIT. Sales Incentive:</span> LKR ${run.nitSalesIncentive.toFixed(2)}</div>` : ''}
                    ${run.vgdSalesIncentive > 0 ? `<div><span>VGD. Sales Incentive:</span> LKR ${run.vgdSalesIncentive.toFixed(2)}</div>` : ''}
                    <div><span>Total Earnings:</span> LKR ${run.totalEarnings.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                    ${run.noPayDeductions > 0 ? `<div><span>No Pay Deductions:</span> LKR ${run.noPayDeductions.toFixed(2)}</div>` : ''}
                    <div style="font-weight: 700;"><span>Total for E.P.F:</span> LKR ${run.totalForEpf.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                </div>
            </div>
            
            <div class="payslip-table-grid" style="margin-bottom: 16px;">
                <div>
                    <div class="payslip-sec-title">Earnings & Incentives</div>
                    <div class="payslip-row"><div>Basic Salary</div><div>LKR ${run.basicSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
                    ${run.salaryArrears > 0 ? `<div class="payslip-row"><div>Salary Arrears</div><div>LKR ${run.salaryArrears.toFixed(2)}</div></div>` : ''}
                    ${run.salesIncentive > 0 ? `<div class="payslip-row"><div>Sales Incentive</div><div>LKR ${run.salesIncentive.toFixed(2)}</div></div>` : ''}
                    ${run.nitSalesIncentive > 0 ? `<div class="payslip-row"><div>NIT. Sales Incentive</div><div>LKR ${run.nitSalesIncentive.toFixed(2)}</div></div>` : ''}
                    ${run.vgdSalesIncentive > 0 ? `<div class="payslip-row"><div>VGD. Sales Incentive</div><div>LKR ${run.vgdSalesIncentive.toFixed(2)}</div></div>` : ''}
                    ${earningsRowsHTML}
                    ${run.earlyNightMeal > 0 ? `<div class="payslip-row"><div>Early & Night & Meal</div><div>LKR ${run.earlyNightMeal.toFixed(2)}</div></div>` : ''}
                    ${run.normalOtPay > 0 ? `<div class="payslip-row"><div>Normal OT</div><div>LKR ${run.normalOtPay.toFixed(2)}</div></div>` : ''}
                    ${run.specialOtPay > 0 ? `<div class="payslip-row"><div>Special OT</div><div>LKR ${run.specialOtPay.toFixed(2)}</div></div>` : ''}
                    <div class="payslip-row total-row" style="font-size:14px"><div>Gross Salary</div><div>LKR ${run.grossSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
                </div>
                
                <div>
                    <div class="payslip-sec-title">Less: Deductions</div>
                    ${run.noPayDeductions > 0 ? `<div class="payslip-row"><div>No-Pay Deduction (${run.noPayDays} day${run.noPayDays !== 1 ? 's' : ''})</div><div>LKR ${run.noPayDeductions.toFixed(2)}</div></div>` : ''}
                    ${deductionsRowsHTML}
                    ${run.welfare > 0 ? `<div class="payslip-row"><div>Welfare</div><div>LKR ${run.welfare.toFixed(2)}</div></div>` : ''}
                    ${run.salaryAdvance > 0 ? `<div class="payslip-row"><div>Salary Advance</div><div>LKR ${run.salaryAdvance.toFixed(2)}</div></div>` : ''}
                    ${run.cashLosses > 0 ? `<div class="payslip-row"><div>Cash Losses</div><div>LKR ${run.cashLosses.toFixed(2)}</div></div>` : ''}
                    ${run.festivalAdvance > 0 ? `<div class="payslip-row"><div>Festival Advance</div><div>LKR ${run.festivalAdvance.toFixed(2)}</div></div>` : ''}
                    ${run.loanInstalment > 0 ? `<div class="payslip-row"><div>Loan Instalment</div><div>LKR ${run.loanInstalment.toFixed(2)}</div></div>` : ''}
                    ${run.pvtPhoneUsage > 0 ? `<div class="payslip-row"><div>Pvt Usage of Off. Phone</div><div>LKR ${run.pvtPhoneUsage.toFixed(2)}</div></div>` : ''}
                    ${run.deduRedDots > 0 ? `<div class="payslip-row"><div>Dedu. For Red Dots</div><div>LKR ${run.deduRedDots.toFixed(2)}</div></div>` : ''}
                    ${run.epfEmployeeCont > 0 ? `<div class="payslip-row"><div>E.P.F. Employee Cont (8%)</div><div>LKR ${run.epfEmployeeCont.toFixed(2)}</div></div>` : ''}
                    <div class="payslip-row total-row" style="font-size:14px"><div>Total Deductions</div><div>LKR ${run.totalDeductions.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
                </div>
            </div>
            
            <div class="payslip-net-box" style="margin-bottom: 16px;">
                <div>NET SALARY</div>
                <div>LKR ${run.roundedNetSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
            </div>
            
            <div style="border-top:1px solid #94a3b8; padding-top:10px; font-size:12px; display:grid; grid-template-columns: 1fr 1fr; gap:16px;">
                <div>
                    <div><strong>Employer Contributions:</strong></div>
                    <div>E.P.F. Employer Cont, 12%: LKR ${run.epfEmployerCont.toFixed(2)}</div>
                    <div>E.T.F. Employer Cont, 3%: LKR ${run.etfEmployerCont.toFixed(2)}</div>
                </div>
                <div style="text-align: right">
                    <div><strong>Total EPF (12% + 8%):</strong></div>
                    <div style="font-size:14px; font-weight:700">LKR ${run.totalEpf.toFixed(2)}</div>
                </div>
            </div>
        </div>
    `;

    modal.style.display = "flex";
    if (typeof lucide !== 'undefined') {
        lucide.createIcons();
    }
}

// Reports view methods
function initReportsView() {
    const today = new Date();
    const curMonth = today.toISOString().substring(0, 7);
    document.getElementById("report-month-select").value = curMonth;

    const deptSelect = document.getElementById("report-epf-dept");
    if (deptSelect) {
        deptSelect.innerHTML = '<option value="">All Departments (Default Info)</option>';
        store.getDepartments().forEach(d => {
            const opt = document.createElement("option");
            opt.value = d.name;
            opt.textContent = d.name;
            deptSelect.appendChild(opt);
        });
    }
}

function generateEpfCForm() {
    const selectedMonth = document.getElementById("report-month-select").value;
    const chequeNo = document.getElementById("report-epf-cheque") ? document.getElementById("report-epf-cheque").value : "";
    const bankName = document.getElementById("report-epf-bank") ? document.getElementById("report-epf-bank").value : "";
    const epfRefNo = document.getElementById("report-epf-ref") ? document.getElementById("report-epf-ref").value : "";
    const selectedDept = document.getElementById("report-epf-dept") ? document.getElementById("report-epf-dept").value : "";
    
    let runs = [];
    try {
        runs = store.getPayrollRuns(selectedMonth);
    } catch(e) { runs = []; }

    if (selectedDept) {
        runs = runs.filter(r => r.department === selectedDept);
    }
    
    // Filter out employees not eligible for EPF or with 0 contributions
    runs = runs.filter(r => r.epfEmployerCont > 0 || r.epfEmployeeCont > 0);

    if (runs.length === 0) {
        alert("Please process and recalculate payroll for this cycle in the 'Process Payroll' tab first!");
        return;
    }

    const totalContribution = runs.reduce((sum, r) => sum + r.epfEmployeeCont + r.epfEmployerCont, 0);
    const totalEmployerCont = runs.reduce((sum, r) => sum + r.epfEmployerCont, 0);
    const totalEmployeeCont = runs.reduce((sum, r) => sum + r.epfEmployeeCont, 0);
    const totalEpfEarnings = runs.reduce((sum, r) => sum + r.totalForEpf, 0);

    const [year, month] = selectedMonth.split("-");
    const monthNames = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    const monthName = monthNames[parseInt(month) - 1];

    let deptObj = null;
    if (selectedDept) {
        deptObj = store.getDepartments().find(d => d.name === selectedDept);
    }
    
    const compName = deptObj && deptObj.name ? deptObj.name.toUpperCase() : "SARATH DRIVING SCHOOL";
    const addressText = deptObj && deptObj.address ? deptObj.address : "NO. 17B,\nGROUND FLOOR,\nNEW SUPER MARKET,\nNITTAMBUWA.";
    let addressRows = '';
    addressText.split('\n').forEach(line => {
        if(line.trim() !== '') {
            addressRows += `<tr><td style="padding: 2px 6px; text-transform: uppercase;">${line}</td></tr>`;
        }
    });

    const compPhone = deptObj && deptObj.phone ? deptObj.phone : "2206645";
    const compFax = deptObj && deptObj.fax ? deptObj.fax : "2206651";
    const compEmail = deptObj && deptObj.email ? deptObj.email : "epfhelpdesk@cbsl.lk";
    const compWeb = deptObj && deptObj.web ? deptObj.web : "www.epf.lk";
    const compEpf = deptObj && deptObj.epfNo ? deptObj.epfNo : "";

    let rowsHTML = "";
    runs.forEach((r, idx) => {
        const rowCont = r.epfEmployeeCont + r.epfEmployerCont;
        rowsHTML += `
            <tr>
                <td style="border:1px solid #000; padding:8px; text-transform:uppercase;">${r.name}</td>
                <td style="border:1px solid #000; padding:8px; text-align:center;">${r.nic || 'N/A'}</td>
                <td style="border:1px solid #000; padding:8px; text-align:center;">${r.mobileNo || 'N/A'}</td>
                <td style="border:1px solid #000; padding:8px; text-align:center;">${r.memberNo || (idx + 1)}</td>
                <td style="border:1px solid #000; padding:8px; text-align:right;">${rowCont.toFixed(2)}</td>
                <td style="border:1px solid #000; padding:8px; text-align:right;">${r.epfEmployerCont.toFixed(2)}</td>
                <td style="border:1px solid #000; padding:8px; text-align:right;">${r.epfEmployeeCont.toFixed(2)}</td>
                <td style="border:1px solid #000; padding:8px; text-align:right;">${r.totalForEpf.toFixed(2)}</td>
            </tr>
        `;
    });

    const allEmployees = store.getEmployees() || [];
    const [ryear, rmonth] = selectedMonth.split("-").map(Number);
    const recentlyLeftEpf = allEmployees.filter(emp => {
        if (!emp.endDate || emp.epfEligible === false) return false;
        if (selectedDept && emp.department !== selectedDept) return false;
        const eym = emp.endDate.substring(0, 7).split("-").map(Number);
        const monthsDiff = (ryear - eym[0]) * 12 + (rmonth - eym[1]);
        return monthsDiff > 0 && monthsDiff <= 3;
    });

    recentlyLeftEpf.forEach((emp) => {
        rowsHTML += `
            <tr>
                <td style="border:1px solid #000; padding:8px; text-transform:uppercase;">${emp.firstName} ${emp.lastName}</td>
                <td style="border:1px solid #000; padding:8px; text-align:center;">${emp.nic || 'N/A'}</td>
                <td style="border:1px solid #000; padding:8px; text-align:center;">${emp.mobileNo || 'N/A'}</td>
                <td style="border:1px solid #000; padding:8px; text-align:center;">${emp.memberNo || '-'}</td>
                <td colspan="4" style="border:1px solid #000; padding:8px; text-align:center; font-style:italic;">Left employment / Retired on ${emp.endDate}</td>
            </tr>
        `;
    });

    const reportContent = document.getElementById("report-print-content");
    document.getElementById("report-modal-title").textContent = "EPF C-Form Return Preview";

    reportContent.innerHTML = `
        <div style="font-family: Arial, sans-serif; color:#000; padding: 10px; width: 100%; box-sizing: border-box;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 5px;">
                <!-- Left Side Box -->
                <div style="width: 48%; display: flex; flex-direction: column; border: 1px solid #000;">
                    <div style="padding: 2px 5px; font-size: 10px; font-weight: bold; text-align: center;">රා.සේ.පි.</div>
                    <div style="background-color: #000; color: #fff; text-align: center; padding: 4px; font-weight: bold; font-size: 12px;">
                        තැපැල් ගාස්තු ගෙවන ලදී M - 13
                    </div>
                    
                    <div style="padding: 10px; font-size: 11px; font-weight: bold; line-height: 1.4; min-height: 90px; flex-grow: 1; text-transform: uppercase;">
                        ${compName}<br>
                        ${addressText.replace(/\n/g, '<br>')}
                    </div>

                    <table style="width: 100%; border-collapse: collapse; font-size: 9px; border-top: 1px solid #000;">
                        <tr>
                            <td style="border: 1px solid #000; border-left: none; padding: 3px 4px; width: 30%;">දුරකථන අංකය / <span style="font-size: 7px;">தொலைபே</span>සි / Telephone</td>
                            <td style="border: 1px solid #000; padding: 3px 4px; width: 25%; font-weight: bold;">${compPhone}</td>
                            <td style="border: 1px solid #000; padding: 3px 4px; width: 15%;">ෆැක්ස් / <span style="font-size: 7px;">தொலைநகல்</span> / Fax</td>
                            <td style="border: 1px solid #000; border-right: none; padding: 3px 4px; width: 30%; font-weight: bold;">${compFax}</td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; border-left: none; padding: 3px 4px;">ඊ-මේල් / <span style="font-size: 7px;">மின்னஞ்சல்</span> / E-mail</td>
                            <td colspan="3" style="border: 1px solid #000; border-right: none; padding: 3px 4px; font-weight: bold;">${compEmail}</td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; border-left: none; border-bottom: none; padding: 3px 4px;">යොමු අංකය / <span style="font-size: 7px;">குறிப்பு இல</span>. / Reference No.</td>
                            <td colspan="3" style="border: 1px solid #000; border-right: none; border-bottom: none; padding: 3px 4px; font-weight: bold; text-align: center;">${epfRefNo}</td>
                        </tr>
                    </table>
                </div>

                <!-- Right Side Box -->
                <div style="width: 50%; display: flex; flex-direction: column;">
                    <table style="width: 100%; border-collapse: collapse; font-size: 10px; border: 1px solid #000; height: 100%;">
                        <tr>
                            <td colspan="2" style="border: 1px solid #000; padding: 4px; text-align: center;">
                                <div style="display: flex; align-items: center; justify-content: center; gap: 10px;">
                                    <div style="font-weight: 900; font-size: 32px; padding-right: 15px;">C</div>
                                    <div style="font-size: 10px; line-height: 1.2;">වාර්තාව<br><span style="font-size: 7px;">படிவம்</span><br>FORM</div>
                                </div>
                            </td>
                            <td colspan="2" style="border: 1px solid #000; padding: 4px; font-size: 9px; line-height: 1.2; vertical-align: middle;">
                                1958 අංක 15 දරණ සේ.අ.අ පනත<br>
                                <span style="font-size: 7px;">ஊ. சே. நி</span>. 1958 - 15<span style="font-size: 7px;">ம் பிரிவின்படி</span><br>
                                EPF Act No. 15 of 1958
                            </td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2; width: 35%;">
                                සේ.අ.අ. සේවායෝජක අංකය<br><span style="font-size: 7px;">ஊழியர் சே</span>ම<span style="font-size: 7px;">நிதி பதிவிலக்கம்</span><br>E.P.F. Registration No.
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; font-weight: bold; font-size: 13px; width: 25%; vertical-align: middle; text-align: center;">
                                ${compEpf}
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2; width: 25%;">
                                දායක මුදල්<br><span style="font-size: 7px;">பங்களிப்புக்கள்</span><br>Contributions
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold; font-size: 11px; width: 15%; vertical-align: middle;">
                                ${totalContribution.toFixed(2)}
                            </td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2;">
                                දායක දීමනා ගෙවනු ලබන වර්ෂය සහ මාසය<br><span style="font-size: 7px;">உதவுத் தொகை செலுத்தப்படும் மாதமும் வருடமும்</span><br>Month and Year of Contribution
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; font-weight: bold; font-size: 11px; vertical-align: middle; text-align: center; text-transform: uppercase;">
                                ${monthName}-${year}
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2;">
                                දඩ මුදල්<br><span style="font-size: 7px;">மேலதிக</span>ක් <span style="font-size: 7px;">கட்டணங்கள்</span><br>Surcharges
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold; font-size: 11px; vertical-align: middle;">
                                -
                            </td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2;">
                                චෙක්පත් අංකය<br><span style="font-size: 7px;">காசோலையின் இலக்கம்</span><br>Cheque No
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; font-weight: bold; font-size: 11px; vertical-align: middle; text-align: center;">
                                ${chequeNo}
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2;">
                                මුළු ගෙවීම<br><span style="font-size: 7px;">மொத்த பண</span>වනු<span style="font-size: 7px;">ப்பல்கள்</span><br>Total Remittance
                            </td>
                            <td style="border: 1px solid #000; padding: 4px; text-align: right; font-weight: bold; font-size: 11px; vertical-align: middle;">
                                ${totalContribution.toFixed(2)}
                            </td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; padding: 4px; line-height: 1.2; font-size: 9px; vertical-align: middle;">
                                බැංකුවේ නම හා ශාඛාවේ නම<br>ව<span style="font-size: 7px;">ங்கியினதும் கிளையினதும் பெயர்</span><br>Bank Name and Branch Name
                            </td>
                            <td colspan="3" style="border: 1px solid #000; padding: 4px; font-weight: bold; font-size: 11px; vertical-align: middle; text-align: center;">
                                ${bankName}
                            </td>
                        </tr>
                        <tr>
                            <td colspan="4" style="border: 1px solid #000; padding: 4px; line-height: 1.1; font-size: 9px; text-align: center;">
                                කරුණාකර චෙක්පතේ පිටුපස සේ.අ.අ. ලියාපදිංචි අංකය ලියන්න.<br>
                                <span style="font-size: 7px;">காசோலையின் மறு</span>ප<span style="font-size: 7px;">க்கத்தில் தொழில்தருநரின் ஊழியர் சே</span>ම නි<span style="font-size: 7px;">திய பதிவிலக்கத்தைக் குறிப்பிடவும்</span>.<br>
                                Please write Employer's EPF Registration Number on the reverse of the cheque.
                            </td>
                        </tr>
                    </table>
                </div>
            </div>

            <div style="font-size: 8px; text-align: left; margin-bottom: 8px;">
                භාරදිය නොහැකි වුවහොත් ආපසු එවන්න. අධිකාරී, සේවක අර්ථසාධක අරමුදල, ශ්‍රී ලංකා මහ බැංකුව, තැ.පෙ. 1299, කොළඹ.
            </div>

            <div style="text-align: center; font-size: 10px; font-weight: bold; margin-bottom: 10px; line-height: 1.3;">
                මෙම වාර්තාව නිසි ලෙස පුරවා දායක දීමනා සමග සේවක අර්ථසාධක අරමුදල් අධිකාරී වෙත එවිය යුතුය.<br>
                <span style="font-size: 7px;">இப்படிவத்தைப் முழுமையாக பூரணப்படுத்தி பங்களிப்புக்களுடன் ஊழியர் சேம நிதிய கண்காணிப்பாளருக்கு அனுப்பிவைக்கவும்</span>.<br>
                Duly completed form should be sent along with the contributions to the Superintendent / EPF
            </div>

            <!-- Bottom Employee Chart -->
            <table style="width: 100%; border-collapse: collapse; font-size: 9px; margin-bottom: 15px;">
                <thead>
                    <tr style="text-align: center;">
                        <th rowspan="2" style="border:1px solid #000; padding:4px; font-weight: normal; vertical-align: middle;">
                            ජාතික හැඳුනුම්පතට අනුව<br>මුලකුරු සමග සේවකයාගේ නම<br>
                            <span style="font-size:7px;"><span style="font-size: 7px;">தேசிய அடையாள அட்டைக்கு அமைய முதலெழுத்துக்களுடன் ஊழியரின் பெயர்</span></span><br>
                            <strong>Employee's Name with initials According to the National Identity Card</strong>
                        </th>
                        <th rowspan="2" style="border:1px solid #000; padding:4px; font-weight: normal; vertical-align: middle;">
                            ජාතික හැඳුනුම්පතෙහි අංකය<br>
                            <span style="font-size:7px;"><span style="font-size: 7px;">தேசிய அடையாள அட்டை இலக்கம்</span></span><br>
                            <strong>National Identity Card No.</strong>
                        </th>
                        <th rowspan="2" style="border:1px solid #000; padding:4px; font-weight: normal; vertical-align: middle;">
                            සාමාජිකයාගේ ජංගම දුරකථන අංකය<br>
                            <span style="font-size:7px;"><span style="font-size: 7px;">உறுப்பினர் கையடக்க தொலைபேசி இலக்கம்</span></span><br>
                            <strong>Member's Mobile Phone Number</strong>
                        </th>
                        <th rowspan="2" style="border:1px solid #000; padding:4px; font-weight: normal; vertical-align: middle;">
                            සාමාජික අංකය / <span style="font-size: 7px;">உறுப்பினர் இல</span>. / Member No.
                        </th>
                        <th colspan="3" style="border:1px solid #000; padding:4px; font-weight: normal; vertical-align: middle;">
                            දායක දීමනා (රු.) / <span style="font-size: 7px;">பங்களிப்புக்கள்</span> (<span style="font-size: 7px;">ரூபா</span>) / Contributions (Rs.)
                        </th>
                        <th rowspan="2" style="border:1px solid #000; padding:4px; font-weight: normal; vertical-align: middle;">
                            මුළු ඉපයීම (රු.) / <span style="font-size: 7px;">மொத்த வருமானம்</span> (<span style="font-size: 7px;">ரூபா</span>) / Total Earnings (Rs.)
                        </th>
                    </tr>
                    <tr style="text-align: center;">
                        <th style="border:1px solid #000; padding:3px; font-weight: normal;">එකතුව<br><span style="font-size:7px;"><span style="font-size: 7px;">மொத்தம்</span></span><br><strong>Total</strong></th>
                        <th style="border:1px solid #000; padding:3px; font-weight: normal;">සේවායෝජක<br><span style="font-size:7px;"><span style="font-size: 7px;">தொழில்தருநர்</span></span><br><strong>Employer</strong></th>
                        <th style="border:1px solid #000; padding:3px; font-weight: normal;">සේවකයා<br><span style="font-size:7px;"><span style="font-size: 7px;">ஊழியர்</span></span><br><strong>Employee</strong></th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHTML}
                    <tr>
                        <td colspan="3" style="border:1px solid #000; padding:5px; font-size: 8px; line-height: 1.2;">
                            ඉහත සඳහන් විස්තර නිවැරදි බව සහතික කරමි.<br>
                            <span style="font-size: 7px;">குறிப்பிடப்பட்ட விபரங்கள் சரியானவை என உறுதிப்படுத்துகின்றேன்</span>.<br>
                            I certify that the information given above is correct.
                        </td>
                        <td style="border:1px solid #000; padding:5px; font-weight: bold; text-align:right; font-size: 9px; vertical-align: middle;">
                            එකතුව/<span style="font-size: 7px;">மொத்தம்</span>/Total
                        </td>
                        <td style="border:1px solid #000; padding:5px; font-weight: bold; text-align:right; vertical-align: middle;">${totalContribution.toFixed(2)}</td>
                        <td style="border:1px solid #000; padding:5px; font-weight: bold; text-align:right; vertical-align: middle;">${totalEmployerCont.toFixed(2)}</td>
                        <td style="border:1px solid #000; padding:5px; font-weight: bold; text-align:right; vertical-align: middle;">${totalEmployeeCont.toFixed(2)}</td>
                        <td style="border:1px solid #000; padding:5px; font-weight: bold; text-align:right; vertical-align: middle;">${totalEpfEarnings.toFixed(2)}</td>
                    </tr>
                </tbody>
            </table>

            <div style="font-size: 11px; margin-top: 30px;">
                <div style="display:flex; justify-content:space-between; align-items:flex-end;">
                    <div style="text-align: center;">
                        ....................................................................<br>
                        සේවායෝජකගේ අත්සන / <span style="font-size: 7px;">தொழில்தருநரின் கையொப்பம்</span> / Signature of Employer
                    </div>
                    <div style="text-align: center;">
                        දුරකථන අංකය / <span style="font-size: 7px;">தொலைபேசி இல</span>. / Telephone No: ${deptObj && deptObj.phone ? deptObj.phone : "........................."}
                    </div>
                </div>
            </div>
        </div>
    `;

    document.getElementById("modal-report").style.display = "flex";
}

function generateEtfR4Form() {
    const selectedMonth = document.getElementById("report-month-select").value;
    
    const selectedDept = document.getElementById("report-epf-dept") ? document.getElementById("report-epf-dept").value : "";
    
    let runs = [];
    try {
        runs = store.getPayrollRuns(selectedMonth);
    } catch(e) { runs = []; }

    let deptObj = null;
    if (selectedDept) {
        deptObj = store.getDepartments().find(d => d.name === selectedDept);
        runs = runs.filter(r => r.department === selectedDept);
    }
    
    // Filter out employees not eligible for ETF or with 0 contributions
    runs = runs.filter(r => r.etfEmployerCont > 0);

    if (runs.length === 0) {
        alert("No payroll records found for this department in the selected cycle!");
        return;
    }
    
    const chequeNo = document.getElementById("report-etf-cheque") ? document.getElementById("report-etf-cheque").value : "";
    const bankName = document.getElementById("report-etf-bank") ? document.getElementById("report-etf-bank").value : "";
    const compName = deptObj && deptObj.name ? deptObj.name.toUpperCase() : "SARATH DRIVING SCHOOL";
    const addressText = deptObj && deptObj.address ? deptObj.address : "NO. 17B,\nGROUND FLOOR,\nNEW SUPER MARKET,\nNITTAMBUWA.";
    let addressRows = '';
    addressText.split('\n').forEach(line => {
        if(line.trim() !== '') {
            addressRows += `<tr><td style="padding: 6px; text-transform: uppercase;">${line}</td></tr>`;
        }
    });
    const compEpf = deptObj && deptObj.epfNo ? deptObj.epfNo : "";

    const totalContribution = runs.reduce((sum, r) => sum + r.etfEmployerCont, 0);
    const [year, month] = selectedMonth.split("-");
    const monthNames = ["JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE", "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"];
    const monthName = monthNames[parseInt(month) - 1];

    let rowsHTML = "";
    runs.forEach((r, idx) => {
        rowsHTML += `
            <tr>
                <td style="border:1px solid #000; padding:4px; text-transform:uppercase;">${r.name}</td>
                <td style="border:1px solid #000; padding:4px; text-align:center;">${r.nic || 'N/A'}</td>
                <td style="border:1px solid #000; padding:4px; text-align:center;">${r.memberNo || (idx + 1)}</td>
                <td style="border:1px solid #000; padding:4px; text-align:right;">${r.etfEmployerCont.toFixed(2)}</td>
            </tr>
        `;
    });

    const allEmployeesEtf = store.getEmployees() || [];
    const [ryearEtf, rmonthEtf] = selectedMonth.split("-").map(Number);
    const recentlyLeftEtf = allEmployeesEtf.filter(emp => {
        if (!emp.endDate || emp.epfEligible === false) return false;
        if (selectedDept && emp.department !== selectedDept) return false;
        const eym = emp.endDate.substring(0, 7).split("-").map(Number);
        const monthsDiff = (ryearEtf - eym[0]) * 12 + (rmonthEtf - eym[1]);
        return monthsDiff > 0 && monthsDiff <= 3;
    });

    recentlyLeftEtf.forEach((emp) => {
        rowsHTML += `
            <tr>
                <td style="border:1px solid #000; padding:4px; text-transform:uppercase;">${emp.firstName} ${emp.lastName}</td>
                <td style="border:1px solid #000; padding:4px; text-align:center;">${emp.nic || 'N/A'}</td>
                <td style="border:1px solid #000; padding:4px; text-align:center;">${emp.memberNo || '-'}</td>
                <td style="border:1px solid #000; padding:4px; text-align:center; font-style:italic;">Left employment / Retired on ${emp.endDate}</td>
            </tr>
        `;
    });

    const reportContent = document.getElementById("report-print-content");
    document.getElementById("report-modal-title").textContent = "ETF Form R4 Return Preview";

    reportContent.innerHTML = `
        <div style="font-family: Arial, sans-serif; color:#000; width: 100%; padding:10px; box-sizing: border-box;">
            
            <div style="display: flex; justify-content: space-between; margin-bottom: 10px;">
                <!-- Left Side -->
                <div style="width: 55%; padding-right: 15px;">
                    <div style="display: flex; margin-bottom: 10px;">
                        <div style="width: 30%; font-size: 10px; line-height: 1.2;">
                            1980 අංක 46 දරණ පනත<br>
                            1980 <span style="font-size: 7px;">ஆம் ஆண்டின்</span> 46 <span style="font-size: 7px;">ஆம் இலக்கச் சட்டம்</span><br>
                            Act No. 46 of 1980
                        </div>
                        <div style="width: 70%; text-align: center; font-size: 13px; font-weight: bold; line-height: 1.2;">
                            සේවා නියුක්තයන්ගේ භාර අරමුදල් මණ්ඩලය<br>
                            <span style="font-size: 7px;">ஊழியர் நம்பிக்கை பொறுப்பு நிதியச் சபை</span><br>
                            EMPLOYEES' TRUST FUND BOARD
                        </div>
                    </div>
                    <div style="font-size: 11px; margin-bottom: 2px;">
                        සේවායෝජකයාගේ නම සහ ලිපිනය / <span style="font-size: 7px;">தொழில்தருநரின் பெயரும் முகவரியும்</span> / Employer's Address
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 12px; border: 1px solid #000; margin-bottom: 8px;">
                        <tr><td style="padding: 6px; font-weight: bold; text-transform: uppercase;">${compName}</td></tr>
                        ${addressRows}
                        <tr><td style="padding: 2px;"></td></tr>
                    </table>
                    <div style="border: 1px solid #000; padding: 4px; font-size: 10px; line-height: 1.2;">
                        සේවකයින් 15 කට අඩු ආයතන සඳහා පමණක් භාවිතා කිරීමට.<br>
                        15 <span style="font-size: 7px;">ஊழியர்களுக்கு குறைவானவர்களைக் கொண்ட நிறுவனங்கள் மட்டும் பாவிப்பதற்கு</span>.<br>
                        FOR THE USE OF CONTRIBUTORS WITH LESS THAN 15 EMPLOYEES
                    </div>
                </div>

                <!-- Right Side -->
                <div style="width: 44%; display: flex; flex-direction: column;">
                    <div style="border: 1px solid #000; display: flex; justify-content: space-between; padding: 4px; margin-bottom: 10px;">
                        <div style="font-size: 11px; font-weight: bold; text-align: center; line-height: 1.2; width: 80%;">
                            ප්‍රේෂණ නිවේදන ආකෘති<br>
                            <span style="font-size: 7px;">பணவனுப்பல் அறிவுறுத்தல் படிவம்</span><br>
                            Advice of remittance form.
                        </div>
                        <div style="color: red; font-size: 11px; font-weight: bold; text-align: center; width: 20%; line-height: 1.2;">
                            ආ. 4<br>
                            <span style="font-size: 7px;">ஆர்</span>. 4<br>
                            R 4
                        </div>
                    </div>
                    <table style="width: 100%; border-collapse: collapse; font-size: 11px; border: 1px solid #000;">
                        <tr>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center; font-weight: bold; font-size: 14px;">${compEpf}</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center; font-weight: bold; font-size: 14px;">${monthName} ${year}</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center; font-weight: bold; font-size: 14px;">${runs.length}</td>
                        </tr>
                        <tr>
                            <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.1; text-align: center;">
                                සේ.අ.අ. / සේ.භා.අ. ලියාපදිංචි අංකය<br>
                                <span style="font-size: 7px;">ஊ.சே.நி</span>. / <span style="font-size: 7px;">ஊ.ந.பொ.நி. பதிவு இலக்கம்</span><br>
                                EPF/PPF Registration Number
                            </td>
                            <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.1; text-align: center;">
                                දායක වීමේ වර්ෂය හා මාසය<br>
                                <span style="font-size: 7px;">பங்களிப்புச் செலுத்தும் வருடமும் மாதமும்</span><br>
                                Year & Month of Contribution
                            </td>
                            <td style="border: 1px solid #000; padding: 2px 4px; font-size: 9px; line-height: 1.1; text-align: center;">
                                සේවක සංඛ්‍යාව<br>
                                <span style="font-size: 7px;">ஊழியர்களின் எண்ணிக்கை</span><br>
                                No. of Employees
                            </td>
                        </tr>
                        <tr>
                            <td colspan="2" style="border: 1px solid #000; padding: 6px;">දායක මුදල් ප්‍රමාණය / <span style="font-size: 7px;">பங்களிப்புத் தொகை</span> / Amount of Contribution</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: right;">${totalContribution.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        </tr>
                        <tr>
                            <td colspan="2" style="border: 1px solid #000; padding: 6px;">අධිභාරය / <span style="font-size: 7px;">மேலதிகக் கட்டணம்</span> / Surcharge</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center;">-</td>
                        </tr>
                        <tr>
                            <td colspan="2" style="border: 1px solid #000; padding: 6px;">එකතුව / <span style="font-size: 7px;">மொத்தப் பணவனுப்பல் தொகை</span> / Total Amount of Remittance</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: right;">${totalContribution.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                        </tr>
                        <tr>
                            <td colspan="2" style="border: 1px solid #000; padding: 6px;">චෙක්පත් අංකය / <span style="font-size: 7px;">காசோலை இலக்கம்</span> / Cheque No.</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center;">${chequeNo}</td>
                        </tr>
                        <tr>
                            <td colspan="2" style="border: 1px solid #000; padding: 6px;">බැංකුව සහ ශාඛාව / <span style="font-size: 7px;">வங்கியும் கிளையும்</span> / Bank & Branch</td>
                            <td style="border: 1px solid #000; padding: 6px; text-align: center;">${bankName}</td>
                        </tr>
                    </table>
                </div>
            </div>
            
            <div style="font-size: 11px; margin-bottom: 5px;">
                කරුණාකර පිටුපස ඇති උපදෙස් කියවන්න. / <span style="font-size: 7px;">தயவுசெய்து பின்பக்கத்தில் உள்ள அறிவுறுத்தல்களை வாசிக்கவும்</span>. / Please refer the instructions stated overleaf.
            </div>
            
            <table style="width: 100%; border-collapse: collapse; font-size: 11px; border: 1px solid #000;">
                <thead>
                    <tr>
                        <th style="border:1px solid #000; padding:4px; text-align:center;">
                            සාමාජිකයාගේ නම<br>
                            <span style="font-size: 7px;">ஊழியரின் பெயர்</span><br>
                            Employee's Name
                        </th>
                        <th style="border:1px solid #000; padding:4px; text-align:center;">
                            ජාතික හැඳුනුම්පත් අංකය<br>
                            <span style="font-size: 7px;">தேசிய அடையாள அட்டை இல</span>.<br>
                            National Identity Card No.
                        </th>
                        <th style="border:1px solid #000; padding:4px; text-align:center;">
                            සාමාජික අංකය<br>
                            <span style="font-size: 7px;">உறுப்பினர் இல</span>.<br>
                            Member No.
                        </th>
                        <th style="border:1px solid #000; padding:4px; text-align:center;">
                            දායක මුදල<br>
                            <span style="font-size: 7px;">பங்களிப்பு</span><br>
                            Contribution<br>
                            රු. Rs.  ශත. Cts.
                        </th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHTML}
                    <tr style="font-weight: 700; background-color:#f0f0f0;">
                        <td colspan="3" style="border:1px solid #000; padding:8px; text-align:right;">Total Remittance (3%)</td>
                        <td style="border:1px solid #000; padding:8px; text-align:right;">${totalContribution.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                    </tr>
                </tbody>
            </table>

            <div style="font-size: 11px; margin-top: 20px;">
                <p>I certify that the information given above is correct.</p>
                <div style="display:flex; justify-content:space-between; margin-top: 30px; align-items:flex-end;">
                    <div>
                        ....................................................................<br>Signature of Employer<br><br>
                        Tel: ${deptObj && deptObj.phone ? deptObj.phone : "........................."}&nbsp;&nbsp;&nbsp;
                        Email: ${deptObj && deptObj.email ? deptObj.email : "........................."}
                    </div>
                    <div style="padding-bottom: 20px;">Date: ${new Date().toLocaleDateString('en-GB')}</div>
                </div>
            </div>
        </div>
    `;

    document.getElementById("modal-report").style.display = "flex";
}
window.printReport = function() {
    const reportContent = document.getElementById("report-print-content").innerHTML;
    const title = document.getElementById("report-modal-title").textContent;
    const printWindow = window.open('', '_blank');
    printWindow.document.write('<html><head><title>' + title + '</title>');
    printWindow.document.write('<style>body{font-family:Arial,sans-serif; margin:0; padding:0;} table{border-collapse:collapse;} div { overflow: visible !important; } @page{size:A4 portrait; margin:1cm;} @media print { .hide-on-print { display: none !important; } }</style>');
    printWindow.document.write('</head><body>');
    printWindow.document.write(reportContent);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    setTimeout(() => {
        printWindow.print();
    }, 250);
};

// --- Cheque Printing Logic ---
function numberToWords(amount) {
    const a = ['', 'One ', 'Two ', 'Three ', 'Four ', 'Five ', 'Six ', 'Seven ', 'Eight ', 'Nine ', 'Ten ', 'Eleven ', 'Twelve ', 'Thirteen ', 'Fourteen ', 'Fifteen ', 'Sixteen ', 'Seventeen ', 'Eighteen ', 'Nineteen '];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function convertGroup(n) {
        let str = '';
        if (n > 99) {
            str += a[Math.floor(n / 100)] + 'Hundred ';
            n = n % 100;
            if (n > 0) str += 'and ';
        }
        if (n > 19) {
            str += b[Math.floor(n / 10)] + ' ';
            if (n % 10 > 0) str += a[n % 10];
        } else if (n > 0) {
            str += a[n];
        }
        return str.trim();
    }

    function toWords(num) {
        if (num === 0) return 'Zero';
        let str = '';
        if (num >= 10000000) {
            str += convertGroup(Math.floor(num / 10000000)) + ' Crore ';
            num %= 10000000;
        }
        if (num >= 100000) {
            str += convertGroup(Math.floor(num / 100000)) + ' Lakh ';
            num %= 100000;
        }
        if (num >= 1000) {
            str += convertGroup(Math.floor(num / 1000)) + ' Thousand ';
            num %= 1000;
        }
        if (num > 0) {
            str += convertGroup(num);
        }
        return str.trim();
    }

    let whole = Math.floor(amount);
    let cents = Math.round((amount - whole) * 100);
    
    let result = toWords(whole);
    if (cents > 0) {
        result += " and Cents " + toWords(cents);
    }
    return result + " Only";
}

let activeChequeData = null;

function openChequeModal(type) {
    const selectedMonth = document.getElementById("report-month-select").value;
    if (!selectedMonth) {
        alert("Please select a month first.");
        return;
    }
    let runs = store.getPayrollRuns(selectedMonth) || [];
    
    // Read the department based on which cheque we are printing
    const selectedDept = type === 'EPF' 
        ? document.getElementById("report-epf-dept").value 
        : document.getElementById("report-etf-dept").value;
        
    if (selectedDept && selectedDept !== "All") {
        runs = runs.filter(r => r.department === selectedDept);
    }
    
    // Filter out runs with zero contributions to match Form C/R4 logic
    runs = runs.filter(r => r.epfEmployerCont > 0 || r.epfEmployeeCont > 0);
    
    if (runs.length === 0) {
        alert(`No EPF/ETF contributions found for this month${selectedDept !== 'All' ? ' in ' + selectedDept : ''}.`);
        return;
    }

    let totalAmount = 0;
    if (type === 'EPF') {
        runs.forEach(r => {
            totalAmount += parseFloat(r.epfEmployeeCont || 0) + parseFloat(r.epfEmployerCont || 0);
        });
        document.getElementById("cheque-payee").value = "Superintendent of Employees' Provident Fund";
        document.getElementById("cheque-modal-title").textContent = "Print EPF Cheque";
    } else {
        runs.forEach(r => {
            totalAmount += parseFloat(r.etfEmployerCont || 0);
        });
        document.getElementById("cheque-payee").value = "Employees' Trust Fund Board";
        document.getElementById("cheque-modal-title").textContent = "Print ETF Cheque";
    }

    totalAmount = Math.round((totalAmount + Number.EPSILON) * 100) / 100;
    document.getElementById("cheque-amount").value = totalAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2});
    
    const today = new Date();
    // Seylan Bank usually has "2 0" pre-printed, so we only need YY.
    // We add spaces instead of slashes to align with standard cheque boxes better.
    const dd = String(today.getDate()).padStart(2, '0');
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const yy = String(today.getFullYear()).slice(-2);
    // Format: DD MM    YY
    const formattedDate = `${dd} ${mm}    ${yy}`;
    document.getElementById("cheque-date").value = formattedDate;
    
    activeChequeData = {
        amountNum: totalAmount.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}),
        amountWords: numberToWords(totalAmount)
    };
    
    document.getElementById("modal-cheque-print").style.display = "flex";
}

function executeChequePrint() {
    const dateStr = document.getElementById("cheque-date").value;
    const payeeStr = document.getElementById("cheque-payee").value;
    const adjX = parseFloat(document.getElementById("cheque-adjust-x").value) || 0;
    const adjY = parseFloat(document.getElementById("cheque-adjust-y").value) || 0;
    
    // Convert Date to string array for Seylan Bank standard D D M M Y Y Y Y boxes if needed,
    // but typically it's printed as a string near the top right.
    const dateWithSpaces = dateStr.replace(/\//g, ' '); // simple spacing
    
    const printCross = document.getElementById("adv-print-cross").checked;
    
    const dx = parseFloat(document.getElementById("adv-date-x").value) || 0;
    const dy = parseFloat(document.getElementById("adv-date-y").value) || 0;
    const px = parseFloat(document.getElementById("adv-payee-x").value) || 0;
    const py = parseFloat(document.getElementById("adv-payee-y").value) || 0;
    const wx = parseFloat(document.getElementById("adv-words-x").value) || 0;
    const wy = parseFloat(document.getElementById("adv-words-y").value) || 0;
    const ax = parseFloat(document.getElementById("adv-amount-x").value) || 0;
    const ay = parseFloat(document.getElementById("adv-amount-y").value) || 0;
    const cx = parseFloat(document.getElementById("adv-cross-x").value) || 0;
    const cy = parseFloat(document.getElementById("adv-cross-y").value) || 0;
    
    // Seylan Bank Standard coordinates (approximate, user can adjust)
    // Size: Width ~203mm, Height ~89mm
    const css = `
        @page { size: 203mm 89mm; margin: 0; }
        body { margin: 0; padding: 0; font-family: 'Arial', sans-serif; font-size: 13px; font-weight: bold; position: relative; }
        .cheque-date { position: absolute; top: ${12 + adjY + dy}mm; left: ${155 + adjX + dx}mm; letter-spacing: 2px; }
        .cheque-payee { position: absolute; top: ${35 + adjY + py}mm; left: ${25 + adjX + px}mm; width: 140mm; }
        .cheque-words { position: absolute; top: ${43 + adjY + wy}mm; left: ${35 + adjX + wx}mm; width: 120mm; line-height: 1.8; }
        .cheque-number { position: absolute; top: ${46 + adjY + ay}mm; left: ${155 + adjX + ax}mm; font-size: 15px; }
        .cheque-crossing { position: absolute; top: ${10 + adjY + cy}mm; left: ${15 + adjX + cx}mm; font-size: 11px; text-decoration: underline; font-style: italic; display: ${printCross ? 'block' : 'none'}; }
    `;

    const html = `
        <html>
            <head>
                <title>Cheque Print</title>
                <style>${css}</style>
            </head>
            <body>
                <div class="cheque-crossing">A/C PAYEE ONLY</div>
                <div class="cheque-date">${dateWithSpaces}</div>
                <div class="cheque-payee">** ${payeeStr} **</div>
                <div class="cheque-words">** ${activeChequeData.amountWords} **</div>
                <div class="cheque-number">** ${activeChequeData.amountNum} **</div>
            </body>
        </html>
    `;

    const printWindow = window.open('', '_blank');
    printWindow.document.write(html);
    printWindow.document.close();
    setTimeout(() => {
        printWindow.print();
    }, 300);
}

// Settings Customizers Manager
function loadSettingsForm() {
    const settings = store.getSettings();
    document.getElementById("set-std-work-days").value = settings.stdWorkDays;
    document.getElementById("set-paid-leaves").value = settings.paidLeaves !== undefined ? settings.paidLeaves : 4;
    document.getElementById("set-std-work-hours").value = settings.stdWorkHours;
    document.getElementById("set-normal-ot-rate").value = settings.normalOtRate;
    document.getElementById("set-special-ot-rate").value = settings.specialOtRate;
    document.getElementById("set-tax-rate").value = settings.taxRate;

    renderSettingsCustomLists();
}

function renderSettingsCustomLists() {
    const deptList = document.getElementById("settings-dept-list");
    deptList.innerHTML = "";
    store.getDepartments().forEach((dept, index) => {
        const div = document.createElement("div");
        div.className = "settings-list-item";
        div.innerHTML = `
            <div>
                <strong>${dept.name}</strong>
                <div style="font-size:11px; color:#666;">${dept.epfNo ? 'EPF: '+dept.epfNo : 'No EPF No'}</div>
            </div>
            <div>
                <button onclick="handleEditDepartment(${index})" style="margin-right:8px; color:var(--primary-color); border:none; background:none; cursor:pointer;"><i data-lucide="edit" style="width:14px;height:14px;"></i></button>
                <button onclick="handleRemoveDepartment(${index})" style="color:var(--danger-color); border:none; background:none; cursor:pointer;">&times;</button>
            </div>
        `;
        deptList.appendChild(div);
    });

    if (window.lucide) window.lucide.createIcons();
    const desigList = document.getElementById("settings-desig-list");
    desigList.innerHTML = "";
    store.getDesignations().forEach((desig, index) => {
        const div = document.createElement("div");
        div.className = "settings-list-item";
        div.innerHTML = `
            <span>${desig}</span>
            <div>
                <button onclick="handleEditDesignation(${index})" style="margin-right:8px; color:var(--primary-color); border:none; background:none; cursor:pointer;"><i data-lucide="edit" style="width:14px;height:14px;"></i></button>
                <button onclick="handleRemoveDesignation(${index})" style="color:var(--danger-color); border:none; background:none; cursor:pointer;">&times; Remove</button>
            </div>
        `;
        desigList.appendChild(div);
    });

    const allowList = document.getElementById("settings-allowance-list");
    allowList.innerHTML = "";
    store.getAllowancesConfig().forEach((allow, index) => {
        const div = document.createElement("div");
        div.className = "settings-list-item";
        div.innerHTML = `
            <span>${allow.name} (Default: LKR ${allow.value})</span>
            <div>
                <button onclick="handleEditAllowanceType(${index})" style="margin-right:8px; color:var(--primary-color); border:none; background:none; cursor:pointer;"><i data-lucide="edit" style="width:14px;height:14px;"></i></button>
                <button onclick="handleRemoveAllowanceType(${index})" style="color:var(--danger-color); border:none; background:none; cursor:pointer;">&times; Remove</button>
            </div>
        `;
        allowList.appendChild(div);
    });
}

function openDeptModal() {
    document.getElementById("modal-department").style.display = "flex";
}

function closeDeptModal() {
    document.getElementById("modal-department").style.display = "none";
    document.getElementById("form-department").reset();
    document.getElementById("dept-edit-index").value = "";
}

document.getElementById("btn-close-dept-modal").addEventListener("click", closeDeptModal);
document.getElementById("btn-cancel-dept").addEventListener("click", closeDeptModal);

function handleAddDepartment(e) {
    e.preventDefault();
    const input = document.getElementById("new-dept-name");
    const name = input.value.trim();
    document.getElementById("dept-name").value = name;
    openDeptModal();
}

window.handleEditDepartment = function(index) {
    const depts = store.getDepartments();
    const dept = depts[index];
    if (!dept) return;
    
    document.getElementById("dept-edit-index").value = index;
    document.getElementById("dept-name").value = dept.name || "";
    document.getElementById("dept-address").value = dept.address || "";
    document.getElementById("dept-epf").value = dept.epfNo || "";
    document.getElementById("dept-phone").value = dept.phone || "";
    document.getElementById("dept-fax").value = dept.fax || "";
    document.getElementById("dept-email").value = dept.email || "";
    document.getElementById("dept-web").value = dept.web || "";
    
    openDeptModal();
};

document.getElementById("form-department").addEventListener("submit", function(e) {
    e.preventDefault();
    
    const index = document.getElementById("dept-edit-index").value;
    const deptObj = {
        name: document.getElementById("dept-name").value.trim(),
        address: document.getElementById("dept-address").value.trim(),
        epfNo: document.getElementById("dept-epf").value.trim(),
        phone: document.getElementById("dept-phone").value.trim(),
        fax: document.getElementById("dept-fax").value.trim(),
        email: document.getElementById("dept-email").value.trim(),
        web: document.getElementById("dept-web").value.trim()
    };
    
    const depts = store.getDepartments();
    
    if (index !== "") {
        depts[parseInt(index)] = deptObj;
    } else {
        depts.push(deptObj);
    }
    
    store.saveDepartments(depts);
    renderSettingsCustomLists();
    closeDeptModal();
    document.getElementById("new-dept-name").value = "";
});

window.handleRemoveDepartment = function(index) {
    const depts = store.getDepartments();
    if (confirm("Are you sure you want to remove this department?")) {
        depts.splice(index, 1);
        store.saveDepartments(depts);
        renderSettingsCustomLists();
    }
};

function handleAddDesignation(e) {
    e.preventDefault();
    const input = document.getElementById("new-desig-name");
    const name = input.value.trim();
    if (!name) return;

    const desigs = store.getDesignations();
    if (!desigs.includes(name)) {
        desigs.push(name);
        store.saveDesignations(desigs);
        input.value = "";
        renderSettingsCustomLists();
    }
}

window.handleEditDesignation = function(index) {
    const desigs = store.getDesignations();
    const oldName = desigs[index];
    const newName = prompt("Edit Designation Name:", oldName);
    if (newName && newName.trim() !== "" && newName !== oldName) {
        desigs[index] = newName.trim();
        store.saveDesignations(desigs);
        renderSettingsCustomLists();
    }
};

window.handleRemoveDesignation = function(index) {
    const desigs = store.getDesignations();
    desigs.splice(index, 1);
    store.saveDesignations(desigs);
    renderSettingsCustomLists();
};

function handleAddAllowanceType(e) {
    e.preventDefault();
    const inputName = document.getElementById("new-allowance-name");
    const inputValue = document.getElementById("new-allowance-value");
    
    const name = inputName.value.trim();
    const val = parseFloat(inputValue.value) || 0;
    
    if (!name) return;
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, "_");

    const allowances = store.getAllowancesConfig();
    if (!allowances.some(a => a.id === id)) {
        allowances.push({ id, name, value: val });
        store.saveAllowancesConfig(allowances);
        inputName.value = "";
        inputValue.value = "0";
        renderSettingsCustomLists();
    }
}

window.handleEditAllowanceType = function(index) {
    const allows = store.getAllowancesConfig();
    const allow = allows[index];
    const newName = prompt("Edit Allowance Name:", allow.name);
    if (newName === null) return;
    
    const newVal = prompt(`Edit Default Value for ${newName}:`, allow.value);
    if (newVal === null) return;
    
    const parsedVal = parseFloat(newVal);
    if (newName.trim() !== "" && !isNaN(parsedVal)) {
        allows[index] = { id: allow.id, name: newName.trim(), value: parsedVal };
        store.saveAllowancesConfig(allows);
        renderSettingsCustomLists();
    }
};

window.handleRemoveAllowanceType = function(index) {
    const allowances = store.getAllowancesConfig();
    allowances.splice(index, 1);
    store.saveAllowancesConfig(allowances);
    renderSettingsCustomLists();
};

function handleSaveSettings(e) {
    e.preventDefault();
    const updatedSettings = {
        stdWorkDays: parseInt(document.getElementById("set-std-work-days").value) || 26,
        paidLeaves: parseInt(document.getElementById("set-paid-leaves").value) || 0,
        stdWorkHours: parseInt(document.getElementById("set-std-work-hours").value) || 8,
        normalOtRate: parseFloat(document.getElementById("set-normal-ot-rate").value) || 1.5,
        specialOtRate: parseFloat(document.getElementById("set-special-ot-rate").value) || 2.0,
        taxRate: parseInt(document.getElementById("set-tax-rate").value) || 0
    };
    store.saveSettings(updatedSettings);
    alert("Settings saved successfully!");
    updateDashboardStats();
}

async function handleResetEmployeeIDs() {
    if (!confirm("WARNING: This will renumber ALL existing employees sequentially from EMP101 onwards, and update all attendance, leaves, and adjustment records. This action cannot be undone. Are you sure you want to proceed?")) {
        return;
    }
    
    try {
        let employees = store.getEmployees();
        let attendance = store.getAttendance();
        let leaves = store.getLeaves();
        let adjustments = store.getAdjustments();
        
        employees.sort((a, b) => {
            if (a.joinDate && b.joinDate) return a.joinDate.localeCompare(b.joinDate);
            return 0;
        });
        
        const idMap = {};
        
        let startNum = 101;
        employees.forEach(emp => {
            const oldId = emp.id;
            const newId = "EMP" + startNum;
            startNum++;
            
            if (oldId !== newId) {
                idMap[oldId] = newId;
                emp.id = newId;
            }
        });
        
        if (Object.keys(idMap).length === 0) {
            alert("Employee IDs are already sequential. No changes needed.");
            return;
        }
        
        attendance.forEach(a => {
            if (idMap[a.employeeId]) a.employeeId = idMap[a.employeeId];
        });
        
        leaves.forEach(l => {
            if (idMap[l.employeeId]) l.employeeId = idMap[l.employeeId];
        });
        
        for (let month in adjustments) {
            const monthAdj = adjustments[month];
            const newMonthAdj = {};
            for (let empId in monthAdj) {
                const newId = idMap[empId] || empId;
                newMonthAdj[newId] = monthAdj[empId];
            }
            adjustments[month] = newMonthAdj;
        }
        
        const runsToUpdate = {};
        for (let month in store.runs) {
            let monthRuns = store.runs[month];
            let changed = false;
            monthRuns.forEach(run => {
                if (idMap[run.id]) {
                    run.id = idMap[run.id];
                    changed = true;
                }
            });
            if (changed) {
                runsToUpdate[month] = monthRuns;
            }
        }
        
        store.employees = employees;
        store.attendance = attendance;
        store.leaves = leaves;
        store.adjustments = adjustments;
        store.syncToFirebase();
        
        if (window.db && store.setDoc) {
            for (let month in runsToUpdate) {
                const docRef = store.doc(window.db, "payroll_runs", month);
                await store.setDoc(docRef, { runs: runsToUpdate[month] });
            }
        }
        
        alert("Employee IDs have been successfully reset and synced! The page will now reload.");
        window.location.reload();
        
    } catch (e) {
        console.error("Error resetting IDs:", e);
        alert("An error occurred during reset. Check console for details.");
    }
}
function handleClearEmployeeData() {
    const empId = document.getElementById("clear-emp-id-input").value.trim().toUpperCase();
    if (!empId) {
        alert("Please enter an Employee ID.");
        return;
    }
    
    if (!confirm(`Are you sure you want to permanently delete ALL attendance and leaves records for ${empId}? This action cannot be undone.`)) {
        return;
    }
    
    try {
        let attendance = store.getAttendance() || [];
        const originalAttLength = attendance.length;
        attendance = attendance.filter(a => a.employeeId !== empId);
        
        let leaves = store.getLeaves() || [];
        const originalLeavesLength = leaves.length;
        leaves = leaves.filter(l => l.employeeId !== empId);
        
        let changed = false;
        
        if (attendance.length !== originalAttLength) {
            store.saveAttendance(attendance);
            changed = true;
        }
        
        if (leaves.length !== originalLeavesLength) {
            store.saveLeaves(leaves);
            changed = true;
        }
        
        if (changed) {
            alert(`Records for ${empId} have been successfully cleared!`);
            document.getElementById("clear-emp-id-input").value = "";
            renderAttendance();
            updateDashboardStats();
        } else {
            alert(`No attendance or leaves found for ${empId}.`);
        }
    } catch (e) {
        console.error("Error clearing data:", e);
        alert("An error occurred. Check console for details.");
    }
}

// Department Wise Paysheet Modal
function openDepartmentPaysheetModal() {
    const departments = store.getDepartments();
    let modal = document.getElementById("modal-dept-paysheet");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "modal-dept-paysheet";
        modal.className = "modal-overlay";
        document.body.appendChild(modal);
    }
    const deptOptions = departments.map(d => `<option value="${d.name}">${d.name}</option>`).join("");
    modal.innerHTML = `
        <div class="modal-container" style="max-width:800px;">
            <div class="modal-header">
                <h3>Department Paysheet</h3>
                <button class="modal-close" onclick="document.getElementById('modal-dept-paysheet').style.display='none'">&times;</button>
            </div>
            <div class="modal-body" style="max-height:70vh; overflow:auto;">
                <form id="form-dept-paysheet">
                    <div class="form-row">
                        <div class="form-group col-6">
                            <label for="dept-select-paysheet">Select Department</label>
                            <select id="dept-select-paysheet" class="form-input">${deptOptions}</select>
                        </div>
                        <div class="form-group col-6">
                            <label for="paysheet-month">Month</label>
                            <input type="month" id="paysheet-month" class="form-input" value="${new Date().toISOString().substring(0,7)}"/>
                        </div>
                    </div>
                    <div class="modal-footer">
                        <button type="button" class="btn btn-secondary" onclick="document.getElementById('modal-dept-paysheet').style.display='none'">Cancel</button>
                        <button type="submit" class="btn btn-primary">Generate</button>
                        <button type="button" class="btn btn-success" id="print-dept-paysheet" style="display:none;">Print</button>
                    </div>
                </form>
                <div id="dept-paysheet-content" style="margin-top:20px;"></div>
            </div>
        </div>
    `;
    modal.style.display = "flex";

    document.getElementById("form-dept-paysheet").addEventListener("submit", e => {
        e.preventDefault();
        const dept = document.getElementById("dept-select-paysheet").value;
        const month = document.getElementById("paysheet-month").value;
        renderDepartmentPaysheet(month, dept);
    });
}

function renderDepartmentPaysheet(selectedMonth, department) {
    let runs = [];
    try {
        runs = store.getPayrollRuns(selectedMonth);
    } catch(e) { runs = []; }

    if (runs.length === 0) {
        alert("No payroll data for the selected month.");
        return;
    }

    const employees = store.getEmployees();
    const deptEmployees = employees.filter(emp => emp.department === department);
    const deptEmpIds = new Set(deptEmployees.map(e => e.id));
    const filteredRuns = runs.filter(r => deptEmpIds.has(r.employeeId));

    if (filteredRuns.length === 0) {
        alert("No employees found in the selected department for this month.");
        return;
    }

    const [year, month] = selectedMonth.split("-");
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const monthName = monthNames[parseInt(month) - 1];

    // Compute allowance totals and grand totals across all runs to determine which columns have data
    let gtBasic = 0, gtArrears = 0, gtMeal = 0, gtNormOT = 0, gtSpecOT = 0, gtGross = 0;
    let gtNoPay = 0, gtWelfare = 0, gtAdvance = 0, gtLosses = 0, gtFestival = 0, gtLoan = 0, gtPhone = 0, gtRedDots = 0, gtEpf8 = 0, gtTotalDed = 0;
    let gtNet = 0;
    const allowanceTotals = {};

    filteredRuns.forEach(run => {
        gtBasic += run.basicSalary;
        gtArrears += run.salaryArrears;
        gtMeal += (run.noPayDeductions > 0 ? 0 : run.earlyNightMeal);
        gtNormOT += run.normalOtPay;
        gtSpecOT += run.specialOtPay;
        gtGross += run.grossSalary;
        gtNoPay += run.noPayDeductions;
        gtWelfare += run.welfare;
        gtAdvance += run.salaryAdvance;
        gtLosses += run.cashLosses;
        gtFestival += run.festivalAdvance;
        gtLoan += run.loanInstalment;
        gtPhone += run.pvtPhoneUsage;
        gtRedDots += run.deduRedDots;
        gtEpf8 += run.epfEmployeeCont;
        gtTotalDed += run.totalDeductions;
        gtNet += run.roundedNetSalary;

        if (run.allowancesData) {
            run.allowancesData.forEach(a => {
                if (!allowanceTotals[a.name]) {
                    allowanceTotals[a.name] = { value: 0, deduction: 0 };
                }
                allowanceTotals[a.name].value += a.value;
                allowanceTotals[a.name].deduction += a.deduction;
            });
        }
    });

    // Allowance names to display (non-zero earnings or penalties)
    const displayedAllowanceNames = Object.entries(allowanceTotals)
        .filter(([_, sums]) => sums.value !== 0 || sums.deduction !== 0)
        .map(([name, _]) => name);

    // Common vertical header style for sub-column headings
    const vStyle = 'border:1px solid #000; padding:4px 2px; font-size:10px; text-align:center; white-space:nowrap; writing-mode:vertical-rl; transform:rotate(180deg);';
    const hStyle = 'border:1px solid #000; padding:4px 2px; font-size:10px; text-align:center; white-space:nowrap;';

    // Build earnings header columns
    let earningsHeaderHTML = `<th style="${vStyle}">Basic Salary</th>`;
    if (gtArrears > 0) earningsHeaderHTML += `<th style="${vStyle}">Salary Arrears</th>`;
    displayedAllowanceNames.forEach(name => {
        earningsHeaderHTML += `<th style="${vStyle}">${name}</th>`;
    });
    if (gtMeal > 0) earningsHeaderHTML += `<th style="${vStyle}">Early/Night/Meal</th>`;
    if (gtNormOT > 0) earningsHeaderHTML += `<th style="${vStyle}">Normal OT</th>`;
    if (gtSpecOT > 0) earningsHeaderHTML += `<th style="${vStyle}">Special OT</th>`;
    earningsHeaderHTML += `<th style="${vStyle} background:#d4edda; font-weight:700;">Gross Salary</th>`;

    // Build deductions header columns
    let deductionsHeaderHTML = ``;
    if (gtNoPay > 0) deductionsHeaderHTML += `<th style="${vStyle}">No-Pay Ded.</th>`;
    if (gtWelfare > 0) deductionsHeaderHTML += `<th style="${vStyle}">Welfare</th>`;
    if (gtAdvance > 0) deductionsHeaderHTML += `<th style="${vStyle}">Salary Advance</th>`;
    if (gtLosses > 0) deductionsHeaderHTML += `<th style="${vStyle}">Cash Losses</th>`;
    if (gtFestival > 0) deductionsHeaderHTML += `<th style="${vStyle}">Festival Adv.</th>`;
    if (gtLoan > 0) deductionsHeaderHTML += `<th style="${vStyle}">Loan Inst.</th>`;
    if (gtPhone > 0) deductionsHeaderHTML += `<th style="${vStyle}">Pvt Phone</th>`;
    if (gtRedDots > 0) deductionsHeaderHTML += `<th style="${vStyle}">Red Dots</th>`;
    displayedAllowanceNames.forEach(name => {
        if (allowanceTotals[name].deduction > 0) {
            deductionsHeaderHTML += `<th style="${vStyle}">${name} Pen.</th>`;
        }
    });
    if (gtEpf8 > 0) deductionsHeaderHTML += `<th style="${vStyle}">EPF 8%</th>`;
    deductionsHeaderHTML += `<th style="${vStyle} background:#f8d7da; font-weight:700;">Total Ded.</th>`;

    let earningsCols = 2 + displayedAllowanceNames.length + (gtArrears > 0 ? 1 : 0) + (gtMeal > 0 ? 1 : 0) + (gtNormOT > 0 ? 1 : 0) + (gtSpecOT > 0 ? 1 : 0);
    // basic + gross = 2
    let allowPenCount = displayedAllowanceNames.filter(name => allowanceTotals[name].deduction > 0).length;
    let deductionsCols = 1 + allowPenCount + (gtNoPay > 0 ? 1 : 0) + (gtWelfare > 0 ? 1 : 0) + (gtAdvance > 0 ? 1 : 0) + (gtLosses > 0 ? 1 : 0) + (gtFestival > 0 ? 1 : 0) + (gtLoan > 0 ? 1 : 0) + (gtPhone > 0 ? 1 : 0) + (gtRedDots > 0 ? 1 : 0) + (gtEpf8 > 0 ? 1 : 0);
    // totalDed = 1

    // Build data rows
    let rows = "";
    filteredRuns.forEach(run => {
        const emp = employees.find(e => e.id === run.employeeId) || {};
        const fn = (v) => v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});

        let earningsCellsHTML = `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.basicSalary)}</td>`;
        if (gtArrears > 0) earningsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.salaryArrears)}</td>`;
        displayedAllowanceNames.forEach(name => {
            const a = run.allowancesData ? run.allowancesData.find(x => x.name === name) : null;
            earningsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(a ? a.value : 0)}</td>`;
        });
        if (gtMeal > 0) earningsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.noPayDeductions > 0 ? 0 : run.earlyNightMeal)}</td>`;
        if (gtNormOT > 0) earningsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.normalOtPay)}</td>`;
        if (gtSpecOT > 0) earningsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.specialOtPay)}</td>`;
        earningsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right; background:#d4edda; font-weight:700;">${fn(run.grossSalary)}</td>`;

        let deductionsCellsHTML = ``;
        if (gtNoPay > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.noPayDeductions)}</td>`;
        if (gtWelfare > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.welfare)}</td>`;
        if (gtAdvance > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.salaryAdvance)}</td>`;
        if (gtLosses > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.cashLosses)}</td>`;
        if (gtFestival > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.festivalAdvance)}</td>`;
        if (gtLoan > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.loanInstalment)}</td>`;
        if (gtPhone > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.pvtPhoneUsage)}</td>`;
        if (gtRedDots > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.deduRedDots)}</td>`;
        displayedAllowanceNames.forEach(name => {
            if (allowanceTotals[name].deduction > 0) {
                const a = run.allowancesData ? run.allowancesData.find(x => x.name === name) : null;
                deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(a ? a.deduction : 0)}</td>`;
            }
        });
        if (gtEpf8 > 0) deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right;">${fn(run.epfEmployeeCont)}</td>`;
        deductionsCellsHTML += `<td style="border:1px solid #000; padding:6px; text-align:right; background:#f8d7da; font-weight:700;">${fn(run.totalDeductions)}</td>`;

        rows += `
            <tr style="min-height:0.5in">
                <td style="border:1px solid #000; padding:6px; font-weight:600; width:112px; white-space:normal; overflow-wrap:break-word;" rowspan="1">${emp.firstName || ''} ${emp.lastName || ''}</td>
                ${earningsCellsHTML}
                ${deductionsCellsHTML}
                <td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700; background:#fff3cd;">${run.roundedNetSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</td>
                <td style="border:1px solid #000; padding:6px; min-width:60px;"></td>
            </tr>`;
    });

    // Grand total row
    const fn = (v) => v.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
    let totalEarningsCells = `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtBasic)}</td>`;
    if (gtArrears > 0) totalEarningsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtArrears)}</td>`;
    displayedAllowanceNames.forEach(name => {
        totalEarningsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(allowanceTotals[name].value)}</td>`;
    });
    if (gtMeal > 0) totalEarningsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtMeal)}</td>`;
    if (gtNormOT > 0) totalEarningsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtNormOT)}</td>`;
    if (gtSpecOT > 0) totalEarningsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtSpecOT)}</td>`;
    totalEarningsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700; background:#d4edda;">${fn(gtGross)}</td>`;

    let totalDeductionsCells = ``;
    if (gtNoPay > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtNoPay)}</td>`;
    if (gtWelfare > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtWelfare)}</td>`;
    if (gtAdvance > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtAdvance)}</td>`;
    if (gtLosses > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtLosses)}</td>`;
    if (gtFestival > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtFestival)}</td>`;
    if (gtLoan > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtLoan)}</td>`;
    if (gtPhone > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtPhone)}</td>`;
    if (gtRedDots > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtRedDots)}</td>`;
    displayedAllowanceNames.forEach(name => {
        if (allowanceTotals[name].deduction > 0) {
            totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(allowanceTotals[name].deduction)}</td>`;
        }
    });
    if (gtEpf8 > 0) totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700;">${fn(gtEpf8)}</td>`;
    totalDeductionsCells += `<td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700; background:#f8d7da;">${fn(gtTotalDed)}</td>`;

    const totalCols = 1 + earningsCols + deductionsCols + 1 + 1; // name + earnings + deductions + net + signature

    const contentDiv = document.getElementById("dept-paysheet-content");
    contentDiv.innerHTML = `
        <div style="text-align:center; margin-bottom:16px;">
            <h2 style="margin:0; font-size:22px; font-weight:800; text-transform:uppercase;">${department}</h2>
            <div style="font-size:15px; margin-top:4px; font-weight:600; color:#555;">Pay Sheet for ${monthName} ${year}</div>
        </div>
        <div style="overflow-x:auto;">
            <table style="width:100%; border-collapse:collapse; font-size:11px; table-layout:auto;">
                <thead>
                    <tr style="background:#e2e8f0;">
                        <th style="border:1px solid #000; padding:6px; white-space:nowrap; font-size:10px; width:112px;" rowspan="2">Employee Name</th>
                        <th style="border:1px solid #000; padding:6px; text-align:center; background:#d4edda; font-weight:700;" colspan="${earningsCols}">EARNINGS</th>
                        <th style="border:1px solid #000; padding:6px; text-align:center; background:#f8d7da; font-weight:700;" colspan="${deductionsCols}">DEDUCTIONS</th>
                        <th style="border:1px solid #000; padding:6px; text-align:center; background:#fff3cd; font-weight:700;" rowspan="2">Net Salary</th>
                        <th style="border:1px solid #000; padding:6px; text-align:center;" rowspan="2">Signature</th>
                    </tr>
                    <tr style="background:#f1f5f9;">
                        ${earningsHeaderHTML}
                        ${deductionsHeaderHTML}
                    </tr>
                </thead>
                <tbody>
                    ${rows}
                    <tr style="background:#e2e8f0; font-weight:700;">
                        <td style="border:1px solid #000; padding:6px; text-align:right;">TOTAL</td>
                        ${totalEarningsCells}
                        ${totalDeductionsCells}
                        <td style="border:1px solid #000; padding:6px; text-align:right; font-weight:700; background:#fff3cd;">${gtNet.toLocaleString()}</td>
                        <td style="border:1px solid #000; padding:6px;"></td>
                    </tr>
                </tbody>
            </table>
        <div class="hide-on-print" style="text-align:center; font-size:10px; margin-top:8px;">Powered by <a href="https://brandspire-lk.vercel.app/" target="_blank" style="color:#0066cc; text-decoration:none;">Brandspire</a></div></div>
    `;

    const printBtn = document.getElementById("print-dept-paysheet");
    printBtn.style.display = "inline-block";
    printBtn.onclick = () => {
        const printWindow = window.open('', '_blank');
        printWindow.document.write('<html><head><title>Pay Sheet for ' + monthName + ' ' + year + '</title>');
        printWindow.document.write('<style>body{font-family:Arial,sans-serif; margin:0;} table{width:100%; border-collapse:collapse;} th,td{border:1px solid #000; padding:4px; text-align:left; font-size:10px;} div { overflow: visible !important; } @page{size:A4 landscape; margin:0.5cm;} @media print { .hide-on-print { display: none !important; } }</style>');
        printWindow.document.write('</head><body>');
        printWindow.document.write(contentDiv.innerHTML);
        printWindow.document.write('</body></html>');
        printWindow.document.close();
        printWindow.print();
    };
}

function ensureDeptPaysheetButton() {
    if (document.getElementById("btn-dept-paysheet")) return;
    const actionsContainer = document.getElementById("btn-open-dept-print")?.parentElement;
    if (actionsContainer) {
        const btn = document.createElement("button");
        btn.id = "btn-dept-paysheet";
        btn.className = "btn btn-primary";
        btn.innerHTML = `<i data-lucide="file-text"></i> Department Paysheet`;
        btn.onclick = openDepartmentPaysheetModal;
        actionsContainer.insertBefore(btn, actionsContainer.firstChild);
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
}

// Wrap original renderPayroll to add button after rendering
(function(){
    const originalRender = renderPayroll;
    renderPayroll = function(){
        originalRender();
        ensureDeptPaysheetButton();
    };
})();

// --- Bulk Print Department Payslips Logic ---
function openDeptPrintModal() {
    document.getElementById("modal-print-dept-payslips").style.display = "flex";
    const deptSelect = document.getElementById("print-dept-select");
    const departments = store.getDepartments();
    
    // Default month to current
    const date = new Date();
    const currentMonth = date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, '0');
    document.getElementById("print-dept-month").value = currentMonth;
    
    // Populate departments
    deptSelect.innerHTML = '<option value="All">All Departments</option>';
    departments.forEach(dept => {
        const option = document.createElement("option");
        option.value = dept.name;
        option.textContent = dept.name;
        deptSelect.appendChild(option);
    });
}

document.getElementById("btn-close-dept-print-modal").addEventListener("click", () => {
    document.getElementById("modal-print-dept-payslips").style.display = "none";
});

document.getElementById("btn-cancel-dept-print").addEventListener("click", () => {
    document.getElementById("modal-print-dept-payslips").style.display = "none";
});

document.getElementById("form-print-dept-payslips").addEventListener("submit", (e) => {
    e.preventDefault();
    const month = document.getElementById("print-dept-month").value;
    const deptName = document.getElementById("print-dept-select").value;
    handleBulkPrintPayslips(month, deptName);
});

function generatePayslipBoxHTML(run, departmentName, monthStr) {
    let earningsRowsHTML = "";
    run.allowancesData.forEach(allow => {
        if (allow.value > 0) {
            earningsRowsHTML += `<div class="payslip-row"><div>${allow.name}</div><div>LKR ${allow.value.toFixed(2)}</div></div>`;
        }
    });

    let deductionsRowsHTML = "";
    run.allowancesData.forEach(allow => {
        if (allow.deduction > 0) {
            deductionsRowsHTML += `<div class="payslip-row"><div>${allow.name} (Penalty)</div><div>LKR ${allow.deduction.toFixed(2)}</div></div>`;
        }
    });

    return `
        <div class="payslip-box a4-slip" style="border: none;">
            <div style="text-align: center; padding-bottom: 4px; margin-bottom: 4px;">
                <h3 style="font-weight: 700; font-size: 14px; margin: 0; text-transform: uppercase;">${departmentName} - Payslip for ${monthStr}</h3>
                <div style="font-size: 11px; font-weight: 600; margin-top: 2px;">EPF NO: ${run.epfNo || 'N/A'}</div>
                <div style="font-size: 12px; font-weight: 700; margin-top: 2px; text-transform: uppercase;">EMPLOYEE NAME: ${run.name}</div>
            </div>
            
            <div class="payslip-meta-grid" style="border-bottom: 1px solid var(--border-color); padding-bottom: 4px; margin-bottom: 4px;">
                <div class="payslip-meta-col">
                    <div><span>Basic Salary:</span> LKR ${run.basicSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                    <div><span>Days Worked:</span> ${run.daysWorked}</div>
                    ${run.leaveTaken > 0 ? `<div><span>Leave Taken:</span> ${run.leaveTaken}</div>` : ''}
                    ${run.noPayDays > 0 ? `<div><span>No Pay Days:</span> ${run.noPayDays}</div>` : ''}
                    ${run.normalOtHours > 0 ? `<div><span>Normal OT Hours:</span> ${run.normalOtHours.toFixed(2)} hrs</div>` : ''}
                    ${run.specialOtHours > 0 ? `<div><span>Special OT Hours:</span> ${run.specialOtHours.toFixed(2)} hrs</div>` : ''}
                    ${run.extraWorkingDays > 0 ? `<div><span>Extra Working Days:</span> ${run.extraWorkingDays}</div>` : ''}
                </div>
                <div class="payslip-meta-col" style="text-align: right">
                    ${run.otRate > 0 ? `<div><span>OT Rate:</span> LKR ${run.otRate.toFixed(2)}</div>` : ''}
                    ${run.specialOtRateVal > 0 ? `<div><span>Special OT Rate:</span> LKR ${run.specialOtRateVal.toFixed(2)}</div>` : ''}
                    ${run.salaryArrears > 0 ? `<div><span>Salary Arrears:</span> LKR ${run.salaryArrears.toFixed(2)}</div>` : ''}
                    ${run.salesIncentive > 0 ? `<div><span>Sales Incentive:</span> LKR ${run.salesIncentive.toFixed(2)}</div>` : ''}
                    ${run.nitSalesIncentive > 0 ? `<div><span>NIT. Sales Incentive:</span> LKR ${run.nitSalesIncentive.toFixed(2)}</div>` : ''}
                    ${run.vgdSalesIncentive > 0 ? `<div><span>VGD. Sales Incentive:</span> LKR ${run.vgdSalesIncentive.toFixed(2)}</div>` : ''}
                    <div><span>Total Earnings:</span> LKR ${run.totalEarnings.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                    ${run.noPayDeductions > 0 ? `<div><span>No Pay Deductions:</span> LKR ${run.noPayDeductions.toFixed(2)}</div>` : ''}
                    <div style="font-weight: 700;"><span>Total for E.P.F:</span> LKR ${run.totalForEpf.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
                </div>
            </div>
            
            <div class="payslip-table-grid" style="margin-bottom: 4px;">
                <div>
                    <div class="payslip-sec-title">Earnings & Incentives</div>
                    <div class="payslip-row"><div>Basic Salary</div><div>LKR ${run.basicSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
                    ${run.salaryArrears > 0 ? `<div class="payslip-row"><div>Salary Arrears</div><div>LKR ${run.salaryArrears.toFixed(2)}</div></div>` : ''}
                    ${run.salesIncentive > 0 ? `<div class="payslip-row"><div>Sales Incentive</div><div>LKR ${run.salesIncentive.toFixed(2)}</div></div>` : ''}
                    ${run.nitSalesIncentive > 0 ? `<div class="payslip-row"><div>NIT. Sales Incentive</div><div>LKR ${run.nitSalesIncentive.toFixed(2)}</div></div>` : ''}
                    ${run.vgdSalesIncentive > 0 ? `<div class="payslip-row"><div>VGD. Sales Incentive</div><div>LKR ${run.vgdSalesIncentive.toFixed(2)}</div></div>` : ''}
                    ${earningsRowsHTML}
                    ${run.earlyNightMeal > 0 ? `<div class="payslip-row"><div>Early & Night & Meal</div><div>LKR ${run.earlyNightMeal.toFixed(2)}</div></div>` : ''}
                    ${run.normalOtPay > 0 ? `<div class="payslip-row"><div>Normal OT</div><div>LKR ${run.normalOtPay.toFixed(2)}</div></div>` : ''}
                    ${run.specialOtPay > 0 ? `<div class="payslip-row"><div>Special OT</div><div>LKR ${run.specialOtPay.toFixed(2)}</div></div>` : ''}
                    <div class="payslip-row total-row" style="font-size:13px"><div>Gross Salary</div><div>LKR ${run.grossSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
                </div>
                
                <div>
                    <div class="payslip-sec-title">Less: Deductions</div>
                    ${run.noPayDeductions > 0 ? `<div class="payslip-row"><div>No-Pay Deduction (${run.noPayDays} day${run.noPayDays !== 1 ? 's' : ''})</div><div>LKR ${run.noPayDeductions.toFixed(2)}</div></div>` : ''}
                    ${deductionsRowsHTML}
                    ${run.welfare > 0 ? `<div class="payslip-row"><div>Welfare</div><div>LKR ${run.welfare.toFixed(2)}</div></div>` : ''}
                    ${run.salaryAdvance > 0 ? `<div class="payslip-row"><div>Salary Advance</div><div>LKR ${run.salaryAdvance.toFixed(2)}</div></div>` : ''}
                    ${run.cashLosses > 0 ? `<div class="payslip-row"><div>Cash Losses</div><div>LKR ${run.cashLosses.toFixed(2)}</div></div>` : ''}
                    ${run.festivalAdvance > 0 ? `<div class="payslip-row"><div>Festival Advance</div><div>LKR ${run.festivalAdvance.toFixed(2)}</div></div>` : ''}
                    ${run.loanInstalment > 0 ? `<div class="payslip-row"><div>Loan Instalment</div><div>LKR ${run.loanInstalment.toFixed(2)}</div></div>` : ''}
                    ${run.pvtPhoneUsage > 0 ? `<div class="payslip-row"><div>Pvt Usage of Off. Phone</div><div>LKR ${run.pvtPhoneUsage.toFixed(2)}</div></div>` : ''}
                    ${run.deduRedDots > 0 ? `<div class="payslip-row"><div>Dedu. For Red Dots</div><div>LKR ${run.deduRedDots.toFixed(2)}</div></div>` : ''}
                    ${run.epfEmployeeCont > 0 ? `<div class="payslip-row"><div>E.P.F. Employee Cont (8%)</div><div>LKR ${run.epfEmployeeCont.toFixed(2)}</div></div>` : ''}
                    <div class="payslip-row total-row" style="font-size:13px"><div>Total Deductions</div><div>LKR ${run.totalDeductions.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div></div>
                </div>
            </div>
            
            <div class="payslip-net-box" style="margin-bottom: 2px; padding: 2px 6px !important;">
                <div style="font-size: 9px;">NET SALARY</div>
                <div style="font-size: 11px; font-weight: bold;">LKR ${run.roundedNetSalary.toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2})}</div>
            </div>
            
            <div style="border-top:1px solid #94a3b8; padding-top:2px; font-size:9px; display:grid; grid-template-columns: 1fr 1fr; gap:8px;">
                <div>
                    <div><strong>Employer Contributions:</strong></div>
                    <div>E.P.F. Employer Cont, 12%: LKR ${run.epfEmployerCont.toFixed(2)}</div>
                    <div>E.T.F. Employer Cont, 3%: LKR ${run.etfEmployerCont.toFixed(2)}</div>
                </div>
                <div style="text-align: right">
                    <div><strong>Total EPF (12% + 8%):</strong></div>
                    <div style="font-size:10px; font-weight:700">LKR ${run.totalEpf.toFixed(2)}</div>
                </div>
            </div>
        </div>
    `;
}

function handleBulkPrintPayslips(month, deptName) {
    let runs = [];
    try {
        runs = store.getPayrollRuns(month);
    } catch(e) { runs = []; }

    if (runs.length === 0) {
        alert("No payroll records found for the selected month.");
        return;
    }

    const employees = store.getEmployees();
    
    // Filter runs by department
    let filteredRuns = runs;
    if (deptName !== "All") {
        filteredRuns = runs.filter(run => {
            const emp = employees.find(e => e.id === run.employeeId) || {};
            return emp.department === deptName;
        });
    }

    if (filteredRuns.length === 0) {
        alert("No records found for this department.");
        return;
    }

    const dateObj = new Date(month + "-01");
    const monthStr = dateObj.toLocaleString('default', { month: 'long', year: 'numeric' });

    let pagesHTML = "";
    let slipsInCurrentPage = 0;
    
    pagesHTML += `<div class="payslip-a4-page">`;
    
    filteredRuns.forEach((run, index) => {
        const emp = employees.find(e => e.id === run.employeeId) || {};
        const runDeptName = emp.department || 'N/A';
        
        pagesHTML += generatePayslipBoxHTML(run, runDeptName, monthStr);
        slipsInCurrentPage++;
        
        if (slipsInCurrentPage === 3 && index !== filteredRuns.length - 1) {
            pagesHTML += `</div><div class="payslip-a4-page">`;
            slipsInCurrentPage = 0;
        }
    });
    
    pagesHTML += `</div>`;

    // Create a temporary print container
    const printContainer = document.createElement("div");
    printContainer.id = "bulk-print-container";
    printContainer.className = "print-area";
    printContainer.innerHTML = pagesHTML;
    document.body.appendChild(printContainer);

    // Hide main app
    document.getElementById("protected-app").style.display = "none";
    document.getElementById("modal-print-dept-payslips").style.display = "none";
    document.body.classList.add("bulk-payslip-print-mode");

    // Force A4 Portrait for this print job
    const styleEl = document.createElement("style");
    styleEl.id = "bulk-print-page-style";
    styleEl.innerHTML = "@page { size: A4 portrait !important; margin: 0 !important; }";
    document.head.appendChild(styleEl);

    // Print
    window.print();

    // Cleanup
    document.body.removeChild(printContainer);
    document.head.removeChild(styleEl);
    document.getElementById("protected-app").style.display = "block";
    document.body.classList.remove("bulk-payslip-print-mode");
}














